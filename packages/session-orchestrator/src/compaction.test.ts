import { createConversationStore } from "@dispatch/conversation-store";
import {
  type ChatMessage,
  type ProviderContract,
  type ProviderEvent,
  type ProviderStreamOptions,
  runTurn,
} from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { chooseKeepStart, performCompaction } from "./compaction.js";
import { createSessionOrchestrator } from "./orchestrator.js";

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
