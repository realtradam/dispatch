import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  type CheckOutcome,
  type CheckRunner,
  DiagnosticsCheckQueue,
  type NoticeDelivery,
  type NoticeEnqueueResult,
} from "./check-queue.js";
import type { Diagnostic } from "./diagnostics.js";
import { formatNotice } from "./notices.js";

const CWD = "/proj";

function err(message: string): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    source: "ts",
    message,
  };
}

function warn(message: string): Diagnostic {
  return {
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
    severity: 2,
    source: "ts",
    message,
  };
}

function outcome(issues: readonly Diagnostic[], formatted?: string): CheckOutcome {
  return {
    formatted: formatted ?? issues.map((i) => i.message).join("\n"),
    timedOut: false,
    issues,
  };
}

/** Flush pending microtasks (the queue's run loop is promise-based). */
async function tick(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

interface CheckCall {
  readonly filePath: string;
  readonly text: string | undefined;
  readonly cwd: string;
  readonly resolve: (value: CheckOutcome) => void;
}

function makeRunner(): { check: CheckRunner; calls: CheckCall[] } {
  const calls: CheckCall[] = [];
  const check: CheckRunner = (opts) =>
    new Promise<CheckOutcome>((resolve) => {
      calls.push({ filePath: opts.filePath, text: opts.text, cwd: opts.cwd, resolve });
    });
  return { check, calls };
}

interface FakeDelivery {
  readonly delivery: NoticeDelivery;
  readonly enqueued: { conversationId: string; text: string; messageId: string | undefined }[];
  readonly cancelled: { conversationId: string; messageId: string }[];
  /** Mark every queued id as drained (simulate the orchestrator delivering it). */
  drainAll(): void;
  emit(conversationId: string, event: AgentEvent): void;
  setActive(conversationId: string, active: boolean): void;
  setOrchestratorAvailable(available: boolean): void;
  /**
   * Make an idle `enqueue` emit the opening `user-message` synchronously, the
   * way the real orchestrator does (`startTurn` → `runTurnDetached` emits
   * before `enqueue` returns).
   */
  setEmitOnStart(emit: boolean): void;
  /** Make one delivery method throw (injected-failure containment tests). */
  failOn(method: "isActive" | "enqueue" | "cancel" | "subscribe"): void;
}

function makeDelivery(): FakeDelivery {
  const enqueued: FakeDelivery["enqueued"] = [];
  const cancelled: FakeDelivery["cancelled"] = [];
  const active = new Set<string>();
  const queued = new Set<string>();
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  let nextId = 1;
  let orchestratorAvailable = true;
  let emitOnStart = false;
  const failing = new Set<string>();
  const maybeThrow = (method: string): void => {
    if (failing.has(method)) throw new Error(`delivery.${method} exploded`);
  };

  const delivery: NoticeDelivery = {
    isActive: (id) => {
      maybeThrow("isActive");
      return orchestratorAvailable && active.has(id);
    },
    enqueue: ({ conversationId, text }): NoticeEnqueueResult => {
      maybeThrow("enqueue");
      if (!orchestratorAvailable) return { startedTurn: false, messageId: undefined };
      if (!active.has(conversationId)) {
        // Idle → a turn starts and is assumed to settle before any later
        // event; mid-turn behavior is opted into with `setActive`. The real
        // orchestrator emits the opening user-message BEFORE enqueue returns.
        enqueued.push({ conversationId, text, messageId: undefined });
        if (emitOnStart) {
          for (const listener of listeners.get(conversationId) ?? []) {
            listener({
              type: "user-message",
              conversationId,
              turnId: `started-${nextId++}`,
              text,
            });
          }
        }
        return { startedTurn: true, messageId: undefined };
      }
      const messageId = `m${nextId++}`;
      queued.add(messageId);
      enqueued.push({ conversationId, text, messageId });
      return { startedTurn: false, messageId };
    },
    cancel: ({ messageId }) => {
      maybeThrow("cancel");
      cancelled.push({ conversationId: "", messageId });
      return queued.delete(messageId);
    },
    subscribe: (conversationId, listener) => {
      maybeThrow("subscribe");
      if (!orchestratorAvailable) return undefined;
      let set = listeners.get(conversationId);
      if (set === undefined) {
        set = new Set();
        listeners.set(conversationId, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
  };

  return {
    delivery,
    enqueued,
    cancelled,
    drainAll: () => queued.clear(),
    emit: (conversationId, event) => {
      for (const listener of listeners.get(conversationId) ?? []) listener(event);
    },
    setActive: (id, isActive) => {
      if (isActive) active.add(id);
      else active.delete(id);
    },
    setOrchestratorAvailable: (available) => {
      orchestratorAvailable = available;
    },
    setEmitOnStart: (emit) => {
      emitOnStart = emit;
    },
    failOn: (method) => {
      failing.add(method);
    },
  };
}

function makeQueue(options?: { maxAutoTurns?: number; maxFiles?: number; check?: CheckRunner }): {
  queue: DiagnosticsCheckQueue;
  runner: ReturnType<typeof makeRunner>;
  fake: FakeDelivery;
} {
  const runner = makeRunner();
  const fake = makeDelivery();
  const queue = new DiagnosticsCheckQueue({
    check: options?.check ?? runner.check,
    delivery: fake.delivery,
    logger: {
      warn: () => {
        // Errors are reported here; a throwing logger is covered separately.
      },
    },
    ...(options?.maxAutoTurns !== undefined ? { maxAutoTurns: options.maxAutoTurns } : {}),
    ...(options?.maxFiles !== undefined ? { maxFilesPerConversation: options.maxFiles } : {}),
  });
  return { queue, runner, fake };
}

const FILE = "/proj/src/a.ts";

describe("DiagnosticsCheckQueue — coalescing", () => {
  it("3 rapid edits: only the last content is checked and announced", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v3", cwd: CWD });

    // Only the first check started; it carries v1.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.text).toBe("v1");

    // v1's result is superseded: discarded, and the queue re-runs with v3.
    runner.calls[0]?.resolve(outcome([err("error in v1")]));
    await tick();
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.text).toBe("v3");
    expect(fake.enqueued).toHaveLength(0);

    runner.calls[1]?.resolve(outcome([err("error in v3")]));
    await tick();

    expect(fake.enqueued).toHaveLength(1);
    expect(fake.enqueued[0]?.text).toBe(
      formatNotice([{ filePath: FILE, newErrors: 1, newWarnings: 0 }], CWD),
    );
    // The notice names WHERE and HOW MANY, never the message text.
    expect(fake.enqueued[0]?.text).not.toContain("error in v3");
  });
});

describe("DiagnosticsCheckQueue — notices", () => {
  it("delivers once, mid-turn, with the formatted notice (path + counts only)", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("boom"), err("boom2"), warn("meh")]));
    await tick();

    expect(fake.enqueued).toHaveLength(1);
    const text = fake.enqueued[0]?.text ?? "";
    expect(text).toContain("[LSP] New issues detected:");
    expect(text).toContain("- src/a.ts: 2 new errors, 1 new warning");
    expect(text).toContain('operation "diagnostics"');
    expect(text).not.toContain("boom");
  });

  it("replaces a queued notice when newer issues land", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();
    expect(fake.enqueued).toHaveLength(1);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    runner.calls[1]?.resolve(outcome([err("e1"), err("e2")]));
    await tick();

    // The old queued message is cancelled, one replacement is enqueued.
    expect(fake.cancelled.map((c) => c.messageId)).toEqual(["m1"]);
    expect(fake.enqueued).toHaveLength(2);
    expect(fake.enqueued[1]?.text).toContain("- src/a.ts: 2 new errors");
  });

  it("cancels the pending notice when a newer clean result lands", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();
    expect(fake.enqueued).toHaveLength(1);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    runner.calls[1]?.resolve(outcome([]));
    await tick();

    expect(fake.cancelled.map((c) => c.messageId)).toEqual(["m1"]);
    expect(fake.enqueued).toHaveLength(1); // nothing new enqueued
  });

  it("does not re-announce an issue the agent was already told about", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("unfixed")]));
    await tick();
    const notice = fake.enqueued[0]?.text ?? "";

    // Simulate the orchestrator draining the notice into the turn.
    fake.emit("c1", {
      type: "steering",
      conversationId: "c1",
      turnId: "t1",
      text: notice,
    });

    // Edit again without fixing: same issue → nothing new → no notice.
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    runner.calls[1]?.resolve(outcome([err("unfixed")]));
    await tick();

    expect(fake.enqueued).toHaveLength(1);
    expect(fake.cancelled).toHaveLength(0);
  });

  it("re-announces after an issue disappears and comes back", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("flaky")]));
    await tick();
    fake.emit("c1", {
      type: "steering",
      conversationId: "c1",
      turnId: "t1",
      text: fake.enqueued[0]?.text ?? "",
    });

    // Fixed.
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    runner.calls[1]?.resolve(outcome([]));
    await tick();
    expect(fake.enqueued).toHaveLength(1);

    // Back again → new.
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v3", cwd: CWD });
    runner.calls[2]?.resolve(outcome([err("flaky")]));
    await tick();
    expect(fake.enqueued).toHaveLength(2);
  });

  it("commits the baseline when a queued notice was already drained (cancel says no)", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();

    // The queue drained it (delivered) without our subscription observing it.
    fake.drainAll();

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    runner.calls[1]?.resolve(outcome([err("e1")]));
    await tick();

    // Cancel reported "not queued" → treated as delivered → same issue is not new.
    expect(fake.cancelled.map((c) => c.messageId)).toEqual(["m1"]);
    expect(fake.enqueued).toHaveLength(1);
  });
});

describe("DiagnosticsCheckQueue — safety guards", () => {
  it("respects Stop: no auto-start after the user aborted the turn", async () => {
    const { queue, runner, fake } = makeQueue();
    // Conversation idle (no active turn).
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });

    fake.emit("c1", { type: "done", conversationId: "c1", turnId: "t1", reason: "aborted" });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();

    expect(fake.enqueued).toHaveLength(0);
  });

  it("a user message re-arms auto-start after a Stop", async () => {
    const { queue, runner, fake } = makeQueue();
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v0", cwd: CWD });
    fake.emit("c1", { type: "done", conversationId: "c1", turnId: "t1", reason: "aborted" });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();
    expect(fake.enqueued).toHaveLength(0);

    fake.emit("c1", {
      type: "user-message",
      conversationId: "c1",
      turnId: "t2",
      text: "please fix it",
    });

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[1]?.resolve(outcome([err("e1")]));
    await tick();
    expect(fake.enqueued).toHaveLength(1);
  });

  it("caps consecutive LSP-initiated turns; mid-turn notices still flow", async () => {
    const { queue, runner, fake } = makeQueue({ maxAutoTurns: 2 });

    // Three distinct issues → three auto-start attempts.
    for (let i = 0; i < 3; i++) {
      queue.queueCheck({ conversationId: "c1", filePath: FILE, text: `v${i}`, cwd: CWD });
      runner.calls[i]?.resolve(outcome([err(`e${i}`)]));
      await tick();
    }
    expect(fake.enqueued).toHaveLength(2);

    // The cap only blocks auto-STARTING; a mid-turn notice still delivers.
    fake.setActive("c1", true);
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v3", cwd: CWD });
    runner.calls[3]?.resolve(outcome([err("e3")]));
    await tick();
    expect(fake.enqueued).toHaveLength(3);
  });

  it("never delivers into a closed conversation and drops its state", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    queue.purgeConversation("c1");
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();

    expect(fake.enqueued).toHaveLength(0);
    expect(await queue.listResults("c1")).toEqual([]);
  });

  it("cancels a queued notice when the turn is stopped", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();
    expect(fake.enqueued).toHaveLength(1);

    fake.emit("c1", { type: "done", conversationId: "c1", turnId: "t1", reason: "aborted" });

    // The queued steering message is removed so post-seal carry can't start a
    // turn with it either.
    expect(fake.cancelled.map((c) => c.messageId)).toEqual(["m1"]);
  });

  it("stores nothing and throws nothing when no orchestrator is available", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setOrchestratorAvailable(false);

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    expect(() => runner.calls[0]?.resolve(outcome([err("e1")]))).not.toThrow();
    await tick();

    expect(fake.enqueued).toHaveLength(0);
    // The check result is still cached for the report tool.
    expect(queue.getFreshResult({ conversationId: "c1", filePath: FILE })?.formatted).toContain(
      "e1",
    );
  });
});

describe("DiagnosticsCheckQueue — report tool support", () => {
  it("serves a fresh cached result and refuses a stale one after a newer edit", async () => {
    const { queue, runner } = makeQueue();
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("e1")], "ERROR L1:1: e1"));
    await tick();

    const fresh = queue.getFreshResult({ conversationId: "c1", filePath: FILE });
    expect(fresh?.formatted).toBe("ERROR L1:1: e1");
    expect(fresh?.timedOut).toBe(false);

    // A newer edit invalidates it (the check is still in flight).
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    expect(queue.getFreshResult({ conversationId: "c1", filePath: FILE })).toBeUndefined();
  });

  it("waits for an in-flight check and returns its result", async () => {
    const { queue, runner } = makeQueue();
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });

    const report = queue.waitForResult({
      conversationId: "c1",
      filePath: FILE,
      cwd: CWD,
    });
    await tick();
    // Still waiting on the in-flight check — no second aggregation call.
    expect(runner.calls).toHaveLength(1);

    runner.calls[0]?.resolve(outcome([err("e1")], "ERROR e1"));
    const result = await report;
    expect(result.formatted).toBe("ERROR e1");
  });

  it("runs a read-only check (no notice) when nothing is cached", async () => {
    const { queue, runner, fake } = makeQueue();
    fake.setActive("c1", true);

    const report = queue.waitForResult({ conversationId: "c1", filePath: FILE, cwd: CWD });
    await tick();
    expect(runner.calls).toHaveLength(1);
    runner.calls[0]?.resolve(outcome([err("e1")], "ERROR e1"));

    const result = await report;
    expect(result.formatted).toBe("ERROR e1");
    // Reading the report does not announce anything.
    expect(fake.enqueued).toHaveLength(0);
  });

  it("lists every tracked file with issues, excluding clean files", async () => {
    const { queue, runner } = makeQueue();
    queue.queueCheck({ conversationId: "c1", filePath: "/proj/a.ts", text: "a", cwd: CWD });
    queue.queueCheck({ conversationId: "c1", filePath: "/proj/b.ts", text: "b", cwd: CWD });
    queue.queueCheck({ conversationId: "c1", filePath: "/proj/clean.ts", text: "c", cwd: CWD });

    runner.calls[0]?.resolve(outcome([err("ea")], "ERROR a"));
    runner.calls[1]?.resolve(outcome([])); // b is clean
    runner.calls[2]?.resolve(outcome([warn("wc")], "WARNING clean"));
    await tick();

    const reports = await queue.listResults("c1");
    expect(reports.map((r) => r.filePath).sort()).toEqual(["/proj/a.ts", "/proj/clean.ts"]);
  });
});

describe("DiagnosticsCheckQueue — bounds", () => {
  it("evicts the least-recently-used tracked file past the cap", async () => {
    const { queue, runner } = makeQueue({ maxFiles: 2 });
    queue.queueCheck({ conversationId: "c1", filePath: "/proj/a.ts", text: "a", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("a")], "ERROR a"));
    await tick();
    queue.queueCheck({ conversationId: "c1", filePath: "/proj/b.ts", text: "b", cwd: CWD });
    runner.calls[1]?.resolve(outcome([err("b")], "ERROR b"));
    await tick();
    queue.queueCheck({ conversationId: "c1", filePath: "/proj/c.ts", text: "c", cwd: CWD });
    runner.calls[2]?.resolve(outcome([err("c")], "ERROR c"));
    await tick();

    const reports = await queue.listResults("c1");
    expect(reports.map((r) => r.filePath)).toEqual(["/proj/b.ts", "/proj/c.ts"]);
  });
});

describe("DiagnosticsCheckQueue — post-seal carry (orchestrator tryCarryQueue)", () => {
  /** Queue a notice mid-turn and return its text. */
  async function midTurnNotice(
    harness: ReturnType<typeof makeQueue>,
    callIndex: number,
    message: string,
  ): Promise<string> {
    const { queue, runner, fake } = harness;
    fake.setActive("c1", true);
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: `v-${message}`, cwd: CWD });
    runner.calls[callIndex]?.resolve(outcome([err(message)]));
    await tick();
    const text = fake.enqueued[fake.enqueued.length - 1]?.text ?? "";
    fake.setActive("c1", false);
    return text;
  }

  it("counts a carried LSP-only turn against the auto-turn cap", async () => {
    const harness = makeQueue({ maxAutoTurns: 2 });

    for (let i = 0; i < 2; i++) {
      const notice = await midTurnNotice(harness, i, `e${i}`);
      // The turn ends without another tool call → the orchestrator carries the
      // queued notice into a NEW turn whose opening user-message is the notice.
      harness.fake.emit("c1", {
        type: "done",
        conversationId: "c1",
        turnId: `t${i}`,
        reason: "stop",
      });
      harness.fake.emit("c1", {
        type: "user-message",
        conversationId: "c1",
        turnId: `carry-${i}`,
        text: notice,
      });
    }

    // Two carried turns reached the cap; a third (idle, auto-start) is dropped.
    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: FILE,
      text: "v-third",
      cwd: CWD,
    });
    harness.runner.calls[2]?.resolve(outcome([err("e-third")]));
    await tick();

    expect(harness.fake.enqueued).toHaveLength(2);
  });

  it("a carried turn that also contains user steering is a real user message (resets the cap)", async () => {
    const harness = makeQueue({ maxAutoTurns: 2 });

    // One LSP-only carry → autoTurns 1.
    const notice = await midTurnNotice(harness, 0, "e0");
    harness.fake.emit("c1", {
      type: "user-message",
      conversationId: "c1",
      turnId: "carry-0",
      text: notice,
    });

    // Next notice queued mid-turn; the carry combines our notice with user text.
    const notice2 = await midTurnNotice(harness, 1, "e1");
    harness.fake.emit("c1", {
      type: "user-message",
      conversationId: "c1",
      turnId: "carry-1",
      text: `please also look at the tests\n\n${notice2}`,
    });

    // If the combined carry reset the guards, an idle notice can auto-start.
    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: FILE,
      text: "v2",
      cwd: CWD,
    });
    harness.runner.calls[2]?.resolve(outcome([err("e2")]));
    await tick();

    expect(harness.fake.enqueued).toHaveLength(3);
  });

  it("a non-aborted done at the cap cancels the queued notice (no carry can start)", async () => {
    const harness = makeQueue({ maxAutoTurns: 1 });

    // Reach the cap with one LSP-only carry.
    const first = await midTurnNotice(harness, 0, "e0");
    harness.fake.emit("c1", {
      type: "user-message",
      conversationId: "c1",
      turnId: "carry-0",
      text: first,
    });
    expect(harness.fake.enqueued).toHaveLength(1);

    // A new notice is queued mid-turn while already at the cap.
    await midTurnNotice(harness, 1, "e1");
    expect(harness.fake.enqueued).toHaveLength(2);
    const queuedId = harness.fake.enqueued[1]?.messageId;

    // `done` (before seal/carry) must remove it, otherwise tryCarryQueue would
    // start a turn the cap was meant to prevent.
    harness.fake.emit("c1", {
      type: "done",
      conversationId: "c1",
      turnId: "t1",
      reason: "stop",
    });

    expect(queuedId).toBeDefined();
    expect(harness.fake.cancelled.map((c) => c.messageId)).toContain(queuedId);
  });

  it("an auto-start is counted once even though the orchestrator emits its opening user-message", async () => {
    const harness = makeQueue({ maxAutoTurns: 2 });
    harness.fake.setEmitOnStart(true);

    for (let i = 0; i < 3; i++) {
      harness.queue.queueCheck({
        conversationId: "c1",
        filePath: FILE,
        text: `v${i}`,
        cwd: CWD,
      });
      harness.runner.calls[i]?.resolve(outcome([err(`e${i}`)]));
      await tick();
    }

    // Two auto-starts allowed, the third dropped — not one (double-count bug).
    expect(harness.fake.enqueued).toHaveLength(2);
  });
});

/**
 * FAILURE CONTAINMENT — the queue runs from background promise chains and from
 * an orchestrator event listener that does NOT catch. Nothing may escape.
 */
describe("DiagnosticsCheckQueue — failure containment", () => {
  it("contains a throwing check runner and does not hot-retry", async () => {
    let calls = 0;
    const { queue, fake } = makeQueue({
      check: async () => {
        calls += 1;
        throw new Error("check exploded");
      },
    });

    expect(() =>
      queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD }),
    ).not.toThrow();
    await tick();
    await tick();

    expect(calls).toBe(1); // marked processed → no infinite retry loop
    expect(fake.enqueued).toHaveLength(0);

    // The queue still works afterwards.
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v2", cwd: CWD });
    await tick();
    expect(calls).toBe(2);
  });

  it("contains a throwing logger", async () => {
    const fake = makeDelivery();
    const queue = new DiagnosticsCheckQueue({
      check: async () => {
        throw new Error("check exploded");
      },
      delivery: fake.delivery,
      logger: {
        warn: () => {
          throw new Error("logger exploded");
        },
      },
    });

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    await tick();
    expect(fake.enqueued).toHaveLength(0);
  });

  for (const method of ["isActive", "enqueue", "cancel", "subscribe"] as const) {
    it(`contains a throwing delivery.${method}`, async () => {
      const { queue, runner, fake } = makeQueue();
      fake.failOn(method);
      fake.setActive("c1", true);

      expect(() =>
        queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD }),
      ).not.toThrow();
      await tick();

      // Resolving the check must not reject/throw through the run loop.
      expect(() => runner.calls[0]?.resolve(outcome([err("boom")]))).not.toThrow();
      await tick();

      // The result is still cached for the report tool.
      expect(queue.getFreshResult({ conversationId: "c1", filePath: FILE })?.formatted).toContain(
        "boom",
      );
    });
  }

  it("contains a throwing cancel while handling a done event (orchestrator listener)", async () => {
    const { queue, runner, fake } = makeQueue({ maxAutoTurns: 1 });
    fake.setActive("c1", true);
    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    runner.calls[0]?.resolve(outcome([err("e1")]));
    await tick();
    expect(fake.enqueued).toHaveLength(1);

    fake.failOn("cancel");
    // `done` runs inside the orchestrator's emit, which does not catch.
    expect(() =>
      fake.emit("c1", { type: "done", conversationId: "c1", turnId: "t1", reason: "aborted" }),
    ).not.toThrow();
  });

  it("contains a throwing unsubscribe on conversation close and dispose", async () => {
    let unsubscribes = 0;
    const fake = makeDelivery();
    const queue = new DiagnosticsCheckQueue({
      check: async () => ({ formatted: "", timedOut: false, issues: [] }),
      delivery: {
        ...fake.delivery,
        subscribe: () => () => {
          unsubscribes += 1;
          throw new Error("unsubscribe exploded");
        },
      },
    });

    queue.queueCheck({ conversationId: "c1", filePath: FILE, text: "v1", cwd: CWD });
    await tick();
    expect(() => queue.purgeConversation("c1")).not.toThrow();
    expect(() => queue.dispose()).not.toThrow();
    expect(unsubscribes).toBe(1);
  });
});
