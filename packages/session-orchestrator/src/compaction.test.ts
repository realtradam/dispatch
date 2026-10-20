import { createConversationStore } from "@dispatch/conversation-store";
import {
  type ChatMessage,
  type ProviderContract,
  type ProviderEvent,
  type ProviderStreamOptions,
  runTurn,
} from "@dispatch/kernel";
import { createMessageQueueService } from "@dispatch/message-queue";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { chooseKeepStart, createCompactionService, performCompaction } from "./compaction.js";
import { createSessionOrchestrator } from "./orchestrator.js";
import type { ToolAssembly } from "./tools-filter.js";

const text = (role: ChatMessage["role"], value = "text"): ChatMessage => ({
  role,
  chunks: [{ type: "text", text: value }],
});
const calls: ChatMessage = {
  role: "assistant",
  chunks: ["a", "b"].map((toolCallId) => ({
    type: "tool-call",
    toolCallId,
    toolName: "echo",
    input: {},
  })),
};
const result = (toolCallId: string): ChatMessage => ({
  role: "tool",
  chunks: [{ type: "tool-result", toolCallId, toolName: "echo", content: "ok", isError: false }],
});
const image: ChatMessage = {
  role: "user",
  chunks: [
    { type: "text", text: "Tool image" },
    { type: "image", url: "data:image/png;base64,AAAA" },
  ],
};
const old = text("user", "old context");
const done = text("assistant", "done");

describe("chooseKeepStart", () => {
  it.each([
    { name: "ordinary boundary", history: [old, done], keep: 1, expected: 1 },
    { name: "tool boundary", history: [old, calls, result("a"), done], keep: 2, expected: 1 },
    {
      name: "parallel tool results",
      history: [old, calls, result("a"), result("b"), done],
      keep: 2,
      expected: 1,
    },
    {
      name: "image after parallel results",
      history: [old, calls, result("a"), result("b"), image, done],
      keep: 2,
      expected: 1,
    },
    { name: "real user image", history: [old, image, done], keep: 2, expected: 1 },
    {
      name: "all-tool tail",
      history: [old, calls, result("a"), result("b")],
      keep: 1,
      expected: 1,
    },
    {
      name: "whole tool group",
      history: [calls, result("a"), result("b")],
      keep: 1,
      expected: null,
    },
    {
      name: "unowned all-tool history",
      history: [result("a"), result("b")],
      keep: 1,
      expected: null,
    },
    { name: "already too short", history: [old, done], keep: 2, expected: null },
    { name: "empty history", history: [], keep: 1, expected: null },
  ])("$name", ({ history, keep, expected }) => {
    const before = structuredClone(history);
    expect(chooseKeepStart(history, keep)).toBe(expected);
    expect(history).toEqual(before);
  });
});

describe("performCompaction safe boundary", () => {
  it.each([
    "in-flight",
    "post-seal",
  ] as const)("preserves tool groups for %s history", async (path) => {
    const store = createConversationStore(storageFromMap());
    const history = [old, calls, result("a"), result("b"), image, done];
    await store.append("c", history);
    let request: readonly ChatMessage[] = [];
    let options: ProviderStreamOptions | undefined;
    const provider: ProviderContract = {
      id: "summary",
      async *stream(messages, _tools, opts) {
        request = messages;
        options = opts;
        yield { type: "text-delta", delta: "summary" };
      },
    };
    const outcome = await performCompaction(
      { conversationStore: store, resolveProvider: () => provider, emit: () => {} },
      "c",
      { keepLastN: 2, ...(path === "in-flight" ? { messages: history } : {}) },
    );
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.messagesSummarized).toBe(1);
    expect(outcome.messagesKept).toBe(5);
    expect(outcome.compactedMessages[1]?.role).toBe("assistant");
    if (path === "in-flight") expect(outcome.compactedMessages[1]).toBe(calls);
    expect(outcome.compactedMessages.slice(1)).toEqual(history.slice(1));
    expect(await store.load("c")).toEqual(outcome.compactedMessages);
    expect(await store.load(outcome.newConversationId)).toEqual(history);
    expect(await store.getHistoryEpoch("c")).toBe(1);
    expect(request[0]?.chunks[0]).toEqual({
      type: "text",
      text: "Please summarize the following conversation:\n\nuser: old context",
    });
    expect(options?.systemPrompt).toContain("conversation concisely but comprehensively");
  });

  it("continues an in-flight turn with an assistant call group, never an orphan tool tail", async () => {
    const store = createConversationStore(storageFromMap());
    await store.append("c", [
      ...Array.from({ length: 7 }, () => old),
      calls,
      result("a"),
      result("b"),
      ...Array.from({ length: 5 }, () => done),
    ]);
    const captured: ChatMessage[][] = [];
    const script: ProviderEvent[][] = [
      [
        { type: "tool-call", toolCallId: "live", toolName: "echo", input: {} },
        { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", delta: "summary" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", delta: "continued" },
        { type: "finish", reason: "stop" },
      ],
    ];
    const provider: ProviderContract = {
      id: "scripted",
      async *stream(messages) {
        const events = script[captured.length] ?? [];
        captured.push([...messages]);
        yield* events;
      },
    };
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [
        {
          name: "echo",
          description: "echo",
          parameters: { type: "object" },
          execute: async () => ({ content: "ok" }),
        },
      ],
      applyToolsFilter: async (assembly) => assembly,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
    });
    await orchestrator.handleMessage({
      conversationId: "c",
      text: "continue",
      modelName: "test/model",
      onEvent: () => {},
    });
    expect(captured).toHaveLength(3);
    const continued = captured[2] ?? [];
    expect(continued[0]?.role).toBe("system");
    expect(continued[1]).toEqual(calls);
    expect(continued.slice(2, 4)).toEqual([result("a"), result("b")]);
    expect((await store.load("c")).slice(0, continued.length)).toEqual(continued);
    expect(await store.getHistoryEpoch("c")).toBe(1);
  });

  it("does no provider or storage work when the safe boundary keeps everything", async () => {
    const data = new Map<string, string>();
    const store = createConversationStore(storageFromMap(data));
    const history = [calls, result("a"), result("b")];
    await store.append("c", history);
    const before = new Map(data);
    const outcome = await performCompaction(
      {
        conversationStore: store,
        resolveProvider: () => {
          throw new Error("must not summarize");
        },
        emit: () => {
          throw new Error("must not emit");
        },
      },
      "c",
      { keepLastN: 1, messages: history },
    );
    expect(outcome).toEqual({ error: "conversation too short to compact" });
    expect(await store.load("c")).toEqual(history);
    expect(await store.getHistoryEpoch("c")).toBe(0);
    expect(data).toEqual(before);
  });
});

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function compactionFixture(withQueue = false, fail = false) {
  const store = createConversationStore(storageFromMap());
  const entered = gate();
  const release = gate();
  const settled = gate();
  let turns = 0;
  const provider: ProviderContract = {
    id: "gated",
    async *stream(_messages, _tools, opts) {
      if (opts?.maxTokens === 2000) {
        entered.resolve();
        await release.promise;
        if (fail) throw new Error("summary failed");
        yield { type: "text-delta", delta: "summary" };
      } else {
        turns++;
        yield { type: "text-delta", delta: "new answer" };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  let id = 0;
  const queue = withQueue
    ? createMessageQueueService({
        id: () => String(++id),
        now: () => 0,
        notify: () => {},
      })
    : undefined;
  const deps = {
    conversationStore: store,
    resolveProvider: () => provider,
    resolveTools: () => [],
    applyToolsFilter: async (assembly: ToolAssembly) => assembly,
    resolveQueue: () => queue,
    resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
    runTurn,
    emit: () => {},
  };
  const bundle = createSessionOrchestrator(deps);
  bundle.orchestrator.subscribe("c", (event) => {
    if (event.type === "turn-sealed") settled.resolve();
  });
  const service = createCompactionService(deps, bundle.activeConversations, bundle.compacting);
  return { store, entered, release, settled, queue, service, ...bundle, turns: () => turns };
}

describe("manual/post-seal compaction exclusion", () => {
  it.each([
    { withQueue: false, auto: false },
    { withQueue: true, auto: false },
    { withQueue: true, auto: true },
  ])("keeps mid-summary messages ($withQueue queue, $auto auto)", async ({ withQueue, auto }) => {
    const f = compactionFixture(withQueue);
    await f.store.append("c", [old, done, text("user", "keep")]);
    await f.store.appendMetrics("c", {
      turnId: "previous",
      usage: { inputTokens: 900, outputTokens: 0 },
      steps: [],
      contextSize: 900,
    });
    const compact = f.service.compact("c", { keepLastN: 1, auto, modelName: "test/model" });
    expect(f.compacting.has("c")).toBe(true);
    await f.entered.promise;
    const started = f.orchestrator.startTurn({ conversationId: "c", text: "new question" });
    expect(started.started).toBe(!withQueue);
    if (withQueue) {
      const queued = f.orchestrator.enqueue({ conversationId: "c", text: "follow-up" });
      expect(queued.startedTurn).toBe(false);
      expect(queued.queue.map((message) => message.text)).toEqual(["new question", "follow-up"]);
    } else {
      expect(f.orchestrator.isActive("c")).toBe(true);
      expect(f.orchestrator.startTurn({ conversationId: "c", text: "duplicate" }).started).toBe(
        false,
      );
    }
    await Promise.resolve();
    expect(f.turns()).toBe(0);
    expect(await f.store.load("c")).toEqual([old, done, text("user", "keep")]);
    // Unrelated conversations must not wait on this compaction.
    await f.orchestrator.handleMessage({
      conversationId: "other",
      text: "independent",
      onEvent: () => {},
    });
    expect(f.turns()).toBe(1);
    f.release.resolve();
    const outcome = await compact;
    if ("error" in outcome) throw new Error(outcome.error);
    await f.settled.promise;
    const history = await f.store.load("c");
    expect(history).toEqual([
      expect.objectContaining({ role: "system" }),
      text("user", "keep"),
      text("user", withQueue ? "new question\n\nfollow-up" : "new question"),
      text("assistant", "new answer"),
    ]);
    expect(await f.store.load(outcome.newConversationId)).toEqual([
      old,
      done,
      text("user", "keep"),
    ]);
    expect(f.compacting.size).toBe(0);
    expect(f.queue?.getQueue("c") ?? []).toEqual([]);
  });

  it.each([
    false,
    true,
  ])("handleMessage waits for its deferred turn (queue=%s)", async (withQueue) => {
    const f = compactionFixture(withQueue);
    await f.store.append("c", [old, done]);
    const compact = f.service.compact("c", { keepLastN: 1 });
    await f.entered.promise;
    const events: string[] = [];
    const message = f.orchestrator.handleMessage({
      conversationId: "c",
      text: "waited",
      onEvent: (event) => events.push(event.type),
    });
    expect(events).not.toContain("error");
    expect(f.turns()).toBe(0);
    f.release.resolve();
    await compact;
    await message;
    expect(events).toContain("turn-sealed");
    expect(events).not.toContain("error");
    expect((await f.store.load("c")).slice(-2)).toEqual([
      text("user", "waited"),
      text("assistant", "new answer"),
    ]);
  });

  it.each([
    "append",
    "active",
    "locked-append",
  ])("rejects a changed snapshot: %s", async (change) => {
    const f = compactionFixture();
    await f.store.append("c", [old, done]);
    const compact = f.service.compact("c", { keepLastN: 1 });
    await f.entered.promise;
    const before = await f.store.listConversations();
    const appended = text("user", "external turn message");
    // The externally held source lock forces the final recheck to wait.
    const locked = gate();
    const unlock = gate();
    const writer =
      change === "locked-append"
        ? f.store.runExclusive("c", async () => {
            locked.resolve();
            await unlock.promise;
            await f.store.append("c", [appended]);
          })
        : undefined;
    if (writer !== undefined) await locked.promise;
    if (change === "append") {
      // A separate caller sharing the store does not share this bundle's guard.
      const { orchestrator } = createSessionOrchestrator({
        conversationStore: f.store,
        resolveProvider: () => ({
          id: "external",
          async *stream() {
            yield { type: "finish", reason: "stop" };
          },
        }),
        resolveTools: () => [],
        applyToolsFilter: async (assembly) => assembly,
        runTurn,
      });
      await orchestrator.handleMessage({
        conversationId: "c",
        text: "external turn message",
        onEvent: () => {},
      });
    }
    // Mutable active set injected through the bundle's readonly public surface.
    if (change === "active") (f.activeConversations as Set<string>).add("c");
    f.release.resolve();
    unlock.resolve();
    await writer;
    expect(await compact).toEqual({ error: "conversation changed during compaction" });
    expect(await f.store.load("c")).toEqual(
      change === "active" ? [old, done] : [old, done, appended],
    );
    expect(await f.store.getHistoryEpoch("c")).toBe(0);
    expect((await f.store.listConversations()).map((meta) => meta.id)).toEqual(
      before.map((meta) => meta.id),
    );
    expect(f.compacting.size).toBe(0);
  });

  it.each([false, true])("cleans up early auto/manual exits (auto=%s)", async (auto) => {
    const f = compactionFixture();
    expect("error" in (await f.service.compact("c", { auto }))).toBe(true);
    expect(f.compacting.size).toBe(0);
    expect(f.orchestrator.enqueue({ conversationId: "c", text: "not blocked" }).startedTurn).toBe(
      true,
    );
    await f.settled.promise;
  });

  it.each([false, true])("releases turns after summary rejection (queue=%s)", async (withQueue) => {
    const f = compactionFixture(withQueue, true);
    await f.store.append("c", [old, done]);
    const compact = f.service.compact("c", { keepLastN: 1 });
    const rejection = expect(compact).rejects.toThrow("summary failed");
    await f.entered.promise;
    expect(await f.service.compact("c")).toEqual({ error: "conversation is compacting" });
    f.orchestrator.enqueue({ conversationId: "c", text: "survives failure" });
    f.release.resolve();
    await rejection;
    await f.settled.promise;
    expect(await f.store.load("c")).toEqual([
      old,
      done,
      text("user", "survives failure"),
      text("assistant", "new answer"),
    ]);
    expect(f.compacting.size).toBe(0);
  });
});
