/** Synthetic evidence, not proof about the production multi-hour RSS slope. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "../packages/conversation-store/dist/index.js";
import { createLocalExecBackend } from "../packages/exec-backend/dist/index.js";
import { type AgentEvent, type ProviderContract, runTurn } from "../packages/kernel/dist/index.js";
import { createLogger } from "../packages/kernel/dist/logging/index.js";
import { abortableIteration } from "../packages/kernel/dist/runtime/abortable-iteration.js";
import {
  createConcurrencyManager,
  wrapProviderWithConcurrency,
} from "../packages/provider-concurrency/dist/index.js";
import { createSessionOrchestrator } from "../packages/session-orchestrator/dist/index.js";
import { createSqliteStorage } from "../packages/storage-sqlite/dist/index.js";
import { createRunShellTool } from "../packages/tool-shell/dist/shell.js";

const root = await mkdtemp(join(tmpdir(), "review-7.8-soak-"));
const backend = createSqliteStorage({ path: ":memory:" });
const store = createConversationStore(backend.storage("conversation-store"));
const logger = createLogger(
  { extensionId: "review-7.8" },
  { recordsBodies: false, emit() {} },
  { now: Date.now, newId: () => crypto.randomUUID() },
);
const limiter = createConcurrencyManager({
  now: Date.now,
  slotTimeoutMs: 300000,
  watchdogIntervalMs: 60000,
  defaultPauseMs: 1000,
});
limiter.setLimit("fixture", 1);
let release = () => {};
let reached = () => {};
const checkpoint = new Promise<void>((resolve) => {
  reached = resolve;
});
const resume = new Promise<void>((resolve) => {
  release = resolve;
});
const samples: object[] = [];
const started = performance.now();
function sample(stage: string) {
  const memory = process.memoryUsage();
  samples.push({ stage, ms: performance.now() - started, ...memory });
}
let completedReplayOutputCount = -1;
let completedReplayResultCount = -1;
let steps = 0;
const provider: ProviderContract = {
  id: "fixture",
  async *stream() {
    if (steps++ === 0) {
      for (let i = 0; i < 1000000; i++) {
        yield { type: "text-delta", delta: "x" };
        if (i % 10000 === 0) {
          sample(`delta-${i}`);
          await Bun.sleep(0);
        }
      }
      reached();
      await resume;
      yield {
        type: "tool-call",
        toolCallId: "volume",
        toolName: "run_shell",
        input: {
          command: `echo $$ > '${root}/shell.pid'; yes | head -c 200000000`,
          timeout: 30000,
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      const completedReplay = replay();
      completedReplayOutputCount = completedReplay.filter((e) => e.type === "tool-output").length;
      completedReplayResultCount = completedReplay.filter((e) => e.type === "tool-result").length;
      yield { type: "text-delta", delta: "finished" };
      yield { type: "finish", reason: "stop" };
    }
  },
};
const shell = createRunShellTool({ workdir: root, resolveBackend: () => createLocalExecBackend() });
const { orchestrator } = createSessionOrchestrator({
  conversationStore: store,
  resolveProvider: () => provider,
  resolveTools: () => [shell],
  runTurn,
  applyToolsFilter: async (a) => a,
  resolveConcurrencyLimiter: () => limiter,
  logger,
});
const replay = () => {
  const events: AgentEvent[] = [];
  const off = orchestrator.subscribe("soak", (e) => events.push(e));
  off();
  return events;
};
let liveOutputBytes = 0;
let peakReplayOutputBytes = 0;
let resultLength = 0;
let shellLimitError = false;
let resultNote = "";
const timer = setInterval(() => sample("timer"), 20);
// Hard wall-clock bound even if a regression wedges the provider/tool settlement.
const watchdog = setTimeout(() => {
  orchestrator.stopAll();
  try {
    const pid = Number(readFileSync(join(root, "shell.pid"), "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(-pid, "SIGKILL");
  } catch {
    /* Already exited, or shell never started. */
  }
  console.error("Step 7.8 synthetic soak exceeded its 90-second wall-clock bound");
  process.exit(1);
}, 90000);

try {
  sample("baseline");
  const turn = orchestrator.handleMessage({
    conversationId: "soak",
    text: "synthetic",
    onEvent(event) {
      if (event.type === "tool-output") {
        liveOutputBytes += Buffer.byteLength(event.data);
        const bytes = replay()
          .filter((e) => e.type === "tool-output")
          .reduce((sum, e) => sum + Buffer.byteLength(e.data), 0);
        peakReplayOutputBytes = Math.max(peakReplayOutputBytes, bytes);
        assert(bytes <= 65536);
      }
      if (event.type === "tool-result") {
        resultNote = event.content.slice(-300);
        resultLength = event.content.length;
        shellLimitError =
          event.isError === true &&
          event.content.toLowerCase().includes("output exceeded 50 MB".toLowerCase());
      }
    },
  });
  await checkpoint;
  const tokenReplay = replay();
  const textEvents = tokenReplay.filter((e) => e.type === "text-delta");
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0]?.delta.length, 1000000);
  const tokenReplayEvents = tokenReplay.length;
  sample("million-deltas");
  release();
  await turn;
  sample("sealed");
  assert.equal(completedReplayOutputCount, 0);
  assert.equal(completedReplayResultCount, 1);
  assert(resultLength <= 50200);
  assert(shellLimitError, `hard output cap, not timeout: ${resultNote}`);
  assert(liveOutputBytes <= 1000200);
  assert(peakReplayOutputBytes <= 65536);
  assert.equal(orchestrator.getActiveConversationCount(), 0);
  assert.equal(replay().filter((e) => e.type === "tool-output").length, 0);
  const shellPid = Number((await readFile(join(root, "shell.pid"), "utf8")).trim());
  let shellAlive = true;
  for (let spin = 0; spin < 100 && shellAlive; spin++) {
    try {
      process.kill(shellPid, 0);
      await Bun.sleep(10);
    } catch {
      shellAlive = false;
    }
  }
  assert.equal(shellAlive, false, "shell must exit within one second after limit return");
  const processRows = await new Response(
    Bun.spawn(["ps", "-eo", "pid,pgid,stat"], { stdout: "pipe" }).stdout,
  ).text();
  const runningShellGroup = processRows.split("\n").filter((line) => {
    const [, group, state] = line.trim().split(/\s+/);
    return Number(group) === shellPid && !state?.startsWith("Z");
  });
  assert.deepEqual(runningShellGroup, []);
  let finalized = 0;
  const abortStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const control = new AbortController();
    const raw: ProviderContract = {
      id: "fixture",
      async *stream() {
        try {
          yield { type: "text-delta", delta: "x" };
          yield { type: "finish", reason: "stop" };
        } finally {
          finalized++;
        }
      },
    };
    const wrapped = wrapProviderWithConcurrency(raw, limiter, `abort-${i}`, "default", Date.now());
    const iterator = abortableIteration(
      wrapped.stream([], [], { signal: control.signal })[Symbol.asyncIterator](),
      control.signal,
    );
    await iterator.next();
    assert.equal(limiter.getStatus("fixture")?.inFlight, 1);
    control.abort();
    assert.equal((await iterator.next()).done, true);
    for (let spin = 0; spin < 20 && limiter.getStatus("fixture")?.inFlight; spin++)
      await Promise.resolve();
    assert.equal(limiter.getStatus("fixture")?.inFlight, 0);
    assert.equal(limiter.getStatus("fixture")?.queued, 0);
    if (i % 100 === 0) sample(`abort-${i}`);
  }
  assert.equal(finalized, 1000);
  const abortMs = performance.now() - abortStart;
  await store.deleteConversation("soak");
  Bun.gc(true);
  sample("gc-after-delete");
  await Bun.sleep(60000);
  Bun.gc(true);
  sample("idle-60s-gc");
  console.log(
    JSON.stringify(
      {
        root,
        durationMs: performance.now() - started,
        deltas: 1000000,
        tokenReplayEvents,
        liveOutputBytes,
        peakReplayOutputBytes,
        resultLength,
        completedReplayOutputCount,
        completedReplayResultCount,
        shellLimitError,
        shellPid,
        shellAlive,
        runningShellGroup,
        abortCycles: finalized,
        abortMs,
        status: limiter.getStatus("fixture"),
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  release();
  orchestrator.stopAll();
  clearTimeout(watchdog);
  clearInterval(timer);
  limiter.destroy();
  backend.close();
}
