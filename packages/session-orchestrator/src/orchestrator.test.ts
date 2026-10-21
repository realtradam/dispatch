import { resolve as pathResolve } from "node:path";
import { type ConversationStore, createConversationStore } from "@dispatch/conversation-store";
import type {
  AgentEvent,
  ChatMessage,
  ConversationToolPolicy,
  EventHookDescriptor,
  LogDeps,
  Logger,
  LogRecord,
  LogSink,
  ProviderContract,
  ProviderEvent,
  ProviderStreamOptions,
  ReasoningEffort,
  RunTurnInput,
  RunTurnResult,
  StoredChunk,
  ToolContract,
  TurnMetrics,
} from "@dispatch/kernel";
import { createLogger, runTurn } from "@dispatch/kernel";
import { createMessageQueueService } from "@dispatch/message-queue";
import { createSystemPromptService, type SystemPromptService } from "@dispatch/system-prompt";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import {
  type ConversationCompactedPayload,
  type ConversationOpenedPayload,
  type ConversationStatusChangedPayload,
  conversationCompacted,
  createCompactionService,
  createSessionOrchestrator,
  createWarmService,
  type TurnLifecyclePayload,
  type VisionHandoffService,
  type WarmCompletedPayload,
} from "./orchestrator.js";
import type { MemorySample } from "./pure.js";
import { compactReplay, defaultDispatchPolicy } from "./pure.js";
import type { ToolAssembly } from "./tools-filter.js";

function createInMemoryStore(): ConversationStore & {
  readonly data: Map<string, ChatMessage[]>;
  readonly metricsData: Map<string, TurnMetrics[]>;
  readonly cwdData: Map<string, string>;
  readonly computerData: Map<string, string>;
  readonly effortData: Map<string, ReasoningEffort>;
  readonly modelData: Map<string, string>;
  readonly workspaceIdData: Map<string, string>;
  readonly parentData: Map<string, string>;
  readonly toolPolicyData: Map<string, ConversationToolPolicy>;
} {
  const data = new Map<string, ChatMessage[]>();
  const metricsData = new Map<string, TurnMetrics[]>();
  const cwdData = new Map<string, string>();
  const computerData = new Map<string, string>();
  const effortData = new Map<string, ReasoningEffort>();
  const modelData = new Map<string, string>();
  const workspaceIdData = new Map<string, string>();
  const compactPercentData = new Map<string, number>();
  const parentData = new Map<string, string>();
  const toolPolicyData = new Map<string, ConversationToolPolicy>();
  // Track conversations that have a meta row. In the real store, append,
  // setWorkspaceId, setConversationStatus, setConversationTitle, and
  // setCompactedFrom all create a minimal meta row on first contact.
  // getConversationMeta returns non-null for known conversations so the
  // orchestrator's newness detection (meta === null) matches reality.
  const knownConversations = new Set<string>();
  return {
    async getHistoryEpoch() {
      return 0;
    },
    async runExclusive(_conversationId, fn) {
      return await fn();
    },
    data,
    metricsData,
    cwdData,
    computerData,
    effortData,
    modelData,
    workspaceIdData,
    parentData,
    toolPolicyData,
    async append(conversationId, messages) {
      knownConversations.add(conversationId);
      const existing = data.get(conversationId) ?? [];
      data.set(conversationId, [...existing, ...messages]);
    },
    async load(conversationId) {
      return [...(data.get(conversationId) ?? [])];
    },
    async loadSince(conversationId, sinceSeq) {
      const messages = data.get(conversationId) ?? [];
      const result: StoredChunk[] = [];
      let seq = 1;
      for (const msg of messages) {
        for (const chunk of msg.chunks) {
          if (sinceSeq === undefined || seq > sinceSeq) {
            result.push({ seq, role: msg.role, chunk });
          }
          seq++;
        }
      }
      return result;
    },
    async appendMetrics(conversationId, metrics) {
      const existing = metricsData.get(conversationId) ?? [];
      metricsData.set(conversationId, [...existing, metrics]);
    },
    async loadMetrics(conversationId) {
      return [...(metricsData.get(conversationId) ?? [])];
    },
    async getCwd(conversationId) {
      return cwdData.get(conversationId) ?? null;
    },
    async setCwd(conversationId, cwd) {
      cwdData.set(conversationId, cwd);
    },
    async clearCwd(conversationId) {
      cwdData.delete(conversationId);
    },
    async getComputerId(conversationId) {
      return computerData.get(conversationId) ?? null;
    },
    async setComputerId(conversationId, alias) {
      if (alias === null) {
        computerData.delete(conversationId);
      } else {
        computerData.set(conversationId, alias);
      }
    },
    async clearComputerId(conversationId) {
      computerData.delete(conversationId);
    },
    async getReasoningEffort(conversationId) {
      return effortData.get(conversationId) ?? null;
    },
    async setReasoningEffort(conversationId, effort) {
      effortData.set(conversationId, effort);
    },
    async getModel(conversationId) {
      return modelData.get(conversationId) ?? null;
    },
    async setModel(conversationId, model) {
      // Mirror the real store contract: an empty string clears the key.
      if (model === "") {
        modelData.delete(conversationId);
      } else {
        modelData.set(conversationId, model);
      }
    },
    async getParentConversationId(conversationId) {
      return parentData.get(conversationId) ?? null;
    },
    async setParentConversationId(conversationId, parentId) {
      parentData.set(conversationId, parentId);
    },
    async getToolPolicy(conversationId) {
      return toolPolicyData.get(conversationId) ?? null;
    },
    async setToolPolicy(conversationId, policy) {
      toolPolicyData.set(conversationId, policy);
    },
    async listChildren() {
      return [];
    },
    async listConversations() {
      return [];
    },
    async getConversationMeta(conversationId) {
      if (!knownConversations.has(conversationId)) return null;
      return {
        id: conversationId,
        createdAt: 0,
        lastActivityAt: 0,
        title: "Untitled",
        status: "idle",
        workspaceId: workspaceIdData.get(conversationId) ?? "default",
      };
    },
    async setConversationTitle(conversationId) {
      knownConversations.add(conversationId);
    },
    async getConversationStatus() {
      return null;
    },
    async setConversationStatus(conversationId) {
      knownConversations.add(conversationId);
    },
    async replaceHistory(conversationId, messages) {
      knownConversations.add(conversationId);
      data.set(conversationId, [...messages]);
    },
    async getCompactPercent(conversationId) {
      return compactPercentData.get(conversationId) ?? null;
    },
    async setCompactPercent(conversationId, percent) {
      compactPercentData.set(conversationId, percent);
    },
    async forkHistory(_sourceId, targetId) {
      knownConversations.add(targetId);
    },
    async setCompactedFrom(conversationId) {
      knownConversations.add(conversationId);
    },
    async getWorkspace() {
      return null;
    },
    async ensureWorkspace(id) {
      return {
        id,
        title: id,
        defaultCwd: null,
        defaultComputerId: null,
        createdAt: 0,
        lastActivityAt: 0,
      };
    },
    async setWorkspaceTitle(id, title) {
      return {
        id,
        title,
        defaultCwd: null,
        defaultComputerId: null,
        createdAt: 0,
        lastActivityAt: 0,
      };
    },
    async setWorkspaceDefaultCwd(id, defaultCwd) {
      return {
        id,
        title: id,
        defaultCwd,
        defaultComputerId: null,
        createdAt: 0,
        lastActivityAt: 0,
      };
    },
    async setWorkspaceDefaultComputerId(id, defaultComputerId) {
      return {
        id,
        title: id,
        defaultCwd: null,
        defaultComputerId,
        createdAt: 0,
        lastActivityAt: 0,
      };
    },
    async deleteWorkspace() {
      return { closedCount: 0 };
    },
    async listWorkspaces() {
      return [];
    },
    async getWorkspaceId(conversationId) {
      return workspaceIdData.get(conversationId) ?? "default";
    },
    async setWorkspaceId(conversationId, workspaceId) {
      workspaceIdData.set(conversationId, workspaceId);
      knownConversations.add(conversationId);
    },
    async getEffectiveCwd(conversationId, overrideCwd) {
      return overrideCwd ?? cwdData.get(conversationId) ?? null;
    },
    async getEffectiveComputer(conversationId, overrideAlias) {
      return overrideAlias ?? computerData.get(conversationId) ?? null;
    },
    async getImageTranscriptions() {
      return new Map();
    },
    async setImageTranscription() {},
    async getVisionSettings() {
      return { imageLimit: 10, compactionModel: null };
    },
    async setVisionImageLimit() {},
    async setVisionCompactionModel() {},
  };
}

function createFakeProvider(script: ProviderEvent[][]): ProviderContract {
  let callIndex = 0;
  return {
    id: "fake",
    stream(_messages, _tools) {
      const events = script[callIndex] ?? [];
      callIndex++;
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    },
  };
}

function collectEvents(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function createFakeTool(
  name: string,
  handler: (input: unknown) => Promise<{ content: string }>,
): ToolContract {
  return {
    name,
    description: `Fake tool: ${name}`,
    parameters: { type: "object" },
    execute: async (input) => handler(input),
  };
}

function identityApplyToolsFilter(assembly: ToolAssembly): Promise<ToolAssembly> {
  return Promise.resolve(assembly);
}

describe("handleMessage integration", () => {
  it("loads history, runs turn, emits events, and persists result", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "text-delta", delta: " there" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const { events, onEvent } = collectEvents();

    await orchestrator.handleMessage({
      conversationId: "conv-1",
      text: "Hi",
      onEvent,
    });

    expect(events.length).toBeGreaterThan(0);
    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);

    const stored = store.data.get("conv-1");
    expect(stored).toBeDefined();
    expect(stored).toHaveLength(2);
    expect(stored?.[0]?.role).toBe("user");
    expect(stored?.[1]?.role).toBe("assistant");

    const userChunks = stored?.[0]?.chunks ?? [];
    expect(userChunks[0]).toEqual({ type: "text", text: "Hi" });

    const assistantChunks = stored?.[1]?.chunks ?? [];
    expect(assistantChunks.some((c) => c.type === "text")).toBe(true);
  });

  it("multi-turn: second call sees first turn in history", async () => {
    const store = createInMemoryStore();
    let capturedMessages: ChatMessage[] | undefined;

    let callCount = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream(messages, _tools) {
        if (callCount === 1) {
          capturedMessages = [...messages];
        }
        callCount++;
        return (async function* () {
          yield { type: "text-delta", delta: `Reply ${callCount}` } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-multi",
      text: "First message",
      onEvent: () => {},
    });

    await orchestrator.handleMessage({
      conversationId: "conv-multi",
      text: "Second message",
      onEvent: () => {},
    });

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages?.length).toBeGreaterThanOrEqual(3);

    expect(capturedMessages?.[0]?.role).toBe("user");
    const firstUserText = capturedMessages?.[0]?.chunks[0];
    expect(firstUserText).toEqual({ type: "text", text: "First message" });

    expect(capturedMessages?.[1]?.role).toBe("assistant");

    const lastUser = capturedMessages?.findLast((m) => m.role === "user");
    expect(lastUser).toBeDefined();
    const lastUserText = lastUser?.chunks[0];
    expect(lastUserText).toEqual({ type: "text", text: "Second message" });
  });

  it("hands the default dispatch policy to runTurn when resolveDispatch is absent", async () => {
    const store = createInMemoryStore();
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "fake", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-dispatch-default",
      text: "test",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.dispatch).toEqual(defaultDispatchPolicy());
  });

  it("hands the resolved override to runTurn when resolveDispatch is provided", async () => {
    const store = createInMemoryStore();
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "fake", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveDispatch: () => ({ maxConcurrent: 4, eager: false }),
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-dispatch",
      text: "test",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.dispatch).toEqual({ maxConcurrent: 4, eager: false });
  });
});

function createCapturingRunTurn(): {
  result: RunTurnResult;
  captured: RunTurnInput[];
  captureRunTurn: (input: RunTurnInput) => Promise<RunTurnResult>;
} {
  const result: RunTurnResult = {
    messages: [{ role: "assistant", chunks: [{ type: "text", text: "ok" }] }],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
  };
  const captured: RunTurnInput[] = [];
  return {
    result,
    captured,
    captureRunTurn: async (input) => {
      captured.push(input);
      return result;
    },
  };
}

describe("handleMessage model resolution", () => {
  it("modelName resolves → runTurn receives resolved provider, providerOpts.model, and cwd", async () => {
    const store = createInMemoryStore();
    const resolvedProvider: ProviderContract = { id: "resolved", stream: async function* () {} };
    const fallbackProvider: ProviderContract = { id: "fallback", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => fallbackProvider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: (name) => {
        if (name === "cred/gpt-4") return { provider: resolvedProvider, model: "gpt-4" };
        return undefined;
      },
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-model",
      text: "hi",
      onEvent: () => {},
      modelName: "cred/gpt-4",
      cwd: "/work/dir",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe(resolvedProvider);
    expect(captured[0]?.providerOpts).toEqual({ reasoningEffort: "high", model: "gpt-4" });
    expect(captured[0]?.cwd).toBe("/work/dir");
  });

  it("modelName given but resolveModel returns undefined → error event emitted, runTurn NOT called", async () => {
    const store = createInMemoryStore();
    const fallbackProvider: ProviderContract = { id: "fallback", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();
    const events: AgentEvent[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => fallbackProvider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => undefined,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-unknown",
      text: "hi",
      onEvent: (e) => events.push(e),
      modelName: "cred/nonexistent",
    });

    expect(captured).toHaveLength(0);
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as AgentEvent & { type: "error" }).message).toBe(
      "unknown model: cred/nonexistent",
    );
    expect((errorEvents[0] as AgentEvent & { type: "error" }).conversationId).toBe("conv-unknown");
    expect((errorEvents[0] as AgentEvent & { type: "error" }).turnId).toMatch(/^turn-/);
  });

  it("no modelName → falls back to resolveProvider(), no model override", async () => {
    const store = createInMemoryStore();
    const fallbackProvider: ProviderContract = { id: "fallback", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => fallbackProvider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({
        provider: { id: "should-not-use", stream: async function* () {} },
        model: "x",
      }),
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-fallback",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe(fallbackProvider);
    expect(captured[0]?.providerOpts).toEqual({ reasoningEffort: "high" });
  });

  it("cwd is forwarded to RunTurnInput.cwd and absent when not provided", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-cwd",
      text: "hi",
      onEvent: () => {},
      cwd: "/custom/path",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/custom/path");

    await orchestrator.handleMessage({
      conversationId: "conv-no-cwd",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(2);
    expect(captured[1]?.cwd).toBeUndefined();
  });

  it("computerId is forwarded to RunTurnInput.computerId and absent when not provided", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-computer",
      text: "hi",
      onEvent: () => {},
      computerId: "my-ssh-host",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.computerId).toBe("my-ssh-host");

    await orchestrator.handleMessage({
      conversationId: "conv-no-computer",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(2);
    expect(captured[1]?.computerId).toBeUndefined();
  });

  it("computerId override persists via setComputerId (mirrors setCwd-on-override)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-persist-computer",
      text: "hi",
      onEvent: () => {},
      computerId: "persisted-host",
    });

    expect(store.computerData.get("conv-persist-computer")).toBe("persisted-host");
  });

  it("computerId not provided → setComputerId NOT called (no override persisted)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-no-persist",
      text: "hi",
      onEvent: () => {},
    });

    expect(store.computerData.get("conv-no-persist")).toBeUndefined();
  });

  it("computerId threads into ToolAssembly passed to applyToolsFilter", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const capturedAssemblies: ToolAssembly[] = [];
    const recordingApplyToolsFilter = (assembly: ToolAssembly): Promise<ToolAssembly> => {
      capturedAssemblies.push(assembly);
      return Promise.resolve(assembly);
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: recordingApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-assembly",
      text: "hi",
      onEvent: () => {},
      computerId: "remote-host",
    });

    expect(capturedAssemblies).toHaveLength(1);
    expect(capturedAssemblies[0]?.computerId).toBe("remote-host");
  });

  it("forwards an injected now into the RunTurnInput passed to runTurn", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();
    const fakeNow = () => 42;

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      now: fakeNow,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-now",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.now).toBe(fakeNow);
    expect(captured[0]?.now?.()).toBe(42);
  });

  it("omits now from RunTurnInput when deps.now is not provided", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-no-now",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.now).toBeUndefined();
  });
});

describe("turn-sealed event", () => {
  it("emits turn-sealed after persisting the turn", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const { events, onEvent } = collectEvents();

    await orchestrator.handleMessage({
      conversationId: "conv-seal",
      text: "test",
      onEvent,
    });

    const sealedEvents = events.filter((e) => e.type === "turn-sealed");
    expect(sealedEvents).toHaveLength(1);
    const sealed = sealedEvents[0] as AgentEvent & { type: "turn-sealed" };
    expect(sealed.conversationId).toBe("conv-seal");
    expect(sealed.turnId).toMatch(/^turn-/);
  });

  it("turn-sealed is emitted after the store append", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const ordering: string[] = [];
    const wrappedStore: ConversationStore = {
      ...store,
      async append(conversationId, messages) {
        await store.append(conversationId, messages);
        ordering.push("append");
      },
      async appendMetrics(conversationId, metrics) {
        await store.appendMetrics(conversationId, metrics);
        ordering.push("appendMetrics");
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: wrappedStore,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-order",
      text: "test",
      onEvent: (event) => {
        if (event.type === "turn-sealed") {
          ordering.push("turn-sealed");
        }
      },
    });

    expect(ordering).toEqual(["append", "append", "appendMetrics", "turn-sealed"]);
  });

  it("stamps every persisted chunk of a turn with that turn's id", async () => {
    const store = createInMemoryStore();
    const turnIds: (string | undefined)[] = [];
    const wrappedStore: ConversationStore = {
      ...store,
      async append(conversationId, messages, opts) {
        for (const m of messages) for (const _ of m.chunks) turnIds.push(opts?.turnId);
        await store.append(conversationId, messages, opts);
      },
    };
    const provider = createFakeProvider([
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", delta: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: wrappedStore,
      resolveProvider: () => provider,
      resolveTools: () => [createFakeTool("echo")],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    const { events, onEvent } = collectEvents();
    await orchestrator.handleMessage({ conversationId: "conv-tid", text: "go", onEvent });
    const turnId = events.find((e) => e.type === "turn-start")?.turnId;
    expect(turnId).toBeDefined();
    // user msg + tool-call + tool-result + final text
    expect(turnIds.length).toBeGreaterThanOrEqual(4);
    expect(turnIds.every((t) => t === turnId)).toBe(true);
  });

  it("persists the metrics a turn accumulated even when the turn throws", async () => {
    const store = createInMemoryStore();
    let appends = 0;
    const wrappedStore: ConversationStore = {
      ...store,
      async append(conversationId, messages, opts) {
        appends++;
        // user message persists; the first step's persistence fails
        if (appends === 2) throw new Error("storage failure");
        await store.append(conversationId, messages, opts);
      },
    };
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: wrappedStore,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    const { events, onEvent } = collectEvents();
    await orchestrator.handleMessage({ conversationId: "conv-err-m", text: "go", onEvent });
    expect(events.some((e) => e.type === "error")).toBe(true);
    const turnId = events.find((e) => e.type === "turn-start")?.turnId;
    const metrics = await store.loadMetrics("conv-err-m");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.turnId).toBe(turnId);
    expect(metrics[0]?.steps[0]?.usage.outputTokens).toBe(2);
  });

  it("does not emit turn-sealed when append throws — emits error event instead", async () => {
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const failingStore: ConversationStore = {
      async append() {
        throw new Error("storage failure");
      },
      async load() {
        return [];
      },
      async loadSince() {
        return [];
      },
      async appendMetrics() {
        return undefined;
      },
      async loadMetrics() {
        return [];
      },
      async getCwd() {
        return null;
      },
      async setCwd() {},
      async clearCwd() {},
      async getComputerId() {
        return null;
      },
      async setComputerId() {},
      async clearComputerId() {},
      async getReasoningEffort() {
        return null;
      },
      async setReasoningEffort() {},
      async getModel() {
        return null;
      },
      async setModel() {},
      async getParentConversationId() {
        return null;
      },
      async setParentConversationId() {},
      async getToolPolicy() {
        return null;
      },
      async setToolPolicy() {},
      async listChildren() {
        return [];
      },
      async listConversations() {
        return [];
      },
      async getConversationMeta() {
        return null;
      },
      async setConversationTitle() {},
      async getConversationStatus() {
        return null;
      },
      async setConversationStatus() {},
      async replaceHistory() {},
      async getCompactPercent() {
        return null;
      },
      async setCompactPercent() {},
      async forkHistory() {},
      async setCompactedFrom() {},
      async getWorkspace() {
        return null;
      },
      async ensureWorkspace(id) {
        return {
          id,
          title: id,
          defaultCwd: null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceTitle(id, title) {
        return {
          id,
          title,
          defaultCwd: null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceDefaultCwd(id, defaultCwd) {
        return {
          id,
          title: id,
          defaultCwd,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceDefaultComputerId(id, defaultComputerId) {
        return {
          id,
          title: id,
          defaultCwd: null,
          defaultComputerId,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async deleteWorkspace() {
        return { closedCount: 0 };
      },
      async listWorkspaces() {
        return [];
      },
      async getWorkspaceId() {
        return "default";
      },
      async setWorkspaceId() {},
      async getEffectiveCwd() {
        return null;
      },
      async getEffectiveComputer() {
        return null;
      },
      async getImageTranscriptions() {
        return new Map();
      },
      async setImageTranscription() {},
      async getVisionSettings() {
        return { imageLimit: 10, compactionModel: null };
      },
      async setVisionImageLimit() {},
      async setVisionCompactionModel() {},
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: failingStore,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const { events, onEvent } = collectEvents();

    await orchestrator.handleMessage({
      conversationId: "conv-fail",
      text: "test",
      onEvent,
    });

    const sealedEvents = events.filter((e) => e.type === "turn-sealed");
    expect(sealedEvents).toHaveLength(0);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as AgentEvent & { type: "error" }).message).toBe("storage failure");
  });
});

describe("turn metrics persistence", () => {
  it("persists a TurnMetrics after a single-step turn seals", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      now: () => 1000,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-metrics-1",
      text: "test",
      onEvent: () => {},
    });

    const metrics = store.metricsData.get("conv-metrics-1");
    expect(metrics).toBeDefined();
    expect(metrics).toHaveLength(1);
    expect(metrics?.[0]?.turnId).toMatch(/^turn-/);
    expect(metrics?.[0]?.usage.inputTokens).toBe(10);
    expect(metrics?.[0]?.usage.outputTokens).toBe(5);
    expect(metrics?.[0]?.steps).toHaveLength(1);
    expect(metrics?.[0]?.steps[0]?.usage.inputTokens).toBe(10);
    expect(metrics?.[0]?.steps[0]?.usage.outputTokens).toBe(5);
  });

  it("TurnMetrics aggregates multi-step usage and carries each step's StepMetrics in order", async () => {
    const store = createInMemoryStore();
    const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const idx = callIndex++;
        return (async function* () {
          if (idx === 0) {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: {},
            } as ProviderEvent;
            yield {
              type: "usage",
              usage: { inputTokens: 10, outputTokens: 5 },
            } as ProviderEvent;
            yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
          } else {
            yield { type: "text-delta", delta: "Step2" } as ProviderEvent;
            yield {
              type: "usage",
              usage: { inputTokens: 20, outputTokens: 10 },
            } as ProviderEvent;
            yield { type: "finish", reason: "stop" } as ProviderEvent;
          }
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [tool],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      now: () => 1000,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-metrics-multi",
      text: "test",
      onEvent: () => {},
    });

    const metrics = store.metricsData.get("conv-metrics-multi");
    expect(metrics).toBeDefined();
    expect(metrics).toHaveLength(1);

    const tm = metrics?.[0];
    if (tm === undefined) throw new Error("expected metrics");

    expect(tm.steps.length).toBeGreaterThanOrEqual(2);

    expect(tm.steps[0]?.usage.inputTokens).toBe(10);
    expect(tm.steps[0]?.usage.outputTokens).toBe(5);
    expect(tm.steps[1]?.usage.inputTokens).toBe(20);
    expect(tm.steps[1]?.usage.outputTokens).toBe(10);

    expect(tm.usage.inputTokens).toBe(30);
    expect(tm.usage.outputTokens).toBe(15);
  });

  it("per-step timing and usage are joined by stepId into one StepMetrics", async () => {
    const store = createInMemoryStore();
    const clock = createCounterNow();
    clock.tick(100);

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const idx = callIndex++;
        return (async function* () {
          if (idx === 0) {
            clock.tick(50);
            yield { type: "text-delta", delta: "Hello" } as ProviderEvent;
            clock.tick(100);
            yield {
              type: "usage",
              usage: { inputTokens: 10, outputTokens: 5 },
            } as ProviderEvent;
            clock.tick(50);
            yield { type: "finish", reason: "stop" } as ProviderEvent;
          }
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      now: clock.now,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-metrics-join",
      text: "test",
      onEvent: () => {},
    });

    const metrics = store.metricsData.get("conv-metrics-join");
    expect(metrics).toBeDefined();
    expect(metrics).toHaveLength(1);

    const tm = metrics?.[0];
    if (tm === undefined) throw new Error("expected metrics");

    expect(tm.steps).toHaveLength(1);
    const step = tm.steps[0];
    if (step === undefined) throw new Error("expected step");

    expect(step.usage.inputTokens).toBe(10);
    expect(step.usage.outputTokens).toBe(5);
    expect(step.genTotalMs).toBe(200);
    expect(step.ttftMs).toBe(50);
    expect(step.decodeMs).toBe(150);
  });

  it("turn-level usage comes from the done event aggregate", async () => {
    const store = createInMemoryStore();
    const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const idx = callIndex++;
        return (async function* () {
          if (idx === 0) {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: {},
            } as ProviderEvent;
            yield {
              type: "usage",
              usage: { inputTokens: 10, outputTokens: 5 },
            } as ProviderEvent;
            yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
          } else {
            yield { type: "text-delta", delta: "Step2" } as ProviderEvent;
            yield {
              type: "usage",
              usage: { inputTokens: 20, outputTokens: 10 },
            } as ProviderEvent;
            yield { type: "finish", reason: "stop" } as ProviderEvent;
          }
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [tool],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      now: () => 1000,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-metrics-done",
      text: "test",
      onEvent: () => {},
    });

    const metrics = store.metricsData.get("conv-metrics-done");
    expect(metrics).toBeDefined();
    expect(metrics).toHaveLength(1);

    const tm = metrics?.[0];
    if (tm === undefined) throw new Error("expected metrics");

    expect(tm.usage.inputTokens).toBe(30);
    expect(tm.usage.outputTokens).toBe(15);
  });

  it("persists contextSize as the last step's inputTokens + outputTokens", async () => {
    const store = createInMemoryStore();
    const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const idx = callIndex++;
        return (async function* () {
          if (idx === 0) {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: {},
            } as ProviderEvent;
            yield {
              type: "usage",
              usage: { inputTokens: 10, outputTokens: 5 },
            } as ProviderEvent;
            yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
          } else {
            yield { type: "text-delta", delta: "Step2" } as ProviderEvent;
            yield {
              type: "usage",
              usage: { inputTokens: 20, outputTokens: 10 },
            } as ProviderEvent;
            yield { type: "finish", reason: "stop" } as ProviderEvent;
          }
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [tool],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      now: () => 1000,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-context-size",
      text: "test",
      onEvent: () => {},
    });

    const metrics = store.metricsData.get("conv-context-size");
    expect(metrics).toBeDefined();
    expect(metrics).toHaveLength(1);

    const tm = metrics?.[0];
    if (tm === undefined) throw new Error("expected metrics");

    expect(tm.steps.length).toBeGreaterThanOrEqual(2);
    expect(tm.contextSize).toBe(30);
  });

  it("does not persist metrics nor emit turn-sealed when chunk append fails", async () => {
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    let metricsAppended = false;
    const failingMetricsStore: ConversationStore = {
      async append() {
        throw new Error("storage failure");
      },
      async load() {
        return [];
      },
      async loadSince() {
        return [];
      },
      async appendMetrics() {
        metricsAppended = true;
      },
      async loadMetrics() {
        return [];
      },
      async getCwd() {
        return null;
      },
      async setCwd() {},
      async clearCwd() {},
      async getComputerId() {
        return null;
      },
      async setComputerId() {},
      async clearComputerId() {},
      async getReasoningEffort() {
        return null;
      },
      async setReasoningEffort() {},
      async getModel() {
        return null;
      },
      async setModel() {},
      async getParentConversationId() {
        return null;
      },
      async setParentConversationId() {},
      async getToolPolicy() {
        return null;
      },
      async setToolPolicy() {},
      async listChildren() {
        return [];
      },
      async listConversations() {
        return [];
      },
      async getConversationMeta() {
        return null;
      },
      async setConversationTitle() {},
      async getConversationStatus() {
        return null;
      },
      async setConversationStatus() {},
      async replaceHistory() {},
      async getCompactPercent() {
        return null;
      },
      async setCompactPercent() {},
      async forkHistory() {},
      async setCompactedFrom() {},
      async getWorkspace() {
        return null;
      },
      async ensureWorkspace(id) {
        return {
          id,
          title: id,
          defaultCwd: null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceTitle(id, title) {
        return {
          id,
          title,
          defaultCwd: null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceDefaultCwd(id, defaultCwd) {
        return {
          id,
          title: id,
          defaultCwd,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceDefaultComputerId(id, defaultComputerId) {
        return {
          id,
          title: id,
          defaultCwd: null,
          defaultComputerId,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async deleteWorkspace() {
        return { closedCount: 0 };
      },
      async listWorkspaces() {
        return [];
      },
      async getWorkspaceId() {
        return "default";
      },
      async setWorkspaceId() {},
      async getEffectiveCwd() {
        return null;
      },
      async getEffectiveComputer() {
        return null;
      },
      async getImageTranscriptions() {
        return new Map();
      },
      async setImageTranscription() {},
      async getVisionSettings() {
        return { imageLimit: 10, compactionModel: null };
      },
      async setVisionImageLimit() {},
      async setVisionCompactionModel() {},
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: failingMetricsStore,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const { events, onEvent } = collectEvents();

    await orchestrator.handleMessage({
      conversationId: "conv-fail-metrics",
      text: "test",
      onEvent,
    });

    const sealedEvents = events.filter((e) => e.type === "turn-sealed");
    expect(sealedEvents).toHaveLength(0);
    expect(metricsAppended).toBe(false);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
  });
});

describe("tools filter", () => {
  it("applies the tools filter once and passes the result to runTurn", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const toolA = createFakeTool("tool-a", async () => ({ content: "a" }));
    const toolB = createFakeTool("tool-b", async () => ({ content: "b" }));

    let filterCallCount = 0;
    const transformingFilter = (assembly: ToolAssembly): Promise<ToolAssembly> => {
      filterCallCount++;
      return Promise.resolve({ ...assembly, tools: [toolB] });
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [toolA],
      applyToolsFilter: transformingFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-filter-once",
      text: "hi",
      onEvent: () => {},
    });

    expect(filterCallCount).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tools).toHaveLength(1);
    expect(captured[0]?.tools[0]?.name).toBe("tool-b");
  });

  it("tools filter identity is a no-op (same tools reach runTurn)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const toolA = createFakeTool("tool-a", async () => ({ content: "a" }));
    const toolB = createFakeTool("tool-b", async () => ({ content: "b" }));

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [toolA, toolB],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-filter-identity",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.tools).toHaveLength(2);
    expect(captured[0]?.tools[0]?.name).toBe("tool-a");
    expect(captured[0]?.tools[1]?.name).toBe("tool-b");
  });

  it("threads cwd and conversationId into the tool assembly", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    let receivedAssembly: ToolAssembly | undefined;
    const capturingFilter = (assembly: ToolAssembly): Promise<ToolAssembly> => {
      receivedAssembly = assembly;
      return Promise.resolve(assembly);
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: capturingFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-filter-threads",
      text: "hi",
      onEvent: () => {},
      cwd: "/test/dir",
    });

    expect(receivedAssembly).toBeDefined();
    expect(receivedAssembly?.conversationId).toBe("conv-filter-threads");
    expect(receivedAssembly?.cwd).toBe("/test/dir");
    expect(receivedAssembly?.tools).toEqual([]);
  });
});

// ── Per-workspace tool gate (plan 06 §6.3) ──────────────────────────────────

describe("per-workspace tool gate", () => {
  it("threads the conversation's PERSISTED workspaceId into the tool assembly", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    let receivedAssembly: ToolAssembly | undefined;
    const capturingFilter = (assembly: ToolAssembly): Promise<ToolAssembly> => {
      receivedAssembly = assembly;
      return Promise.resolve(assembly);
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: capturingFilter,
      runTurn: captureRunTurn,
    });

    await store.setWorkspaceId("conv-ws-thread", "team-a");
    await orchestrator.handleMessage({
      conversationId: "conv-ws-thread",
      text: "hi",
      onEvent: () => {},
    });

    expect(receivedAssembly).toBeDefined();
    expect(receivedAssembly?.workspaceId).toBe("team-a");
  });

  it("applies the workspace gate AFTER the whole toolsFilter chain (an injection filter cannot re-add) and BEFORE applyToolPolicy", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const toolA = createFakeTool("read_file", async () => ({ content: "a" }));
    const mcpInjected = createFakeTool("myserver__query", async () => ({ content: "mcp" }));

    // The injection filter ADDS an MCP tool after resolveTools (mirrors mcp).
    const injectingFilter = (assembly: ToolAssembly): Promise<ToolAssembly> =>
      Promise.resolve({ ...assembly, tools: [...assembly.tools, mcpInjected] });

    // The workspace gate: `mcp` is NOT usable in team-a (ledger attribution:
    // `myserver__query` → mcp), so the gate drops it — AFTER the injector ran.
    const { gateToolsForWorkspace } = await import("./tools-filter.js");
    const ownerOfTool = (name: string) =>
      name === "myserver__query" ? "mcp" : name === "read_file" ? "tool-read-file" : undefined;
    const workspaceGate = (assembly: ToolAssembly): Promise<ToolAssembly> =>
      Promise.resolve(gateToolsForWorkspace(assembly, new Set(["tool-read-file"]), ownerOfTool));

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [toolA],
      applyToolsFilter: injectingFilter,
      applyWorkspaceGate: workspaceGate,
      runTurn: captureRunTurn,
    });

    await store.setWorkspaceId("conv-ws-gate", "team-a");
    await orchestrator.handleMessage({
      conversationId: "conv-ws-gate",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    const names = captured[0]?.tools.map((t) => t.name) ?? [];
    // The MCP-injected tool was dropped by the workspace gate even though
    // the injection filter added it AFTER resolveTools — the gate runs last
    // in the chain (§7: nothing can re-add a restricted tool).
    expect(names).toEqual(["read_file"]);
  });

  it("applyToolPolicy is the FINAL word: a mode:none conversation gets an empty set even after the gate", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const toolA = createFakeTool("read_file", async () => ({ content: "a" }));
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [toolA],
      applyToolsFilter: identityApplyToolsFilter,
      applyWorkspaceGate: (assembly) => Promise.resolve(assembly), // passthrough gate
      runTurn: captureRunTurn,
    });

    await store.setToolPolicy("conv-ws-policy", { mode: "none" });
    await orchestrator.handleMessage({
      conversationId: "conv-ws-policy",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.tools).toEqual([]);
  });

  it("omitted applyWorkspaceGate → no workspace gating (degrade open)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const toolA = createFakeTool("read_file", async () => ({ content: "a" }));
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [toolA],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await store.setWorkspaceId("conv-ws-absent", "team-a");
    await orchestrator.handleMessage({
      conversationId: "conv-ws-absent",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.tools.map((t) => t.name)).toEqual(["read_file"]);
  });
});

// ── Model-unavailable rule (plan 06 §6.5, big_plan §8) ──────────────────────

describe("per-workspace model availability", () => {
  it("a KNOWN model that is NOT usable in the conversation's workspace errors immediately — no runTurn, NO fallback", async () => {
    const store = createInMemoryStore();
    const fallbackProvider: ProviderContract = { id: "fallback", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();
    const events: AgentEvent[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => fallbackProvider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({
        provider: { id: "should-never-stream", stream: async function* () {} },
        model: "gpt-4",
      }),
      resolveModelUsability: () => Promise.resolve(false),
      runTurn: captureRunTurn,
    });

    await store.setWorkspaceId("conv-model-unusable", "team-a");
    await orchestrator.handleMessage({
      conversationId: "conv-model-unusable",
      text: "hi",
      onEvent: (e) => events.push(e),
      modelName: "cred/gpt-4",
    });

    expect(captured).toHaveLength(0); // NEVER a silent fallback
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as AgentEvent & { type: "error" }).message).toBe(
      "model cred/gpt-4 unavailable — pick another",
    );
  });

  it("a model usable in the workspace proceeds normally", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({
        provider: { id: "resolved", stream: async function* () {} },
        model: "gpt-4",
      }),
      resolveModelUsability: () => Promise.resolve(true),
      runTurn: captureRunTurn,
    });

    await store.setWorkspaceId("conv-model-ok", "team-a");
    await orchestrator.handleMessage({
      conversationId: "conv-model-ok",
      text: "hi",
      onEvent: () => {},
      modelName: "cred/gpt-4",
    });

    expect(captured).toHaveLength(1);
  });

  it("no resolveModelUsability dep → the unknown-model error path is unchanged", async () => {
    const store = createInMemoryStore();
    const fallbackProvider: ProviderContract = { id: "fallback", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();
    const events: AgentEvent[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => fallbackProvider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => undefined,
      runTurn: captureRunTurn,
    });

    await store.setWorkspaceId("conv-legacy", "team-a");
    await orchestrator.handleMessage({
      conversationId: "conv-legacy",
      text: "hi",
      onEvent: (e) => events.push(e),
      modelName: "cred/nonexistent",
    });

    expect(captured).toHaveLength(0);
    const errorEvents = events.filter((e) => e.type === "error");
    expect((errorEvents[0] as AgentEvent & { type: "error" }).message).toBe(
      "unknown model: cred/nonexistent",
    );
  });
});

function createCounterNow(): { now: () => number; tick: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    tick(ms: number) {
      t += ms;
    },
  };
}

describe("lifecycle event hooks", () => {
  it("emits turnStarted before and turnSettled after a turn", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const emitted: Array<{ hook: string; payload: TurnLifecyclePayload; order: number }> = [];
    let order = 0;

    const fakeEmit = <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload): void => {
      emitted.push({ hook: hook.id, payload: payload as TurnLifecyclePayload, order: order++ });
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: fakeEmit,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-lifecycle",
      text: "test",
      onEvent: () => {},
      cwd: "/work",
      modelName: "mymodel",
    });

    // The status-changed emits resolve the persisted workspace id async
    // (getWorkspaceId) before firing, so they may land after turn-settled
    // in microtask order. Flush all pending microtasks so every emit has
    // landed, then assert by hook identity rather than strict index order.
    await new Promise((resolve) => setImmediate(resolve));

    expect(emitted).toHaveLength(4);

    const started = emitted.find((e) => e.hook === "session-orchestrator/turn-started");
    const settled = emitted.find((e) => e.hook === "session-orchestrator/turn-settled");
    const statusChanges = emitted.filter(
      (e) => e.hook === "session-orchestrator/conversation-status-changed",
    );

    expect(started).toBeDefined();
    expect(started?.payload.conversationId).toBe("conv-lifecycle");
    expect(started?.payload.cwd).toBe("/work");
    expect(started?.payload.modelName).toBe("mymodel");
    // turn-started is the FIRST emit (synchronous, before any async deferral).
    expect(started?.order).toBe(0);

    expect(settled).toBeDefined();
    expect(settled?.payload.conversationId).toBe("conv-lifecycle");
    expect(settled?.payload.cwd).toBe("/work");
    expect(settled?.payload.modelName).toBe("mymodel");
    // turn-started precedes turn-settled.
    expect(started?.order).toBeLessThan(settled?.order ?? Infinity);

    expect(statusChanges).toHaveLength(2);
    const activeChange = statusChanges.find(
      (e) => (e.payload as unknown as { status: string }).status === "active",
    );
    const idleChange = statusChanges.find(
      (e) => (e.payload as unknown as { status: string }).status === "idle",
    );
    expect(activeChange).toBeDefined();
    expect(idleChange).toBeDefined();
    // Both status-changed payloads now carry the persisted workspace id.
    expect((activeChange?.payload as unknown as { workspaceId: string }).workspaceId).toBe(
      "default",
    );
    expect((idleChange?.payload as unknown as { workspaceId: string }).workspaceId).toBe("default");
  });
});

describe("warm service", () => {
  it("warm reuses the assembled tools + full history and appends the probe turn", async () => {
    const store = createInMemoryStore();
    const existingMsg: ChatMessage = {
      role: "user",
      chunks: [{ type: "text", text: "existing" }],
    };
    const assistantMsg: ChatMessage = {
      role: "assistant",
      chunks: [{ type: "text", text: "reply" }],
    };
    await store.append("conv-warm-reuse", [existingMsg, assistantMsg]);

    let capturedMessages: readonly ChatMessage[] | undefined;
    let capturedTools: readonly ToolContract[] | undefined;
    let _capturedOpts: unknown;

    const toolA = createFakeTool("tool-a", async () => ({ content: "a" }));

    const provider: ProviderContract = {
      id: "warm-provider",
      stream(messages, tools, opts) {
        capturedMessages = messages;
        capturedTools = tools;
        _capturedOpts = opts;
        return (async function* () {
          yield {
            type: "usage",
            usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 20 },
          } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [toolA],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    const result = await warmService.warm("conv-warm-reuse", { cwd: "/test" });

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages?.[0]?.chunks[0]).toEqual({ type: "text", text: "existing" });
    expect(capturedMessages?.[1]?.chunks[0]).toEqual({ type: "text", text: "reply" });
    expect(capturedMessages?.[2]?.role).toBe("user");
    expect((capturedMessages?.[2]?.chunks[0] as { type: "text"; text: string }).text).toBe(
      "reply with just a .",
    );

    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]?.name).toBe("tool-a");

    if ("inputTokens" in result) {
      expect(result.inputTokens).toBe(100);
      expect(result.cacheReadTokens).toBe(80);
    }
  });

  it("warm forwards a `warm`-flagged logger so the send is captured as a span", async () => {
    const store = createInMemoryStore();
    await store.append("conv-warm-log", [{ role: "user", chunks: [{ type: "text", text: "hi" }] }]);

    let capturedOpts: ProviderStreamOptions | undefined;
    const provider: ProviderContract = {
      id: "p",
      stream(_messages, _tools, opts) {
        capturedOpts = opts;
        return (async function* () {
          yield {
            type: "usage",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          } as ProviderEvent;
        })();
      },
    };

    // Minimal Logger stub recording the child() correlation it was asked for.
    let childArg: (Partial<{ conversationId: string }> & { attrs?: unknown }) | undefined;
    const warmChild = { __warmChild: true } as unknown as Logger;
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      span() {
        throw new Error("warm should not open spans directly");
      },
      child(ctx: { conversationId?: string; attrs?: unknown }) {
        childArg = ctx;
        return warmChild;
      },
    } as unknown as Logger;

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
      logger,
    };
    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    await warmService.warm("conv-warm-log");

    // The warm send must carry the logger so the provider opens a provider.request span.
    expect(capturedOpts?.logger).toBe(warmChild);
    // …and it must be flagged warm + correlated to the conversation, so it can be
    // diffed against the real turn's request (the 0%-cache debugging workflow).
    expect(childArg).toMatchObject({
      conversationId: "conv-warm-log",
      attrs: { warm: true },
    });
  });

  it("warm falls back to the conversation's stored cwd for tool assembly", async () => {
    // A cwd-sensitive tools filter (e.g. skill discovery) must see the SAME cwd
    // the real turn used, or the tools block diverges and the prompt cache misses.
    // A manual reheat sends no cwd, so the warm must fall back to the stored cwd.
    const store = createInMemoryStore();
    await store.append("conv-warm-cwd", [{ role: "user", chunks: [{ type: "text", text: "hi" }] }]);
    await store.setCwd("conv-warm-cwd", "/home/PII_REDACTED_USER_01/projects/roblox");

    let assemblyCwd: string | undefined = "UNSET";
    const provider: ProviderContract = {
      id: "p",
      stream() {
        return (async function* () {
          yield {
            type: "usage",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          } as ProviderEvent;
        })();
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: (assembly: ToolAssembly) => {
        assemblyCwd = assembly.cwd;
        return Promise.resolve(assembly);
      },
      runTurn,
      emit: () => {},
    };
    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    // No cwd in opts (the reheat case) → must use the stored cwd.
    await warmService.warm("conv-warm-cwd");
    expect(assemblyCwd).toBe("/home/PII_REDACTED_USER_01/projects/roblox");
  });

  it("warm refuses while the conversation is generating", async () => {
    const store = createInMemoryStore();
    let resolveRunTurn: (() => void) | undefined;
    const runTurnBlocker = new Promise<void>((resolve) => {
      resolveRunTurn = resolve;
    });

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield { type: "text-delta", delta: "slow" } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const blockingRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
      await runTurnBlocker;
      return {
        messages: [{ role: "assistant", chunks: [{ type: "text", text: "done" }] }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      };
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: blockingRunTurn,
      emit: () => {},
    };

    const { orchestrator, activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    const turnPromise = orchestrator.handleMessage({
      conversationId: "conv-blocking",
      text: "test",
      onEvent: () => {},
    });

    const warmResult = await warmService.warm("conv-blocking");
    expect(warmResult).toEqual({ error: "conversation is generating" });

    resolveRunTurn?.();
    await turnPromise;
  });

  it("warm never persists (no append) and emits no AgentEvents", async () => {
    const store = createInMemoryStore();
    const existingMsg: ChatMessage = {
      role: "user",
      chunks: [{ type: "text", text: "existing" }],
    };
    await store.append("conv-no-persist", [existingMsg]);

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield {
          type: "usage",
          usage: { inputTokens: 10, outputTokens: 2 },
        } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    const sizeBefore = store.data.get("conv-no-persist")?.length;

    await warmService.warm("conv-no-persist");

    const sizeAfter = store.data.get("conv-no-persist")?.length;
    expect(sizeAfter).toBe(sizeBefore);
  });

  it("warm returns provider usage (input + cacheReadTokens)", async () => {
    const store = createInMemoryStore();
    const existingMsg: ChatMessage = {
      role: "user",
      chunks: [{ type: "text", text: "existing" }],
    };
    await store.append("conv-usage", [existingMsg]);

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield {
          type: "usage",
          usage: {
            inputTokens: 500,
            outputTokens: 3,
            cacheReadTokens: 400,
            cacheWriteTokens: 100,
          },
        } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    const result = await warmService.warm("conv-usage");

    expect(result).toEqual({
      inputTokens: 500,
      outputTokens: 3,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    });
  });

  it("warm emits warmCompleted with the usage on success", async () => {
    const store = createInMemoryStore();
    const existingMsg: ChatMessage = {
      role: "user",
      chunks: [{ type: "text", text: "existing" }],
    };
    await store.append("conv-warm-emit", [existingMsg]);

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield {
          type: "usage",
          usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 150, cacheWriteTokens: 50 },
        } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const emitted: Array<{ hook: string; payload: WarmCompletedPayload }> = [];
    const fakeEmit = <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload): void => {
      emitted.push({ hook: hook.id, payload: payload as WarmCompletedPayload });
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: fakeEmit,
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    const result = await warmService.warm("conv-warm-emit");

    if (!("inputTokens" in result)) throw new Error("expected success");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.hook).toBe("session-orchestrator/warm-completed");
    expect(emitted[0]?.payload.conversationId).toBe("conv-warm-emit");
    expect(emitted[0]?.payload.usage).toEqual(result);
  });

  it("warm does NOT emit warmCompleted when it refuses (conversation generating / no history)", async () => {
    const store = createInMemoryStore();

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield { type: "text-delta", delta: "slow" } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const emitted: Array<{ hook: string }> = [];
    const fakeEmit = <TPayload>(hook: EventHookDescriptor<TPayload>, _payload: TPayload): void => {
      emitted.push({ hook: hook.id });
    };

    const blockingRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return {
        messages: [{ role: "assistant", chunks: [{ type: "text", text: "done" }] }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      };
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: blockingRunTurn,
      emit: fakeEmit,
    };

    const { orchestrator, activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    // Refuse because conversation is generating
    const turnPromise = orchestrator.handleMessage({
      conversationId: "conv-refuse-gen",
      text: "test",
      onEvent: () => {},
    });

    const genResult = await warmService.warm("conv-refuse-gen");
    expect(genResult).toEqual({ error: "conversation is generating" });

    await turnPromise;

    // Refuse because no history
    const noHistResult = await warmService.warm("conv-refuse-empty");
    expect(noHistResult).toEqual({ error: "no history" });

    const warmEmits = emitted.filter((e) => e.hook === "session-orchestrator/warm-completed");
    expect(warmEmits).toHaveLength(0);
  });
});

describe("cwd persistence", () => {
  it("uses the persisted cwd when the request omits cwd", async () => {
    const store = createInMemoryStore();
    await store.setCwd("conv-persisted", "/persisted/dir");

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-persisted",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/persisted/dir");
  });

  it("persists the cwd when the request provides one (and a later cwd-less turn reuses it)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-persist-new",
      text: "first",
      onEvent: () => {},
      cwd: "/new/dir",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/new/dir");
    expect(store.cwdData.get("conv-persist-new")).toBe("/new/dir");

    await orchestrator.handleMessage({
      conversationId: "conv-persist-new",
      text: "second",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(2);
    expect(captured[1]?.cwd).toBe("/new/dir");
  });

  it("an explicit request cwd overrides the persisted cwd (and updates it)", async () => {
    const store = createInMemoryStore();
    await store.setCwd("conv-override", "/old/dir");

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-override",
      text: "override",
      onEvent: () => {},
      cwd: "/new/dir",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/new/dir");
    expect(store.cwdData.get("conv-override")).toBe("/new/dir");

    await orchestrator.handleMessage({
      conversationId: "conv-override",
      text: "reused",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(2);
    expect(captured[1]?.cwd).toBe("/new/dir");
  });

  it("no cwd is threaded when neither request nor store has one", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-no-cwd-either",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBeUndefined();
  });
});

describe("detached turn hub", () => {
  function waitForEvent(
    orchestrator: ReturnType<typeof createSessionOrchestrator>["orchestrator"],
    conversationId: string,
    eventType: string,
  ): Promise<AgentEvent> {
    return new Promise((resolve) => {
      const unsub = orchestrator.subscribe(conversationId, (event) => {
        if (event.type === eventType) {
          unsub();
          resolve(event);
        }
      });
    });
  }

  it("subscribe-BEFORE-startTurn delivers — listener receives full ordered event sequence", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "text-delta", delta: " world" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const events: AgentEvent[] = [];
    const unsub = orchestrator.subscribe("conv-pre-sub", (e) => events.push(e));

    orchestrator.startTurn({ conversationId: "conv-pre-sub", text: "Hi" });

    const sealed = waitForEvent(orchestrator, "conv-pre-sub", "turn-sealed");
    await sealed;

    unsub();

    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("user-message");
    expect(types[1]).toBe("turn-start");
    expect(types).toContain("text-delta");
    expect(types[types.length - 1]).toBe("turn-ended");

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);
  });

  it("multi-subscriber fan-out (subscribed before start) — two listeners receive identical ordered events", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "text-delta", delta: " world" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    const unsubA = orchestrator.subscribe("conv-fanout-pre", (e) => eventsA.push(e));
    const unsubB = orchestrator.subscribe("conv-fanout-pre", (e) => eventsB.push(e));

    orchestrator.startTurn({ conversationId: "conv-fanout-pre", text: "Hi" });

    const sealed = waitForEvent(orchestrator, "conv-fanout-pre", "turn-sealed");
    await sealed;

    unsubA();
    unsubB();

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA).toEqual(eventsB);

    const types = eventsA.map((e) => e.type);
    expect(types[0]).toBe("user-message");
    expect(types[1]).toBe("turn-start");
    expect(types[types.length - 1]).toBe("turn-ended");
  });

  it("late-join replay — subscriber added mid-turn receives buffered events then live events, no gap/dup", async () => {
    const store = createInMemoryStore();
    let emitBarrierResolve: (() => void) | undefined;
    const emitBarrier = new Promise<void>((resolve) => {
      emitBarrierResolve = resolve;
    });

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const idx = callIndex++;
        return (async function* () {
          if (idx === 0) {
            yield { type: "text-delta", delta: "Hello" } as ProviderEvent;
            yield { type: "text-delta", delta: " world" } as ProviderEvent;
            await emitBarrier;
            yield { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } } as ProviderEvent;
            yield { type: "finish", reason: "stop" } as ProviderEvent;
          }
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    orchestrator.startTurn({ conversationId: "conv-latejoin", text: "Hi" });

    const earlyEvents: AgentEvent[] = [];
    const unsubEarly = orchestrator.subscribe("conv-latejoin", (e) => earlyEvents.push(e));

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const lateEvents: AgentEvent[] = [];
    const unsubLate = orchestrator.subscribe("conv-latejoin", (e) => lateEvents.push(e));

    const earlySnapshot = [...earlyEvents];
    expect(earlySnapshot.length).toBeGreaterThanOrEqual(2);
    expect(earlySnapshot.some((e) => e.type === "turn-start")).toBe(true);
    expect(earlySnapshot.some((e) => e.type === "text-delta")).toBe(true);

    // The late-join replay is COMPACTED: the two buffered text-deltas arrive
    // as ONE merged delta ("Hello world"), everything else verbatim + in order.
    expect(lateEvents).toEqual(compactReplay(earlySnapshot));
    const lateDeltas = lateEvents.filter((e) => e.type === "text-delta");
    expect(lateDeltas).toHaveLength(1);
    expect((lateDeltas[0] as { delta: string }).delta).toBe("Hello world");
    const replayLen = lateEvents.length;

    emitBarrierResolve?.();

    const sealed = waitForEvent(orchestrator, "conv-latejoin", "turn-sealed");
    await sealed;

    unsubEarly();
    unsubLate();

    // No gap/dup: after the replay, the late subscriber receives exactly the
    // live events the early subscriber received after the snapshot point.
    expect(earlyEvents.length).toBeGreaterThan(earlySnapshot.length);
    expect(lateEvents.slice(replayLen)).toEqual(earlyEvents.slice(earlySnapshot.length));
  });

  it("late-join bounds running output, drops completed output, and leaves live delivery verbatim", async () => {
    let releaseTool = () => {};
    let releaseFinal = () => {};
    let outputReady = () => {};
    let finalReady = () => {};
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const outputSeen = new Promise<void>((resolve) => {
      outputReady = resolve;
    });
    const finalSeen = new Promise<void>((resolve) => {
      finalReady = resolve;
    });
    let step = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        return (async function* () {
          if (step++ === 0) {
            yield { type: "tool-call", toolCallId: "x", toolName: "echo", input: {} } as const;
            yield { type: "finish", reason: "tool-calls" } as const;
          } else {
            finalReady();
            await finalGate;
            yield { type: "text-delta", delta: "done" } as const;
            yield { type: "finish", reason: "stop" } as const;
          }
        })();
      },
    };
    const tool: ToolContract = {
      name: "echo",
      description: "progress",
      parameters: { type: "object" },
      async execute(_input, ctx) {
        ctx.onOutput("a".repeat(50_000), "stdout");
        ctx.onOutput("b".repeat(50_000), "stderr");
        outputReady();
        await toolGate;
        return { content: "complete" };
      },
    };
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: createConversationStore(storageFromMap()),
      resolveProvider: () => provider,
      resolveTools: () => [tool],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    const live: AgentEvent[] = [];
    const unsubLive = orchestrator.subscribe("replay-cap", (e) => live.push(e));
    orchestrator.startTurn({ conversationId: "replay-cap", text: "run" });
    try {
      await outputSeen;
      const running: AgentEvent[] = [];
      const unsubRunning = orchestrator.subscribe("replay-cap", (e) => running.push(e));
      unsubRunning();
      expect(running).toEqual(compactReplay(live));
      expect(running.filter((e) => e.type === "tool-output").map((e) => e.data.length)).toEqual([
        15_536, 50_000,
      ]);
      expect(live.filter((e) => e.type === "tool-output").map((e) => e.data.length)).toEqual([
        50_000, 50_000,
      ]);
      releaseTool();
      await finalSeen;
      const completed: AgentEvent[] = [];
      const unsubCompleted = orchestrator.subscribe("replay-cap", (e) => completed.push(e));
      unsubCompleted();
      expect(completed).toEqual(compactReplay(live));
      expect(completed.some((e) => e.type === "tool-output")).toBe(false);
      expect(completed.some((e) => e.type === "tool-result")).toBe(true);
    } finally {
      releaseTool();
      releaseFinal();
      await waitForEvent(orchestrator, "replay-cap", "turn-ended");
      unsubLive();
    }
  });

  it("subscriber persists across turns — one subscriber receives events from two sequential turns", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Turn1" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", delta: "Turn2" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const allEvents: AgentEvent[] = [];
    const unsub = orchestrator.subscribe("conv-persist", (e) => allEvents.push(e));

    // First turn
    orchestrator.startTurn({ conversationId: "conv-persist", text: "First" });
    const sealed1 = waitForEvent(orchestrator, "conv-persist", "turn-sealed");
    await sealed1;

    // Second turn
    orchestrator.startTurn({ conversationId: "conv-persist", text: "Second" });
    const sealed2 = waitForEvent(orchestrator, "conv-persist", "turn-sealed");
    await sealed2;

    unsub();

    const turnStarts = allEvents.filter((e) => e.type === "turn-start");
    expect(turnStarts).toHaveLength(2);

    const turnSealeds = allEvents.filter((e) => e.type === "turn-sealed");
    expect(turnSealeds).toHaveLength(2);

    const textDeltas = allEvents.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as AgentEvent & { type: "text-delta" }).delta).toBe("Turn1");
    expect((textDeltas[1] as AgentEvent & { type: "text-delta" }).delta).toBe("Turn2");
  });

  it("detached completion — turn runs to completion with zero subscribers and persists", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const result = orchestrator.startTurn({ conversationId: "conv-detached", text: "Hi" });
    expect(result.started).toBe(true);
    const sealed = waitForEvent(orchestrator, "conv-detached", "turn-sealed");

    await sealed;

    const stored = store.data.get("conv-detached");
    expect(stored).toBeDefined();
    expect(stored).toHaveLength(2);
    expect(stored?.[0]?.role).toBe("user");
    expect(stored?.[1]?.role).toBe("assistant");
  });

  it("single-flight reject — startTurn while active returns already-active, no second turn", async () => {
    const store = createInMemoryStore();
    let resolveRunTurn: (() => void) | undefined;
    const runTurnBlocker = new Promise<void>((resolve) => {
      resolveRunTurn = resolve;
    });

    const provider: ProviderContract = {
      id: "fake",
      stream: async function* () {
        yield { type: "text-delta", delta: "slow" } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const blockingRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
      await runTurnBlocker;
      return {
        messages: [{ role: "assistant", chunks: [{ type: "text", text: "done" }] }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      };
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: blockingRunTurn,
    });

    const first = orchestrator.startTurn({ conversationId: "conv-singleflight", text: "first" });
    expect(first.started).toBe(true);
    const sealed = waitForEvent(orchestrator, "conv-singleflight", "turn-sealed");

    const second = orchestrator.startTurn({ conversationId: "conv-singleflight", text: "second" });
    expect(second.started).toBe(false);
    if (!second.started) {
      expect(second.reason).toBe("already-active");
    }

    resolveRunTurn?.();
    await sealed;

    expect(store.data.get("conv-singleflight")?.length).toBe(2);
  });

  it("isActive false after seal — subscribe replays nothing after turn-sealed", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    expect(orchestrator.isActive("conv-cleared")).toBe(false);

    orchestrator.startTurn({ conversationId: "conv-cleared", text: "test" });
    const sealed = waitForEvent(orchestrator, "conv-cleared", "turn-sealed");

    await sealed;

    expect(orchestrator.isActive("conv-cleared")).toBe(false);

    const lateEvents: AgentEvent[] = [];
    const unsub = orchestrator.subscribe("conv-cleared", (e) => lateEvents.push(e));
    unsub();

    expect(lateEvents).toHaveLength(0);
  });

  it("handleMessage convenience — drives turn end-to-end via onEvent and resolves on turn-ended", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const events: AgentEvent[] = [];
    await orchestrator.handleMessage({
      conversationId: "conv-hm",
      text: "Hi",
      onEvent: (e) => events.push(e),
    });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("user-message");
    expect(types[1]).toBe("turn-start");
    expect(types).toContain("text-delta");
    expect(types[types.length - 1]).toBe("turn-ended");

    const stored = store.data.get("conv-hm");
    expect(stored).toHaveLength(2);
  });

  it("handleMessage already-active emits error event and resolves without hanging", async () => {
    const store = createInMemoryStore();
    let resolveRunTurn: (() => void) | undefined;
    const runTurnBlocker = new Promise<void>((resolve) => {
      resolveRunTurn = resolve;
    });

    const provider: ProviderContract = {
      id: "fake",
      stream: async function* () {
        yield { type: "text-delta", delta: "slow" } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const blockingRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
      await runTurnBlocker;
      return {
        messages: [{ role: "assistant", chunks: [{ type: "text", text: "done" }] }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      };
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: blockingRunTurn,
    });

    const firstEvents: AgentEvent[] = [];
    const firstPromise = orchestrator.handleMessage({
      conversationId: "conv-hm-active",
      text: "first",
      onEvent: (e) => firstEvents.push(e),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const secondEvents: AgentEvent[] = [];
    const secondPromise = orchestrator.handleMessage({
      conversationId: "conv-hm-active",
      text: "second",
      onEvent: (e) => secondEvents.push(e),
    });

    await secondPromise;

    expect(secondEvents).toHaveLength(2);
    expect(secondEvents[0]?.type).toBe("error");
    expect((secondEvents[0] as AgentEvent & { type: "error" }).message).toBe(
      "failed: turn already active for this conversation",
    );
    expect(secondEvents[1]).toMatchObject({ type: "turn-ended", reason: "rejected" });

    resolveRunTurn?.();
    await firstPromise;

    expect(firstEvents.some((e) => e.type === "turn-sealed")).toBe(true);
  });
});

describe("user-message event", () => {
  function waitForEvent(
    orchestrator: ReturnType<typeof createSessionOrchestrator>["orchestrator"],
    conversationId: string,
    eventType: string,
  ): Promise<AgentEvent> {
    return new Promise((resolve) => {
      const unsub = orchestrator.subscribe(conversationId, (event) => {
        if (event.type === eventType) {
          unsub();
          resolve(event);
        }
      });
    });
  }

  it("emits user-message first — pre-subscriber receives user-message before turn-start", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    const events: AgentEvent[] = [];
    const unsub = orchestrator.subscribe("conv-um-first", (e) => events.push(e));

    orchestrator.startTurn({ conversationId: "conv-um-first", text: "What is 2+2?" });

    const sealed = waitForEvent(orchestrator, "conv-um-first", "turn-sealed");
    await sealed;
    unsub();

    expect(events.length).toBeGreaterThan(1);
    expect(events[0]?.type).toBe("user-message");
    const um = events[0] as AgentEvent & { type: "user-message" };
    expect(um.text).toBe("What is 2+2?");
    expect(um.conversationId).toBe("conv-um-first");
    expect(um.turnId).toMatch(/^turn-/);
    expect(events[1]?.type).toBe("turn-start");
  });

  it("late-join replays user-message — buffer starts with user-message", async () => {
    const store = createInMemoryStore();
    let emitBarrierResolve: (() => void) | undefined;
    const emitBarrier = new Promise<void>((resolve) => {
      emitBarrierResolve = resolve;
    });

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const idx = callIndex++;
        return (async function* () {
          if (idx === 0) {
            yield { type: "text-delta", delta: "Hello" } as ProviderEvent;
            await emitBarrier;
            yield { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } } as ProviderEvent;
            yield { type: "finish", reason: "stop" } as ProviderEvent;
          }
        })();
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });

    orchestrator.startTurn({ conversationId: "conv-um-late", text: "late prompt" });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const lateEvents: AgentEvent[] = [];
    const unsubLate = orchestrator.subscribe("conv-um-late", (e) => lateEvents.push(e));

    expect(lateEvents.length).toBeGreaterThanOrEqual(1);
    expect(lateEvents[0]?.type).toBe("user-message");
    const um = lateEvents[0] as AgentEvent & { type: "user-message" };
    expect(um.text).toBe("late prompt");
    expect(um.turnId).toMatch(/^turn-/);

    emitBarrierResolve?.();
    const sealed = waitForEvent(orchestrator, "conv-um-late", "turn-sealed");
    await sealed;
    unsubLate();
  });

  it("metrics unaffected — user-message does not alter TurnMetrics", async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      now: () => 1000,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-um-metrics",
      text: "test",
      onEvent: () => {},
    });

    const metrics = store.metricsData.get("conv-um-metrics");
    expect(metrics).toBeDefined();
    expect(metrics).toHaveLength(1);

    const tm = metrics?.[0];
    if (tm === undefined) throw new Error("expected metrics");

    expect(tm.turnId).toMatch(/^turn-/);
    expect(tm.usage.inputTokens).toBe(10);
    expect(tm.usage.outputTokens).toBe(5);
    expect(tm.steps).toHaveLength(1);
    expect(tm.steps[0]?.usage.inputTokens).toBe(10);
    expect(tm.steps[0]?.usage.outputTokens).toBe(5);
  });
});

describe("closeConversation (CR-4c)", () => {
  it("aborts an in-flight turn: done.reason 'aborted', partial messages persisted, turn seals", async () => {
    const store = createInMemoryStore();
    let releaseStream: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        return (async function* () {
          yield { type: "text-delta", delta: "Hello" } as ProviderEvent;
          await barrier;
          yield { type: "text-delta", delta: " world" } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    const emittedHooks: string[] = [];
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: (hook) => {
        emittedHooks.push(hook.id);
      },
    });

    const events: AgentEvent[] = [];
    let resolveSealed: (() => void) | undefined;
    const sealed = new Promise<void>((resolve) => {
      resolveSealed = resolve;
    });
    let resolveFirstDelta: (() => void) | undefined;
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    orchestrator.subscribe("conv-close", (e) => {
      events.push(e);
      if (e.type === "text-delta") resolveFirstDelta?.();
      if (e.type === "turn-sealed") resolveSealed?.();
    });

    orchestrator.startTurn({ conversationId: "conv-close", text: "Hi" });
    await firstDelta;

    const result = orchestrator.closeConversation("conv-close");
    expect(result.abortedTurn).toBe(true);
    expect(emittedHooks).toContain("session-orchestrator/conversation-closed");

    releaseStream?.();
    await sealed;

    const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    expect(done?.reason).toBe("aborted");
    expect(orchestrator.isActive("conv-close")).toBe(false);

    // Durability: the partial turn persisted normally (user msg + partial reply).
    const persisted = store.data.get("conv-close") ?? [];
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    expect(persisted[0]?.role).toBe("user");
  });

  it("is idempotent on an idle/unknown conversation: abortedTurn false, hook still emitted", async () => {
    const store = createInMemoryStore();
    const emitted: Array<{ hook: string; payload: unknown }> = [];
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => createFakeProvider([]),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: (hook, payload) => {
        emitted.push({ hook: hook.id, payload });
      },
    });

    const result = orchestrator.closeConversation("conv-never-seen");
    expect(result.abortedTurn).toBe(false);
    // The conversation-closed hook is emitted synchronously; the
    // status-changed hook resolves the workspace id async before emitting.
    expect(emitted).toEqual([
      {
        hook: "session-orchestrator/conversation-closed",
        payload: { conversationId: "conv-never-seen" },
      },
    ]);
    // Flush the async getWorkspaceId resolution so the status-changed emit lands.
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toContainEqual({
      hook: "session-orchestrator/conversation-status-changed",
      payload: { conversationId: "conv-never-seen", status: "closed", workspaceId: "default" },
    });

    // Closing again is still safe.
    expect(orchestrator.closeConversation("conv-never-seen").abortedTurn).toBe(false);
  });
});

// --- workspace id on conversationOpened / conversationStatusChanged payloads ---

describe("stopAll (plan 05 §8 — forced unload stops ALL agents globally)", () => {
  it("aborts EVERY in-flight turn: all report aborted, partials persist, none left active", async () => {
    const store = createInMemoryStore();
    // Two blocked providers — each turn stalls mid-stream until released.
    const releaseCalls: Array<() => void> = [];
    const barrier = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseCalls.push(resolve);
      });
    const stalledProvider: ProviderContract = {
      id: "fake-stalled",
      stream() {
        return (async function* () {
          yield { type: "text-delta", delta: "partial" } as ProviderEvent;
          await barrier();
          yield { type: "text-delta", delta: " never arrives" } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => stalledProvider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    });

    const sealed = {
      "conv-1": new Promise<void>((resolve) => {
        orchestrator.subscribe("conv-1", (e) => {
          if (e.type === "turn-sealed") resolve();
        });
      }),
      "conv-2": new Promise<void>((resolve) => {
        orchestrator.subscribe("conv-2", (e) => {
          if (e.type === "turn-sealed") resolve();
        });
      }),
    };
    orchestrator.startTurn({ conversationId: "conv-1", text: "one" });
    orchestrator.startTurn({ conversationId: "conv-2", text: "two" });
    expect(orchestrator.isActive("conv-1")).toBe(true);
    expect(orchestrator.isActive("conv-2")).toBe(true);

    // stopAll reports both aborted; the orchestrator is left with NO active
    // conversations (the set drains as the aborted turns settle).
    const result = orchestrator.stopAll();
    expect(result.stopped).toBe(2);
    expect(orchestrator.getActiveConversationCount()).toBe(2); // abort is async until seal

    // Both turns settle normally (aborted), partial messages persisted.
    await Promise.all([sealed["conv-1"], sealed["conv-2"]]);
    expect(orchestrator.isActive("conv-1")).toBe(false);
    expect(orchestrator.isActive("conv-2")).toBe(false);

    const persisted1 = store.data.get("conv-1") ?? [];
    const persisted2 = store.data.get("conv-2") ?? [];
    expect(persisted1.length).toBeGreaterThanOrEqual(1);
    expect(persisted1[0]?.role).toBe("user");
    expect(persisted2[0]?.role).toBe("user");
  });

  it("stops conversations whose turns are ACTIVE only; counts no-op stops as zero", async () => {
    const store = createInMemoryStore();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => createFakeProvider([]),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    });
    // No turns at all — stopAll is a global no-op.
    expect(orchestrator.stopAll()).toEqual({ stopped: 0 });

    orchestrator.startTurn({ conversationId: "conv-idle", text: "hi" });
    // Flush microtasks so the fake turn settles to idle first.
    await new Promise((resolve) => setImmediate(resolve));
    await orchestrator.handleMessage({
      conversationId: "conv-idle",
      text: "again",
      onEvent: () => {},
    });
    // After the turn settles, stopAll finds nothing in flight.
    expect(orchestrator.stopAll().stopped).toBe(0);
  });

  it("stopAll is safe to call repeatedly (idempotent)", () => {
    const store = createInMemoryStore();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => createFakeProvider([]),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    });
    expect(orchestrator.stopAll().stopped).toBe(0);
    expect(orchestrator.stopAll().stopped).toBe(0);
  });
});

describe("workspace id broadcast payloads", () => {
  it("conversationStatusChanged payload carries the workspace id from the store", async () => {
    const base = createInMemoryStore();
    // Pre-assign a non-default workspace so we can assert it's threaded
    // through (not the per-turn start option, which differs).
    await base.setWorkspaceId("conv-ws-broadcast", "team-workspace");

    const emitted: Array<{ hook: string; payload: ConversationStatusChangedPayload }> = [];
    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: base,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: (hook, payload) => {
        if (hook.id === "session-orchestrator/conversation-status-changed") {
          emitted.push({
            hook: hook.id,
            payload: payload as ConversationStatusChangedPayload,
          });
        }
      },
    });

    // Pass a DIFFERENT per-turn workspaceId to prove the payload uses the
    // persisted store value, not the start option.
    await orchestrator.handleMessage({
      conversationId: "conv-ws-broadcast",
      text: "hi",
      onEvent: () => {},
      workspaceId: "should-not-appear",
    });
    // Flush the async getWorkspaceId resolutions.
    await new Promise((resolve) => setImmediate(resolve));

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const e of emitted) {
      expect(e.payload.workspaceId).toBe("team-workspace");
    }

    // closeConversation also threads the persisted workspace id.
    const closeEmitted: ConversationStatusChangedPayload[] = [];
    const { orchestrator: orchestrator2 } = createSessionOrchestrator({
      conversationStore: base,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: (hook, payload) => {
        if (hook.id === "session-orchestrator/conversation-status-changed") {
          closeEmitted.push(payload as ConversationStatusChangedPayload);
        }
      },
    });
    orchestrator2.closeConversation("conv-ws-broadcast");
    await new Promise((resolve) => setImmediate(resolve));
    const closed = closeEmitted.find((p) => p.status === "closed");
    expect(closed).toBeDefined();
    expect(closed?.workspaceId).toBe("team-workspace");
  });

  it("conversationOpened payload carries the workspace id (type-level construct)", () => {
    // conversationOpened is emitted by a sibling transport unit, so this
    // package only owns the payload TYPE. This regression test pins the
    // type to require workspaceId (a missing field would fail to compile)
    // and verifies the persisted value flows through at construction time.
    const payload: ConversationOpenedPayload = {
      conversationId: "conv-open",
      workspaceId: "open-workspace",
    };
    expect(payload.workspaceId).toBe("open-workspace");
    expect(payload.conversationId).toBe("conv-open");
  });
});

describe("reasoning effort resolution", () => {
  it("override wins over stored → provider receives the override level", async () => {
    const store = createInMemoryStore();
    await store.setReasoningEffort("conv-effort-override", "low");
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-effort-override",
      text: "hi",
      onEvent: () => {},
      reasoningEffort: "max",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.reasoningEffort).toBe("max");
  });

  it("no override, store has a value → provider receives the stored value", async () => {
    const store = createInMemoryStore();
    await store.setReasoningEffort("conv-effort-stored", "xhigh");
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-effort-stored",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.reasoningEffort).toBe("xhigh");
  });

  it("no override, store empty → provider receives 'high' (default)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-effort-default",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.reasoningEffort).toBe("high");
  });

  it("warm receives the same resolved effort as a real turn for the same conversation", async () => {
    const store = createInMemoryStore();
    await store.append("conv-warm-effort", [
      { role: "user", chunks: [{ type: "text", text: "hi" }] },
    ]);
    await store.setReasoningEffort("conv-warm-effort", "medium");

    let warmOpts: ProviderStreamOptions | undefined;

    const provider: ProviderContract = {
      id: "p",
      stream(_messages, _tools, opts) {
        warmOpts = opts;
        return (async function* () {
          yield {
            type: "usage",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    const { captured, captureRunTurn } = createCapturingRunTurn();

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      emit: () => {},
    };

    const { orchestrator, activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    await warmService.warm("conv-warm-effort");

    await orchestrator.handleMessage({
      conversationId: "conv-warm-effort",
      text: "hi",
      onEvent: () => {},
    });

    expect(warmOpts?.reasoningEffort).toBe("medium");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.reasoningEffort).toBe("medium");
    expect(warmOpts?.reasoningEffort).toBe(captured[0]?.providerOpts?.reasoningEffort);
  });
});

// --- Workspace integration (workspaceId threading + effective cwd) ---

describe("workspace integration", () => {
  function waitForSealed(
    orchestrator: ReturnType<typeof createSessionOrchestrator>["orchestrator"],
    conversationId: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      const unsub = orchestrator.subscribe(conversationId, (e) => {
        if (e.type === "turn-sealed") {
          unsub();
          resolve();
        }
      });
    });
  }

  it("startTurn stamps workspaceId on new conversation", async () => {
    const base = createInMemoryStore();
    const setWorkspaceIdCalls: Array<{ conversationId: string; workspaceId: string }> = [];
    const store: ConversationStore = {
      ...base,
      async setWorkspaceId(conversationId, workspaceId) {
        setWorkspaceIdCalls.push({ conversationId, workspaceId });
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: createCapturingRunTurn().captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-ws-stamp",
      text: "hi",
      onEvent: () => {},
      workspaceId: "my-workspace",
    });

    expect(setWorkspaceIdCalls).toContainEqual({
      conversationId: "conv-ws-stamp",
      workspaceId: "my-workspace",
    });
  });

  it("startTurn defaults workspaceId to default", async () => {
    const base = createInMemoryStore();
    const setWorkspaceIdCalls: Array<{ conversationId: string; workspaceId: string }> = [];
    const store: ConversationStore = {
      ...base,
      async setWorkspaceId(conversationId, workspaceId) {
        setWorkspaceIdCalls.push({ conversationId, workspaceId });
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: createCapturingRunTurn().captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-ws-default",
      text: "hi",
      onEvent: () => {},
    });

    expect(setWorkspaceIdCalls).toContainEqual({
      conversationId: "conv-ws-default",
      workspaceId: "default",
    });
  });

  it("startTurn auto-creates workspace if missing", async () => {
    const base = createInMemoryStore();
    const ensureWorkspaceCalls: string[] = [];
    const store: ConversationStore = {
      ...base,
      async ensureWorkspace(id) {
        ensureWorkspaceCalls.push(id);
        return {
          id,
          title: id,
          defaultCwd: null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: createCapturingRunTurn().captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-ws-autocreate",
      text: "hi",
      onEvent: () => {},
      workspaceId: "brand-new-workspace",
    });

    expect(ensureWorkspaceCalls).toContain("brand-new-workspace");
  });

  it("startTurn uses effective cwd when no explicit cwd", async () => {
    const base = createInMemoryStore();
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd() {
        return "/workspace/default/cwd";
      },
    };

    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-ws-effcwd",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/workspace/default/cwd");
  });

  it("startTurn explicit cwd overrides workspace default", async () => {
    const base = createInMemoryStore();
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd(_conversationId, overrideCwd) {
        return overrideCwd ?? "/workspace/default/cwd";
      },
    };

    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-ws-override",
      text: "hi",
      onEvent: () => {},
      cwd: "/explicit/cwd",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/explicit/cwd");
  });

  it("startTurn effective cwd null when nothing set", async () => {
    const store = createInMemoryStore();
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-ws-null-cwd",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBeUndefined();
  });

  it("warm uses effective cwd", async () => {
    const base = createInMemoryStore();
    await base.append("conv-warm-effcwd", [
      { role: "user", chunks: [{ type: "text", text: "hi" }] },
    ]);
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd() {
        return "/workspace/warm/cwd";
      },
    };

    let assemblyCwd: string | undefined = "UNSET";
    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: (assembly: ToolAssembly) => {
        assemblyCwd = assembly.cwd;
        return Promise.resolve(assembly);
      },
      runTurn,
      emit: () => {},
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    await warmService.warm("conv-warm-effcwd");
    expect(assemblyCwd).toBe("/workspace/warm/cwd");
  });

  it("enqueue threads workspaceId", async () => {
    const base = createInMemoryStore();
    const setWorkspaceIdCalls: Array<{ conversationId: string; workspaceId: string }> = [];
    const store: ConversationStore = {
      ...base,
      async setWorkspaceId(conversationId, workspaceId) {
        setWorkspaceIdCalls.push({ conversationId, workspaceId });
      },
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: createCapturingRunTurn().captureRunTurn,
    });

    orchestrator.enqueue({
      conversationId: "conv-enq-ws",
      text: "hello",
      workspaceId: "enqueued-ws",
    });
    await waitForSealed(orchestrator, "conv-enq-ws");

    expect(setWorkspaceIdCalls).toContainEqual({
      conversationId: "conv-enq-ws",
      workspaceId: "enqueued-ws",
    });
  });

  // --- cwd-timing invariant: workspace assigned BEFORE getEffectiveCwd ---

  it("new conversation: workspace assigned before getEffectiveCwd resolves (relative per-turn cwd)", async () => {
    // A fake store that implements the REAL getEffectiveCwd algorithm:
    // a relative overrideCwd is resolved against the workspace's
    // defaultCwd via path.resolve. Different workspaces have different
    // defaultCwds so we can assert which workspace was active when
    // getEffectiveCwd ran.
    const workspaceDefaultCwds = new Map<string, string | null>([
      ["default", null],
      ["my-workspace", "/projects/my-workspace"],
    ]);
    const assignedWorkspaceIds = new Map<string, string>();
    const callOrder: string[] = [];

    const store: ConversationStore = {
      ...createInMemoryStore(),
      async getConversationMeta(conversationId) {
        // A conversation is "known" once setWorkspaceId has been called
        // (matching the real store, where setWorkspaceId creates a meta
        // row). This lets us assert the ordering: getConversationMeta
        // sees null first (new), then setWorkspaceId is called, then
        // getEffectiveCwd runs and sees the assigned workspace.
        const wsId = assignedWorkspaceIds.get(conversationId);
        return wsId !== undefined
          ? {
              id: conversationId,
              createdAt: 0,
              lastActivityAt: 0,
              title: "Untitled",
              status: "idle",
              workspaceId: wsId,
            }
          : null;
      },
      async ensureWorkspace(id) {
        callOrder.push(`ensureWorkspace:${id}`);
        return {
          id,
          title: id,
          defaultCwd: workspaceDefaultCwds.get(id) ?? null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceId(conversationId, workspaceId) {
        callOrder.push(`setWorkspaceId:${workspaceId}`);
        assignedWorkspaceIds.set(conversationId, workspaceId);
      },
      async getWorkspaceId(conversationId) {
        return assignedWorkspaceIds.get(conversationId) ?? "default";
      },
      async getWorkspace(id) {
        const defaultCwd = workspaceDefaultCwds.get(id) ?? null;
        return {
          id,
          title: id,
          defaultCwd,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async getEffectiveCwd(conversationId, overrideCwd) {
        // Real algorithm: relative cwd resolved against workspace defaultCwd.
        const wsId = assignedWorkspaceIds.get(conversationId) ?? "default";
        callOrder.push(`getEffectiveCwd(workspace=${wsId})`);
        const workspaceCwd = workspaceDefaultCwds.get(wsId) ?? null;
        const conversationCwd = overrideCwd ?? null;
        if (conversationCwd === null) {
          return workspaceCwd;
        }
        if (conversationCwd.startsWith("/")) {
          return conversationCwd;
        }
        return pathResolve(workspaceCwd ?? "/server-default", conversationCwd);
      },
    };

    const { captured, captureRunTurn } = createCapturingRunTurn();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-cwd-timing",
      text: "hi",
      onEvent: () => {},
      cwd: "arch-rewrite",
      workspaceId: "my-workspace",
    });

    // The workspace was assigned before getEffectiveCwd ran.
    const ensureIdx = callOrder.indexOf("ensureWorkspace:my-workspace");
    const setWsIdx = callOrder.indexOf("setWorkspaceId:my-workspace");
    const effCwdIdx = callOrder.indexOf("getEffectiveCwd(workspace=my-workspace)");
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(setWsIdx).toBeGreaterThan(ensureIdx);
    expect(effCwdIdx).toBeGreaterThan(setWsIdx);

    // The relative cwd "arch-rewrite" resolved against my-workspace's
    // defaultCwd "/projects/my-workspace", NOT against the default
    // workspace's null (→ server default / process.cwd()).
    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/projects/my-workspace/arch-rewrite");
  });

  it("new conversation with no per-turn cwd: workspace assigned, effective cwd = workspace defaultCwd", async () => {
    const workspaceDefaultCwds = new Map<string, string | null>([
      ["default", null],
      ["my-workspace", "/projects/my-workspace"],
    ]);
    const assignedWorkspaceIds = new Map<string, string>();

    const store: ConversationStore = {
      ...createInMemoryStore(),
      async getConversationMeta(conversationId) {
        const wsId = assignedWorkspaceIds.get(conversationId);
        return wsId !== undefined
          ? {
              id: conversationId,
              createdAt: 0,
              lastActivityAt: 0,
              title: "Untitled",
              status: "idle",
              workspaceId: wsId,
            }
          : null;
      },
      async ensureWorkspace(id) {
        return {
          id,
          title: id,
          defaultCwd: workspaceDefaultCwds.get(id) ?? null,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async setWorkspaceId(conversationId, workspaceId) {
        assignedWorkspaceIds.set(conversationId, workspaceId);
      },
      async getWorkspaceId(conversationId) {
        return assignedWorkspaceIds.get(conversationId) ?? "default";
      },
      async getWorkspace(id) {
        const defaultCwd = workspaceDefaultCwds.get(id) ?? null;
        return {
          id,
          title: id,
          defaultCwd,
          defaultComputerId: null,
          createdAt: 0,
          lastActivityAt: 0,
        };
      },
      async getEffectiveCwd(conversationId, overrideCwd) {
        const wsId = assignedWorkspaceIds.get(conversationId) ?? "default";
        const workspaceCwd = workspaceDefaultCwds.get(wsId) ?? null;
        const conversationCwd = overrideCwd ?? null;
        if (conversationCwd === null) {
          return workspaceCwd;
        }
        if (conversationCwd.startsWith("/")) {
          return conversationCwd;
        }
        return pathResolve(workspaceCwd ?? "/server-default", conversationCwd);
      },
    };

    const { captured, captureRunTurn } = createCapturingRunTurn();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-cwd-timing-no-cwd",
      text: "hi",
      onEvent: () => {},
      workspaceId: "my-workspace",
    });

    // No per-turn cwd → effective cwd = workspace defaultCwd.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("/projects/my-workspace");
  });

  it("existing conversation: workspace NOT re-assigned, effective cwd resolves as before", async () => {
    const setWorkspaceIdCalls: Array<{ conversationId: string; workspaceId: string }> = [];
    const base = createInMemoryStore();
    // Pre-populate the conversation so getConversationMeta returns non-null
    // (existing conversation with history + workspace already assigned).
    await base.append("conv-existing", [
      { role: "user", chunks: [{ type: "text", text: "previous turn" }] },
      { role: "assistant", chunks: [{ type: "text", text: "reply" }] },
    ]);

    const store: ConversationStore = {
      ...base,
      async setWorkspaceId(conversationId, workspaceId) {
        setWorkspaceIdCalls.push({ conversationId, workspaceId });
      },
      async getEffectiveCwd(_conversationId, overrideCwd) {
        return overrideCwd ?? "/existing/workspace/cwd";
      },
    };

    const { captured, captureRunTurn } = createCapturingRunTurn();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-existing",
      text: "follow up",
      onEvent: () => {},
      cwd: "arch-rewrite",
      workspaceId: "should-not-be-stamped",
    });

    // setWorkspaceId was NOT called (existing conversation keeps its workspace).
    expect(setWorkspaceIdCalls).toHaveLength(0);

    // Effective cwd still resolves (here via the fake store's override).
    expect(captured).toHaveLength(1);
    expect(captured[0]?.cwd).toBe("arch-rewrite");
  });
});

describe("getEffectiveCwd override (per-turn cwd resolution)", () => {
  it("turn start with a per-turn cwd → getEffectiveCwd called with that cwd as overrideCwd", async () => {
    const base = createInMemoryStore();
    const effectiveCwdCalls: Array<{ conversationId: string; overrideCwd: string | undefined }> =
      [];
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd(conversationId, overrideCwd) {
        effectiveCwdCalls.push({ conversationId, overrideCwd });
        return overrideCwd ?? (await base.getEffectiveCwd(conversationId));
      },
    };

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-turn-override",
      text: "hi",
      onEvent: () => {},
      cwd: "arch-rewrite",
    });

    expect(effectiveCwdCalls).toHaveLength(1);
    expect(effectiveCwdCalls[0]?.overrideCwd).toBe("arch-rewrite");
  });

  it("turn start with no per-turn cwd → getEffectiveCwd called with undefined override", async () => {
    const base = createInMemoryStore();
    const effectiveCwdCalls: Array<{ conversationId: string; overrideCwd: string | undefined }> =
      [];
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd(conversationId, overrideCwd) {
        effectiveCwdCalls.push({ conversationId, overrideCwd });
        return overrideCwd ?? (await base.getEffectiveCwd(conversationId));
      },
    };

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-turn-no-override",
      text: "hi",
      onEvent: () => {},
    });

    expect(effectiveCwdCalls).toHaveLength(1);
    expect(effectiveCwdCalls[0]?.overrideCwd).toBeUndefined();
  });

  it("warm with opts.cwd → getEffectiveCwd called with opts.cwd as override", async () => {
    const base = createInMemoryStore();
    await base.append("conv-warm-override", [
      { role: "user", chunks: [{ type: "text", text: "hi" }] },
    ]);
    const effectiveCwdCalls: Array<{ conversationId: string; overrideCwd: string | undefined }> =
      [];
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd(conversationId, overrideCwd) {
        effectiveCwdCalls.push({ conversationId, overrideCwd });
        return overrideCwd ?? (await base.getEffectiveCwd(conversationId));
      },
    };

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    await warmService.warm("conv-warm-override", { cwd: "arch-rewrite" });

    expect(effectiveCwdCalls).toHaveLength(1);
    expect(effectiveCwdCalls[0]?.overrideCwd).toBe("arch-rewrite");
  });

  it("warm without opts.cwd → getEffectiveCwd called with undefined override", async () => {
    const base = createInMemoryStore();
    await base.append("conv-warm-no-override", [
      { role: "user", chunks: [{ type: "text", text: "hi" }] },
    ]);
    const effectiveCwdCalls: Array<{ conversationId: string; overrideCwd: string | undefined }> =
      [];
    const store: ConversationStore = {
      ...base,
      async getEffectiveCwd(conversationId, overrideCwd) {
        effectiveCwdCalls.push({ conversationId, overrideCwd });
        return overrideCwd ?? (await base.getEffectiveCwd(conversationId));
      },
    };

    const provider: ProviderContract = {
      id: "p",
      stream: async function* () {
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };

    const deps = {
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      emit: () => {},
    };

    const { activeConversations } = createSessionOrchestrator(deps);
    const warmService = createWarmService(deps, activeConversations);

    await warmService.warm("conv-warm-no-override");

    expect(effectiveCwdCalls).toHaveLength(1);
    expect(effectiveCwdCalls[0]?.overrideCwd).toBeUndefined();
  });
});

// --- System prompt integration ---

function createFakeSystemPromptService(
  constructImpl: (
    conversationId: string,
    cwd: string,
    context?: { readonly model?: string; readonly computerId?: string },
  ) => Promise<string>,
  getWithMetaImpl: (conversationId: string) => Promise<{
    readonly prompt: string | null;
    readonly cwd: string | null;
    readonly computerId: string | null;
  }> = () => Promise.resolve({ prompt: null, cwd: null, computerId: null }),
): SystemPromptService {
  return {
    construct: constructImpl,
    async get(conversationId) {
      const meta = await getWithMetaImpl(conversationId);
      return meta.prompt;
    },
    getWithMeta: getWithMetaImpl,
    async getTemplate() {
      return "";
    },
    async setTemplate() {},
  };
}

describe("system prompt: regular turn flow", () => {
  it("First turn: construct called — new conversation (meta null) → construct called with conversationId + cwd + model → result set on providerOpts.systemPrompt", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const constructCalls: Array<{
      conversationId: string;
      cwd: string;
      model: string | undefined;
    }> = [];
    const getCalls: string[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      resolveSystemPrompt: () =>
        createFakeSystemPromptService(
          async (conversationId, cwd, context) => {
            constructCalls.push({
              conversationId,
              cwd,
              model: context?.model,
            });
            return "CONSTRUCTED_PROMPT";
          },
          async (conversationId) => {
            getCalls.push(conversationId);
            return { prompt: null, cwd: null, computerId: null };
          },
        ),
    });

    await orchestrator.handleMessage({
      conversationId: "conv-sp-first",
      text: "hi",
      onEvent: () => {},
      cwd: "/work/dir",
      modelName: "my-model",
    });

    expect(constructCalls).toHaveLength(1);
    expect(constructCalls[0]?.conversationId).toBe("conv-sp-first");
    expect(constructCalls[0]?.cwd).toBe("/work/dir");
    expect(constructCalls[0]?.model).toBe("my-model");
    expect(getCalls).toHaveLength(0);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.systemPrompt).toBe("CONSTRUCTED_PROMPT");
  });

  it("Subsequent turn: stored cwd === effective cwd → uses cached prompt (no construct)", async () => {
    const store = createInMemoryStore();
    // Seed an existing conversation so getConversationMeta returns non-null.
    await store.append("conv-sp-sub", [
      { role: "user", chunks: [{ type: "text", text: "first" }] },
      { role: "assistant", chunks: [{ type: "text", text: "reply" }] },
    ]);

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const constructCalls: string[] = [];
    const getWithMetaCalls: string[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      resolveSystemPrompt: () =>
        createFakeSystemPromptService(
          async (conversationId) => {
            constructCalls.push(conversationId);
            return "SHOULD_NOT_BE_USED";
          },
          async (conversationId) => {
            getWithMetaCalls.push(conversationId);
            return { prompt: "PERSISTED_PROMPT", cwd: "/work/dir", computerId: null };
          },
        ),
    });

    await orchestrator.handleMessage({
      conversationId: "conv-sp-sub",
      text: "second",
      onEvent: () => {},
      cwd: "/work/dir",
    });

    expect(getWithMetaCalls).toHaveLength(1);
    expect(getWithMetaCalls[0]).toBe("conv-sp-sub");
    expect(constructCalls).toHaveLength(0);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.systemPrompt).toBe("PERSISTED_PROMPT");
  });

  it("Subsequent turn: no stored prompt (getWithMeta returns null) → calls construct", async () => {
    const store = createInMemoryStore();
    await store.append("conv-sp-null", [
      { role: "user", chunks: [{ type: "text", text: "first" }] },
      { role: "assistant", chunks: [{ type: "text", text: "reply" }] },
    ]);

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const constructCalls: Array<{
      conversationId: string;
      cwd: string;
      model: string | undefined;
    }> = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      resolveSystemPrompt: () =>
        createFakeSystemPromptService(
          async (conversationId, cwd, context) => {
            constructCalls.push({ conversationId, cwd, model: context?.model });
            return "RECONSTRUCTED_PROMPT";
          },
          async () => ({ prompt: null, cwd: null, computerId: null }),
        ),
    });

    await orchestrator.handleMessage({
      conversationId: "conv-sp-null",
      text: "second",
      onEvent: () => {},
      cwd: "/work/dir",
      modelName: "my-model",
    });

    expect(constructCalls).toHaveLength(1);
    expect(constructCalls[0]?.conversationId).toBe("conv-sp-null");
    expect(constructCalls[0]?.cwd).toBe("/work/dir");
    expect(constructCalls[0]?.model).toBe("my-model");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.systemPrompt).toBe("RECONSTRUCTED_PROMPT");
  });

  it("Subsequent turn: stored cwd ≠ effective cwd → calls construct with new cwd (prompt rebuilt)", async () => {
    const store = createInMemoryStore();
    await store.append("conv-sp-cwd-change", [
      { role: "user", chunks: [{ type: "text", text: "first" }] },
      { role: "assistant", chunks: [{ type: "text", text: "reply" }] },
    ]);

    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const constructCalls: Array<{
      conversationId: string;
      cwd: string;
      model: string | undefined;
    }> = [];
    const getWithMetaCalls: string[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      resolveSystemPrompt: () =>
        createFakeSystemPromptService(
          async (conversationId, cwd, context) => {
            constructCalls.push({ conversationId, cwd, model: context?.model });
            return "REBUILT_PROMPT";
          },
          async (conversationId) => {
            getWithMetaCalls.push(conversationId);
            // Stored prompt was built against an OLD cwd.
            return { prompt: "STALE_PROMPT", cwd: "/old/dir", computerId: null };
          },
        ),
    });

    await orchestrator.handleMessage({
      conversationId: "conv-sp-cwd-change",
      text: "second",
      onEvent: () => {},
      // Current turn's effective cwd differs from the stored cwd.
      cwd: "/new/dir",
      modelName: "my-model",
    });

    expect(getWithMetaCalls).toHaveLength(1);
    expect(getWithMetaCalls[0]).toBe("conv-sp-cwd-change");

    expect(constructCalls).toHaveLength(1);
    expect(constructCalls[0]?.conversationId).toBe("conv-sp-cwd-change");
    expect(constructCalls[0]?.cwd).toBe("/new/dir");
    expect(constructCalls[0]?.model).toBe("my-model");

    expect(captured).toHaveLength(1);
    // The rebuilt prompt is used — NOT the stale cached one.
    expect(captured[0]?.providerOpts?.systemPrompt).toBe("REBUILT_PROMPT");
  });

  it("Service unavailable: no system prompt — resolveSystemPrompt is undefined → providerOpts.systemPrompt is NOT set", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      // resolveSystemPrompt omitted entirely
    });

    await orchestrator.handleMessage({
      conversationId: "conv-sp-none",
      text: "hi",
      onEvent: () => {},
      cwd: "/work",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.providerOpts?.systemPrompt).toBeUndefined();
  });
});

describe("title (summon-title): deferred until after workspace initialization", () => {
  // Regression: an earlier implementation set the title in the HTTP /chat
  // route BEFORE the turn started, which pre-created the conversation meta
  // and made the orchestrator's `meta === null` newness check falsely report
  // an EXISTING conversation — so ensureWorkspace / setWorkspaceId / the
  // first-turn system-prompt construct were ALL skipped. The fix defers the
  // title set into workspaceSetupPromise, AFTER the newness check + workspace
  // assignment, so a titled new conversation is still initialized correctly.

  /** Wrap the in-memory store to record the ORDER of init-relevant calls. */
  function createCallRecordingStore() {
    const base = createInMemoryStore();
    const calls: string[] = [];
    const titleCalls: { conversationId: string; title: string }[] = [];
    return {
      store: {
        ...base,
        async getConversationMeta(conversationId: string) {
          calls.push(`getMeta:${conversationId}`);
          return base.getConversationMeta(conversationId);
        },
        async ensureWorkspace(id: string) {
          calls.push(`ensureWorkspace:${id}`);
          return base.ensureWorkspace(id);
        },
        async setWorkspaceId(conversationId: string, workspaceId: string) {
          calls.push(`setWorkspaceId:${workspaceId}`);
          await base.setWorkspaceId(conversationId, workspaceId);
        },
        async setConversationTitle(conversationId: string, title: string) {
          calls.push(`setTitle:${title}`);
          titleCalls.push({ conversationId, title });
          await base.setConversationTitle(conversationId, title);
        },
      } as ConversationStore,
      calls,
      titleCalls,
    };
  }

  it("titled new conversation: workspace assigned, system prompt constructed, title set", async () => {
    const { store, calls, titleCalls } = createCallRecordingStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();
    const constructCalls: string[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      resolveSystemPrompt: () =>
        createFakeSystemPromptService(async (conversationId) => {
          constructCalls.push(conversationId);
          return "CONSTRUCTED_PROMPT";
        }),
    });

    await orchestrator.handleMessage({
      conversationId: "conv-title-new",
      text: "hi",
      onEvent: () => {},
      title: "My Task",
      workspaceId: "my-workspace",
    });

    // The bug: workspace init was skipped. It must NOT be.
    expect(calls).toContain("ensureWorkspace:my-workspace");
    expect(calls).toContain("setWorkspaceId:my-workspace");
    // First-turn system prompt construct runs (proves isNewConversation was
    // true — the newness check was not fooled by a pre-created meta).
    expect(constructCalls).toEqual(["conv-title-new"]);
    // The title is persisted.
    expect(titleCalls).toEqual([{ conversationId: "conv-title-new", title: "My Task" }]);
  });

  it("title is set AFTER the newness check + workspace assignment (order)", async () => {
    const { store, calls } = createCallRecordingStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-title-order",
      text: "hi",
      onEvent: () => {},
      title: "Ordered",
    });

    const getMetaIdx = calls.findIndex((c) => c.startsWith("getMeta:"));
    const ensureIdx = calls.findIndex((c) => c.startsWith("ensureWorkspace:"));
    const setWsIdx = calls.findIndex((c) => c.startsWith("setWorkspaceId:"));
    const setTitleIdx = calls.findIndex((c) => c.startsWith("setTitle:"));
    expect(getMetaIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeGreaterThan(getMetaIdx);
    expect(setWsIdx).toBeGreaterThan(ensureIdx);
    expect(setTitleIdx).toBeGreaterThan(setWsIdx);
  });

  it("no title: setConversationTitle is not called", async () => {
    const { store, calls } = createCallRecordingStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-no-title",
      text: "hi",
      onEvent: () => {},
    });

    expect(calls.some((c) => c.startsWith("setTitle:"))).toBe(false);
  });

  it("existing conversation with a title: workspace NOT re-assigned, title still set", async () => {
    const { store, calls, titleCalls } = createCallRecordingStore();
    // Seed an existing conversation (meta non-null, workspace already set).
    await store.setWorkspaceId("conv-title-existing", "prior-workspace");
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-title-existing",
      text: "hi",
      onEvent: () => {},
      title: "Renamed",
    });

    // Existing conversation: workspace init must not run again.
    expect(calls.some((c) => c.startsWith("ensureWorkspace:"))).toBe(false);
    // But the title is still applied (rename on an existing conversation).
    expect(titleCalls).toEqual([{ conversationId: "conv-title-existing", title: "Renamed" }]);
  });

  it("turn still completes if setConversationTitle throws", async () => {
    const base = createInMemoryStore();
    const store: ConversationStore = {
      ...base,
      async setConversationTitle() {
        throw new Error("title store unavailable");
      },
    };
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-title-throws",
      text: "hi",
      onEvent: () => {},
      title: "Resilient",
    });

    // The turn ran despite the title-set failure.
    expect(captured).toHaveLength(1);
  });
});

describe("system prompt: compaction flow", () => {
  function seedHistory(
    store: ReturnType<typeof createInMemoryStore>,
    conversationId: string,
    count: number,
  ): void {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < count; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        chunks: [{ type: "text", text: `message ${i}` }],
      });
    }
    store.data.set(conversationId, messages);
  }

  it("Compaction: construct + append — compaction flow calls construct → result appended with COMPACTION_SYSTEM_PROMPT → combined string set as systemPrompt", async () => {
    const store = createConversationStore(storageFromMap());
    await store.append(
      "conv-compact-sp",
      Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        chunks: [{ type: "text", text: `message ${i}` }],
      })),
    );
    // Start above epoch zero to catch a hard-coded/default broadcast value.
    await store.replaceHistory("conv-compact-sp", await store.load("conv-compact-sp"));
    const compactedEvents: ConversationCompactedPayload[] = [];

    const constructCalls: Array<{
      conversationId: string;
      cwd: string;
      model: string | undefined;
    }> = [];

    let capturedSystemPrompt: string | undefined;
    const provider: ProviderContract = {
      id: "compaction-provider",
      stream(_messages, _tools, opts) {
        capturedSystemPrompt = opts?.systemPrompt;
        return (async function* () {
          yield { type: "text-delta", delta: "Summary text" } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    const compactionService = createCompactionService(
      {
        conversationStore: store,
        resolveProvider: () => provider,
        resolveTools: () => [],
        applyToolsFilter: identityApplyToolsFilter,
        runTurn,
        resolveSystemPrompt: () =>
          createFakeSystemPromptService(async (conversationId, cwd, context) => {
            constructCalls.push({ conversationId, cwd, model: context?.model });
            return "RECONSTRUCTED_PROMPT";
          }),
        emit: (hook, payload) => {
          if (hook === conversationCompacted)
            compactedEvents.push(payload as ConversationCompactedPayload);
        },
      },
      new Set(),
    );

    const result = await compactionService.compact("conv-compact-sp", {
      modelName: "compaction-model",
    });

    expect("summary" in result).toBe(true);
    expect(compactedEvents).toHaveLength(1);
    expect(compactedEvents[0]?.historyEpoch).toBe(2);
    expect(await store.getHistoryEpoch("conv-compact-sp")).toBe(2);
    expect(constructCalls).toHaveLength(1);
    expect(constructCalls[0]?.conversationId).toBe("conv-compact-sp");
    expect(constructCalls[0]?.model).toBe("compaction-model");

    // The system prompt sent to the provider must be the constructed prompt
    // appended with the COMPACTION_SYSTEM_PROMPT.
    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt?.startsWith("RECONSTRUCTED_PROMPT\n\n")).toBe(true);
    expect(capturedSystemPrompt).toContain("conversation summarizer");
  });

  it("Compaction: fallback when service unavailable — compaction flow with no service → COMPACTION_SYSTEM_PROMPT alone", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-compact-nosp", 15);

    let capturedSystemPrompt: string | undefined;
    const provider: ProviderContract = {
      id: "compaction-provider",
      stream(_messages, _tools, opts) {
        capturedSystemPrompt = opts?.systemPrompt;
        return (async function* () {
          yield { type: "text-delta", delta: "Summary text" } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    const compactionService = createCompactionService(
      {
        conversationStore: store,
        resolveProvider: () => provider,
        resolveTools: () => [],
        applyToolsFilter: identityApplyToolsFilter,
        runTurn,
        // resolveSystemPrompt omitted — service unavailable
        emit: () => {},
      },
      new Set(),
    );

    const result = await compactionService.compact("conv-compact-nosp", {
      modelName: "compaction-model",
    });

    expect("summary" in result).toBe(true);
    expect(capturedSystemPrompt).toBeDefined();
    // Must be the COMPACTION_SYSTEM_PROMPT alone — no constructed prefix.
    expect(capturedSystemPrompt).toContain("conversation summarizer");
    expect(capturedSystemPrompt?.startsWith("RECONSTRUCTED")).toBe(false);
  });
});

describe("in-flight compaction", () => {
  // Seeds a conversation with `count` alternating user/assistant text messages
  // so the history is long enough to compact (> DEFAULT_KEEP_LAST_N = 10).
  function seedHistory(
    store: ReturnType<typeof createInMemoryStore>,
    conversationId: string,
    count: number,
  ): void {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < count; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        chunks: [{ type: "text", text: `seed message ${i}` }],
      });
    }
    store.data.set(conversationId, messages);
  }

  // A provider whose `stream` serves a SCRIPT of per-call event lists, in
  // order. Captures the messages passed to each call so a test can assert what
  // the model saw at each step (incl. after in-flight compaction replaced it).
  function createScriptedCapturingProvider(script: ProviderEvent[][]): {
    provider: ProviderContract;
    capturedMessages: ChatMessage[][];
  } {
    const capturedMessages: ChatMessage[][] = [];
    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream(messages) {
        capturedMessages.push([...messages]);
        const events = script[callIndex] ?? [];
        callIndex++;
        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      },
    };
    return { provider, capturedMessages };
  }

  function echoTool(): ToolContract {
    return {
      name: "echo",
      description: "echo",
      parameters: { type: "object" },
      execute: async () => ({ content: "echoed" }),
    };
  }

  it("triggers when a step's usage exceeds the threshold: history is compacted mid-turn and the prompt continues with the summary", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-inflight", 15); // > keepLastN(10) → compactable

    // contextWindow 1000, default percent 85 → threshold 850.
    // Step 0 emits a tool call + usage(inputTokens 900) → 910 > 850 → trigger.
    // Then the compaction summary call, then step 1 ends the turn.
    const { provider, capturedMessages } = createScriptedCapturingProvider([
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } },
        { type: "finish", reason: "tool-calls" },
      ],
      // Compaction summary call (performCompaction):
      [
        { type: "text-delta", delta: "COMPACTED SUMMARY" },
        { type: "finish", reason: "stop" },
      ],
      // Step 1 (post-compaction) — the turn CONTINUES:
      [
        { type: "text-delta", delta: "all done" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const compactedEvents: ConversationCompactedPayload[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      emit: (hook, payload) => {
        if (hook === conversationCompacted) {
          compactedEvents.push(payload as ConversationCompactedPayload);
        }
      },
    });

    const { events, onEvent } = collectEvents();

    await orchestrator.handleMessage({
      conversationId: "conv-inflight",
      text: "keep working overnight",
      onEvent,
      modelName: "test/model",
    });

    // 1) The conversationCompacted event fired mid-turn.
    expect(compactedEvents).toHaveLength(1);
    expect(compactedEvents[0]?.conversationId).toBe("conv-inflight");
    expect(compactedEvents[0]?.messagesSummarized).toBeGreaterThan(0);
    expect(compactedEvents[0]?.messagesKept).toBe(10);

    // 2) The store history was replaced: it now begins with the system summary
    //    message, and the OLDEST seed messages are gone (summarized). The most
    //    recent messages are retained (keepLastN = 10), so some later seed
    //    messages may survive — that is correct.
    const stored = store.data.get("conv-inflight") ?? [];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]?.role).toBe("system");
    expect(stored[0]?.chunks[0]).toMatchObject({ type: "text" });
    const firstText = (stored[0]?.chunks[0] as { text: string } | undefined)?.text ?? "";
    expect(firstText).toContain("COMPACTED SUMMARY");
    // The earliest seed messages were summarized away (not retained).
    expect(
      stored.some((m) => m.chunks.some((c) => c.type === "text" && c.text === "seed message 0")),
    ).toBe(false);

    // 3) The turn CONTINUED after compaction: 3 provider calls happened
    //    (step 0, compaction summary, step 1) and the final assistant text
    //    was produced + persisted.
    expect(capturedMessages).toHaveLength(3);
    const step1Messages = capturedMessages[2] ?? [];
    // Step 1 saw the COMPACTED history: it must start with the summary
    // system message, NOT the original seed/user prefix.
    expect(step1Messages[0]?.role).toBe("system");

    const turnSealed = events.some((e) => e.type === "turn-sealed");
    expect(turnSealed).toBe(true);
  });

  it("does NOT trigger when the step usage is below the threshold (history unchanged, no event)", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-below", 15);

    // contextWindow 1000 → threshold 850. Step usage 100 < 850 → no trigger.
    const { provider, capturedMessages } = createScriptedCapturingProvider([
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 5 } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", delta: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const compactedEvents: ConversationCompactedPayload[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      emit: (hook, payload) => {
        if (hook === conversationCompacted) {
          compactedEvents.push(payload as ConversationCompactedPayload);
        }
      },
    });

    await orchestrator.handleMessage({
      conversationId: "conv-below",
      text: "hi",
      onEvent: () => {},
      modelName: "test/model",
    });

    // No compaction event, and only 2 provider calls (no summary call).
    expect(compactedEvents).toHaveLength(0);
    expect(capturedMessages).toHaveLength(2);
    // The seed messages are still the start of history (uncompacted).
    const stored = store.data.get("conv-below") ?? [];
    expect(stored[0]?.chunks[0]).toMatchObject({ type: "text", text: "seed message 0" });
  });

  it("does NOT trigger when auto-compact is disabled (compact percent = 0)", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-disabled", 15);
    await store.setCompactPercent("conv-disabled", 0);

    // Usage would exceed the default threshold, but percent=0 disables it.
    const { provider, capturedMessages } = createScriptedCapturingProvider([
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "usage", usage: { inputTokens: 950, outputTokens: 10 } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", delta: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const compactedEvents: ConversationCompactedPayload[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      emit: (hook, payload) => {
        if (hook === conversationCompacted) {
          compactedEvents.push(payload as ConversationCompactedPayload);
        }
      },
    });

    await orchestrator.handleMessage({
      conversationId: "conv-disabled",
      text: "hi",
      onEvent: () => {},
      modelName: "test/model",
    });

    expect(compactedEvents).toHaveLength(0);
    expect(capturedMessages).toHaveLength(2);
  });

  it("does NOT trigger on a text-only turn (no tool calls → no next step → no boundary)", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-textonly", 15);

    // Single text-only step with high usage — but no tool calls → the turn
    // ends → there is no step boundary to compact at (post-seal handles it).
    const { provider, capturedMessages } = createScriptedCapturingProvider([
      [
        { type: "text-delta", delta: "final answer" },
        { type: "usage", usage: { inputTokens: 950, outputTokens: 10 } },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const compactedEvents: ConversationCompactedPayload[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      emit: (hook, payload) => {
        if (hook === conversationCompacted) {
          compactedEvents.push(payload as ConversationCompactedPayload);
        }
      },
    });

    await orchestrator.handleMessage({
      conversationId: "conv-textonly",
      text: "hi",
      onEvent: () => {},
      modelName: "test/model",
    });

    // No in-flight compaction (only 1 provider call — the turn ended).
    expect(compactedEvents).toHaveLength(0);
    expect(capturedMessages).toHaveLength(1);
  });

  it("the manual compaction SERVICE still refuses while a conversation is generating, but in-flight compaction runs anyway", async () => {
    // This documents the two-path design: compact() (the service) guards on
    // activeConversations and refuses mid-turn; the in-flight path bypasses
    // that guard (it IS the mid-turn path) using performCompaction directly.
    const store = createInMemoryStore();
    seedHistory(store, "conv-twopath", 15);

    const { provider } = createScriptedCapturingProvider([
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", delta: "SUMMARY" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", delta: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const compactedEvents: ConversationCompactedPayload[] = [];
    const activeConversations = new Set<string>();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      emit: (hook, payload) => {
        if (hook === conversationCompacted) {
          compactedEvents.push(payload as ConversationCompactedPayload);
        }
      },
    });

    // The compaction SERVICE shares the orchestrator's activeConversations set;
    // build it against the SAME set so the guard reflects reality.
    const compactionService = createCompactionService(
      {
        conversationStore: store,
        resolveProvider: () => provider,
        resolveTools: () => [],
        applyToolsFilter: identityApplyToolsFilter,
        runTurn,
        emit: () => {},
      },
      activeConversations,
    );

    // Drive a turn that triggers in-flight compaction. We can't easily inspect
    // activeConversations mid-turn, so we assert the observable contract:
    // in-flight compaction produced an event (it ran WHILE active), and the
    // store was compacted.
    await orchestrator.handleMessage({
      conversationId: "conv-twopath",
      text: "hi",
      onEvent: () => {},
      modelName: "test/model",
    });

    expect(compactedEvents).toHaveLength(1);
    const stored = store.data.get("conv-twopath") ?? [];
    expect(stored[0]?.role).toBe("system");

    // After the turn settles (idle), the manual service CAN compact (no longer
    // active) — and it succeeds (history is compactable again only if long
    // enough; here it is short post-compaction, so it reports too-short, which
    // proves the service path is reachable and its guard is the ONLY reason it
    // would have refused mid-turn).
    const manual = await compactionService.compact("conv-twopath");
    // Post-compaction the history is short (summary + ~10 + turn tail) → the
    // service reports an error (too short / threshold), NOT "generating".
    expect("error" in manual).toBe(true);
    if ("error" in manual) {
      expect(manual.error).not.toBe("conversation is generating");
    }
  });

  it("steering messages are persisted and survive in-flight compaction — the store and the LLM's context stay aligned (Bug A + B)", async () => {
    // Regression test for the two critical bugs:
    //  A) drainSteering injected steering into the kernel's in-memory messages
    //     but never persisted it → the user could never see it, and
    //     compaction (loading the store) scrubbed it.
    //  B) compaction sliced the store and the kernel's messages independently;
    //     the unpersisted steering offset the slices → DB and LLM dropped
    //     DIFFERENT messages (structural divergence).
    // Fix: drainSteering persists (awaited); compaction uses the kernel's LIVE
    // messages array, so the store write and the kernel's replacement use the
    // SAME recent slice → aligned, and the steering is retained.
    const store = createInMemoryStore();
    seedHistory(store, "conv-align", 15); // > keepLastN(10) → compactable
    const queue = createMessageQueueService({
      id: () => `q-${Math.random().toString(36).slice(2, 8)}`,
      now: () => 1000,
      notify: () => {},
    });
    queue.enqueue("conv-align", "STEER MID-TURN"); // drained at step 0's boundary

    // contextWindow 1000, percent 85 → threshold 850. Step 0 usage 900 → fire.
    const { provider, capturedMessages } = createScriptedCapturingProvider([
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } },
        { type: "finish", reason: "tool-calls" },
      ],
      // Compaction summary call:
      [
        { type: "text-delta", delta: "ALIGN SUMMARY" },
        { type: "finish", reason: "stop" },
      ],
      // Step 1 (post-compaction) — the turn continues:
      [
        { type: "text-delta", delta: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const compactedEvents: ConversationCompactedPayload[] = [];

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      resolveQueue: () => queue,
      runTurn,
      emit: (hook, payload) => {
        if (hook === conversationCompacted) {
          compactedEvents.push(payload as ConversationCompactedPayload);
        }
      },
    });

    await orchestrator.handleMessage({
      conversationId: "conv-align",
      text: "keep working overnight",
      onEvent: () => {},
      modelName: "test/model",
    });

    // Bug A: the steering message was PERSISTED to the store (the user CAN see
    // it). It is either retained in the kept recent slice or captured in the
    // summary; either way it must be present in the store, not lost.
    expect(compactedEvents).toHaveLength(1);
    const stored = store.data.get("conv-align") ?? [];
    // The compacted history begins with the summary system message.
    expect(stored[0]?.role).toBe("system");
    expect((stored[0]?.chunks[0] as { text?: string } | undefined)?.text).toContain(
      "ALIGN SUMMARY",
    );
    // The steering message survived in the kept recent slice (it was the most
    // recent user message before compaction, so it is within keepLastN=10).
    const storedSteering = stored.find(
      (m) =>
        m.role === "user" && m.chunks.some((c) => c.type === "text" && c.text === "STEER MID-TURN"),
    );
    expect(storedSteering).toBeDefined();

    // Bug B: the store and the LLM's context are ALIGNED. The provider's
    // post-compaction call (captured[2]) is the kernel's working history AFTER
    // compaction replaced it. The store was written with the SAME compacted
    // history, then step 1's assistant output was appended on top. So the
    // kernel's view (captured[2]) must be an exact PREFIX of the store — same
    // summary, same recent slice, same steering at the same index. (Before the
    // fix, the store dropped the steering while the kernel kept it, so the two
    // diverged structurally.)
    const step1Messages = capturedMessages[2] ?? [];
    expect(step1Messages[0]?.role).toBe("system"); // summary heads both
    const kernelSteering = step1Messages.find(
      (m) =>
        m.role === "user" && m.chunks.some((c) => c.type === "text" && c.text === "STEER MID-TURN"),
    );
    expect(kernelSteering).toBeDefined();
    // The kernel's post-compaction history is an exact PREFIX of the store
    // (the store then has step 1's appended assistant output after it). Same
    // length, same roles in order, same steering index => structural alignment.
    expect(stored.length).toBeGreaterThanOrEqual(step1Messages.length);
    const storePrefix = stored.slice(0, step1Messages.length);
    expect(storePrefix).toHaveLength(step1Messages.length);
    for (let i = 0; i < step1Messages.length; i++) {
      expect(storePrefix[i]?.role).toBe(step1Messages[i]?.role);
    }
    const storeSteerIdx = storePrefix.findIndex(
      (m) =>
        m.role === "user" && m.chunks.some((c) => c.type === "text" && c.text === "STEER MID-TURN"),
    );
    const kernelSteerIdx = step1Messages.findIndex(
      (m) =>
        m.role === "user" && m.chunks.some((c) => c.type === "text" && c.text === "STEER MID-TURN"),
    );
    expect(kernelSteerIdx).toBe(storeSteerIdx);
    expect(kernelSteerIdx).toBeGreaterThanOrEqual(0);
  });

  it("an abort during the compaction summary stream is classified as 'aborted', not 'model produced empty summary', and the turn seals aborted with no terminal error", async () => {
    // B1 regression: when Stop fires during the in-flight compaction summary
    // call BEFORE any summary text is streamed, the empty-summary check used to
    // run first and misreport the deliberate abort as a model failure. The
    // abort check must win so the compaction is classified as cancellation.
    const store = createInMemoryStore();
    seedHistory(store, "conv-abort-compact", 15); // > keepLastN(10) → compactable

    // contextWindow 1000, default percent 85 → threshold 850.
    //   call 1 (step 0): tool-call + usage 900 → 910 > 850 → triggers compaction.
    //   call 2 (compaction summary): hangs forever (never yields) — so Stop's
    //     abortableIteration race wins and summary stays empty.
    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const call = callIndex++;
        if (call === 0) {
          return (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: {},
            } as ProviderEvent;
            yield { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } } as ProviderEvent;
            yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
          })();
        }
        // Compaction summary call — never settles its next().
        return (async function* () {
          yield new Promise<never>(() => {}) as unknown as ProviderEvent;
        })();
      },
    };

    const records: LogRecord[] = [];
    const logDeps: LogDeps = { now: () => 2000, newId: () => `id-${records.length}` };
    const sink: LogSink = { emit: (r) => records.push(r) };
    const logger = createLogger({ extensionId: "session-orchestrator" }, sink, logDeps);

    const terminalEvents: AgentEvent[] = [];
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      logger,
      emit: () => {},
    });

    // Start the turn; it runs detached (async). Wait for step 0 to finish and
    // the compaction summary hang to begin, then Stop.
    const turnPromise = orchestrator.handleMessage({
      conversationId: "conv-abort-compact",
      text: "hi",
      onEvent: (e) => {
        if (e.type === "done" || e.type === "error" || e.type === "turn-sealed") {
          terminalEvents.push(e);
        }
      },
      modelName: "test/model",
    });

    // Let step 0 + the compaction summary call start (first two provider calls),
    // then abort the turn.
    await new Promise((resolve) => setTimeout(resolve, 25));
    orchestrator.stopTurn("conv-abort-compact");

    await turnPromise;

    // The compaction was classified as an abort, not "model produced empty
    // summary" (B1 fix), and the turn sealed with exactly one aborted done and
    // no spurious terminal error.
    const skipRecords = records.filter(
      (r) => r.kind === "log" && r.msg === "compaction:in-flight:skipped",
    );
    expect(skipRecords.length).toBeGreaterThanOrEqual(1);
    for (const r of skipRecords) {
      const attributes = (r as Extract<LogRecord, { kind: "log" }>).attributes ?? {};
      expect(attributes.error).toBe("aborted");
    }
    expect(
      skipRecords.some(
        (r) =>
          (r as Extract<LogRecord, { kind: "log" }>).attributes?.error ===
          "model produced empty summary",
      ),
    ).toBe(false);

    const abortedDones = terminalEvents.filter((e) => e.type === "done" && e.reason === "aborted");
    expect(abortedDones).toHaveLength(1);
    expect(terminalEvents.some((e) => e.type === "error")).toBe(false);
    // No history replacement happened (compaction aborted before fork/replace).
    const stored = store.data.get("conv-abort-compact") ?? [];
    expect(
      stored.some(
        (m) =>
          m.role === "system" &&
          m.chunks.some(
            (c) => c.type === "text" && String(c.text).startsWith("The following is a summary"),
          ),
      ),
    ).toBe(false);
  });

  it("an abort BETWEEN forkHistory and replaceHistory orphans the archive but leaves the LIVE history unchanged, with no next provider step", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-boundary", 15); // > keepLastN(10) → compactable

    // Step 0 → tool-call + usage 900 → 910 > 850 → triggers compaction.
    // Compaction summary call yields text → SUMMARY built.
    // forkHistory runs, and INSIDE it we abort the turn (controller.abort()),
    // so the post-forkHistory signal check sees aborted and skips replaceHistory.
    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const call = callIndex++;
        if (call === 0) {
          return (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: {},
            } as ProviderEvent;
            yield { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } } as ProviderEvent;
            yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
          })();
        }
        // Compaction summary call.
        return (async function* () {
          yield {
            type: "text-delta",
            delta: "The following is a summary of earlier messages.",
          } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    // Abort the turn once forkHistory settles (simulating Stop landing exactly
    // at the forkHistory→replaceHistory commit boundary).
    const originalFork = store.forkHistory.bind(store);
    let abortedDuringFork = false;
    store.forkHistory = async (sourceId, targetId) => {
      await originalFork(sourceId, targetId);
      if (orchestratorRef !== null) {
        orchestratorRef.stopTurn("conv-boundary");
        abortedDuringFork = true;
      }
    };

    const terminalEvents: AgentEvent[] = [];
    let orchestratorRef: ReturnType<typeof createSessionOrchestrator>["orchestrator"] | null = null;
    const bootstrap = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      logger: undefined,
      emit: () => {},
    });
    orchestratorRef = bootstrap.orchestrator;

    const turnPromise = bootstrap.orchestrator.handleMessage({
      conversationId: "conv-boundary",
      text: "hi",
      onEvent: (e) => {
        if (e.type === "done" || e.type === "error") terminalEvents.push(e);
      },
      modelName: "test/model",
    });

    await turnPromise;

    expect(abortedDuringFork).toBe(true);
    // The turn sealed aborted with no spurious terminal error.
    expect(terminalEvents.filter((e) => e.type === "done" && e.reason === "aborted")).toHaveLength(
      1,
    );
    expect(terminalEvents.some((e) => e.type === "error")).toBe(false);

    // The LIVE conversation history must be UNCHANGED (no system summary was
    // injected) because replaceHistory was skipped after the abort.
    const stored = store.data.get("conv-boundary") ?? [];
    expect(
      stored.some(
        (m) =>
          m.role === "system" &&
          m.chunks.some(
            (c) => c.type === "text" && String(c.text).startsWith("The following is a summary"),
          ),
      ),
    ).toBe(false);
    // The compaction must NOT have dropped the seed messages: everything before
    // the summary-marker must still be present (the turn only injected the user
    // message + step-0 tool result, not a replacement summary system message).
    expect(
      stored.filter((m) =>
        m.chunks.some((c) => c.type === "text" && String(c.text).startsWith("seed message")),
      ),
    ).toHaveLength(15);
  });

  it("an abort AFTER replaceHistory commits lets the durable write settle but starts no next provider step", async () => {
    const store = createInMemoryStore();
    seedHistory(store, "conv-boundary2", 15); // > keepLastN(10) → compactable

    let callIndex = 0;
    const provider: ProviderContract = {
      id: "fake",
      stream() {
        const call = callIndex++;
        if (call === 0) {
          return (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: {},
            } as ProviderEvent;
            yield { type: "usage", usage: { inputTokens: 900, outputTokens: 10 } } as ProviderEvent;
            yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
          })();
        }
        // Compaction summary call.
        return (async function* () {
          yield {
            type: "text-delta",
            delta: "The following is a summary of earlier messages.",
          } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };

    // Instrument replaceHistory to abort the turn AFTER the durable write has
    // finished, so the commit settles but no further provider step starts.
    const originalReplace = store.replaceHistory.bind(store);
    let abortedDuringReplace = false;
    store.replaceHistory = async (conversationId, messages) => {
      await originalReplace(conversationId, messages);
      if (orchestratorRef !== null) {
        orchestratorRef.stopTurn("conv-boundary2");
        abortedDuringReplace = true;
      }
    };

    let providerCallCount = 0;
    const wrappingProvider: ProviderContract = {
      id: "fake",
      stream(messages, tools, opts) {
        providerCallCount++;
        return provider.stream(messages, tools, opts);
      },
    };

    const terminalEvents: AgentEvent[] = [];
    let orchestratorRef: ReturnType<typeof createSessionOrchestrator>["orchestrator"] | null = null;
    const bootstrap = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => wrappingProvider,
      resolveTools: () => [echoTool()],
      applyToolsFilter: identityApplyToolsFilter,
      resolveModel: () => ({ provider: wrappingProvider, model: "model" }),
      resolveModelInfo: async () => ({ id: "test/model", contextWindow: 1000 }),
      runTurn,
      logger: undefined,
      emit: () => {},
    });
    orchestratorRef = bootstrap.orchestrator;

    const turnPromise = bootstrap.orchestrator.handleMessage({
      conversationId: "conv-boundary2",
      text: "hi",
      onEvent: (e) => {
        if (e.type === "done" || e.type === "error") terminalEvents.push(e);
      },
      modelName: "test/model",
    });

    await turnPromise;

    expect(abortedDuringReplace).toBe(true);
    expect(terminalEvents.filter((e) => e.type === "done" && e.reason === "aborted")).toHaveLength(
      1,
    );
    expect(terminalEvents.some((e) => e.type === "error")).toBe(false);
    // The durable replaceHistory write settled: the summary WAS committed.
    const stored = store.data.get("conv-boundary2") ?? [];
    expect(
      stored.some(
        (m) =>
          m.role === "system" &&
          m.chunks.some(
            (c) => c.type === "text" && String(c.text).startsWith("The following is a summary"),
          ),
      ),
    ).toBe(true);
    // No NEXT provider step started after the compaction (call 0 = step 0,
    // call 1 = compaction summary; a step 1 would have been call 2).
    expect(providerCallCount).toBe(2);
  });
});

describe("instant-stop end-to-end abort semantics", () => {
  // A provider whose first event is a text-delta, then its next() never settles
  // (simulates a hanging provider that ignores the signal) — so Stop must win
  // via the kernel's consumer-side abort barrier.
  function hangingAfterFirstProvider(): ProviderContract {
    return {
      id: "fake",
      stream() {
        let first = true;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                first
                  ? new Promise<IteratorResult<ProviderEvent>>((resolve) => {
                      first = false;
                      setTimeout(() => {
                        resolve({
                          done: false,
                          value: { type: "text-delta", delta: "partial" } as ProviderEvent,
                        });
                      }, 1);
                    })
                  : new Promise<IteratorResult<ProviderEvent>>(() => {}), // hangs forever
              return: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };
      },
    };
  }

  it("done(aborted) arrives AFTER all prior text-delta events, and no error event is emitted", async () => {
    const store = createInMemoryStore();
    const provider = hangingAfterFirstProvider();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: runTurn,
      emit: () => {},
    });

    const received: string[] = [];
    const turnPromise = orchestrator.handleMessage({
      conversationId: "conv-order",
      text: "hi",
      onEvent: (e) => {
        if (e.type === "text-delta") received.push("text-delta");
        if (e.type === "error") received.push("error");
        if (e.type === "done") received.push(`done:${e.reason}`);
        if (e.type === "turn-sealed") received.push("turn-sealed");
      },
    });

    // Wait for the first text-delta + the hanging second next() to begin, then Stop.
    await new Promise((resolve) => setTimeout(resolve, 15));
    orchestrator.stopTurn("conv-order");
    await turnPromise;

    // No terminal error on deliberate abort.
    expect(received.includes("error")).toBe(false);
    // Exactly one aborted done.
    expect(received.filter((r) => r === "done:aborted")).toHaveLength(1);
    // The done(aborted) must come after every text-delta (FIFO ordering).
    const lastDelta = received.lastIndexOf("text-delta");
    const doneIdx = received.indexOf("done:aborted");
    expect(doneIdx).toBeGreaterThan(lastDelta);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
  });

  it("repeated Stop remains harmless (exactly one aborted done, one seal)", async () => {
    const store = createInMemoryStore();
    const provider = hangingAfterFirstProvider();
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: runTurn,
      emit: () => {},
    });

    const received: string[] = [];
    const turnPromise = orchestrator.handleMessage({
      conversationId: "conv-repeat",
      text: "hi",
      onEvent: (e) => {
        if (e.type === "done") received.push(`done:${e.reason}`);
        if (e.type === "turn-sealed") received.push("turn-sealed");
        if (e.type === "error") received.push("error");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    orchestrator.stopTurn("conv-repeat");
    orchestrator.stopTurn("conv-repeat"); // second stop is a no-op
    orchestrator.stopTurn("conv-repeat");
    await turnPromise;

    expect(received.filter((r) => r === "done:aborted")).toHaveLength(1);
    expect(received.filter((r) => r === "turn-sealed")).toHaveLength(1);
    expect(received.filter((r) => r === "error")).toHaveLength(0);
  });
});

describe("per-turn memory telemetry", () => {
  function capturingLogger(): { logger: Logger; records: LogRecord[] } {
    let id = 0;
    const deps: LogDeps = { now: () => 1000 + id++, newId: () => `id-${id++}` };
    const records: LogRecord[] = [];
    const sink: LogSink = { emit: (r) => records.push(r) };
    return { logger: createLogger({ extensionId: "session-orchestrator" }, sink, deps), records };
  }

  it("logs before/after samples around the stream, tagged with conversationId + turnId", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captured, captureRunTurn } = createCapturingRunTurn();
    const { logger, records } = capturingLogger();

    const samples: MemorySample[] = [
      { rss: 100, heapUsed: 10, heapTotal: 20, external: 1, arrayBuffers: 0 },
      { rss: 250, heapUsed: 30, heapTotal: 20, external: 1, arrayBuffers: 5 },
    ];
    let sampleIdx = 0;

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      logger,
      sampleMemory: () => samples[sampleIdx++] as MemorySample,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-mem",
      text: "hi",
      onEvent: () => {},
    });

    expect(captured).toHaveLength(1);
    const beforeLogs = records.filter((r) => r.kind === "log" && r.msg === "memory:turn:before");
    const afterLogs = records.filter((r) => r.kind === "log" && r.msg === "memory:turn:after");
    expect(beforeLogs).toHaveLength(1);
    expect(afterLogs).toHaveLength(1);

    // Both samples carry the turn's conversationId + turnId correlation.
    const turnId = captured[0]?.turnId;
    expect(turnId).toMatch(/^turn-/);
    const before = beforeLogs[0] as Extract<LogRecord, { kind: "log" }>;
    const after = afterLogs[0] as Extract<LogRecord, { kind: "log" }>;
    expect(before.conversationId).toBe("conv-mem");
    expect(before.turnId).toBe(turnId);
    expect(after.conversationId).toBe("conv-mem");
    expect(after.turnId).toBe(turnId);

    // Before sample carries absolute MB values.
    expect(before.attributes?.rssMB).toBe(0); // 100 bytes rounds to 0 MB
    // After sample carries absolute + delta (delta rss = 150 bytes → 0 MB).
    expect(after.attributes?.rssMB).toBe(0);
    // deltaRssMB is the rounded delta (150 bytes → 0 MB).
    expect(after.attributes).toHaveProperty("deltaRssMB");
  });

  it("emits no memory logs when sampleMemory is not injected (degrades off)", async () => {
    const store = createInMemoryStore();
    const provider: ProviderContract = { id: "p", stream: async function* () {} };
    const { captureRunTurn } = createCapturingRunTurn();
    const { logger, records } = capturingLogger();

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: captureRunTurn,
      logger,
      // sampleMemory intentionally omitted
    });

    await orchestrator.handleMessage({
      conversationId: "conv-no-mem",
      text: "hi",
      onEvent: () => {},
    });

    const memLogs = records.filter(
      (r) => r.kind === "log" && typeof r.msg === "string" && r.msg.startsWith("memory:turn"),
    );
    expect(memLogs).toHaveLength(0);
  });

  it("getActiveConversationCount tracks in-flight turns", async () => {
    const store = createInMemoryStore();
    const result: RunTurnResult = {
      messages: [{ role: "assistant", chunks: [{ type: "text", text: "ok" }] }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    };
    // A runTurn that blocks until the test releases it — keeps the turn
    // active so getActiveConversationCount reflects an in-flight turn.
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockingRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
      await blocked;
      return result;
    };

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => ({ id: "p", stream: async function* () {} }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn: blockingRunTurn,
    });

    expect(orchestrator.getActiveConversationCount()).toBe(0);
    const done = orchestrator.handleMessage({
      conversationId: "conv-active",
      text: "hi",
      onEvent: () => {},
    });
    // Give the detached turn a tick to register as active.
    await Promise.resolve();
    await Promise.resolve();
    expect(orchestrator.getActiveConversationCount()).toBe(1);

    release();
    await done;
    expect(orchestrator.getActiveConversationCount()).toBe(0);
  });
});

describe("vision handoff effective image limit (model image cap)", () => {
  interface CapturedPrepareOpts {
    imageLimit?: number;
  }

  function fakeVisionHandoff(captured: CapturedPrepareOpts[]): VisionHandoffService {
    return {
      storeImages: async (_conversationId, images) => images,
      purgeConversationImages: async () => {},
      prepareForProvider: async (messages, _modelName, opts) => {
        captured.push({ imageLimit: opts?.imageLimit });
        return messages;
      },
    };
  }

  async function runImageTurn(opts: {
    globalLimit: number;
    modelMaxImages?: number;
    withImage?: boolean;
  }): Promise<{ captured: CapturedPrepareOpts[]; modelInfoCalls: number }> {
    const store = createInMemoryStore();
    store.getVisionSettings = async () => ({
      imageLimit: opts.globalLimit,
      compactionModel: null,
    });
    const captured: CapturedPrepareOpts[] = [];
    let modelInfoCalls = 0;

    const provider = createFakeProvider([
      [
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      resolveVisionHandoff: () => fakeVisionHandoff(captured),
      resolveModelInfo: async () => {
        modelInfoCalls++;
        return {
          id: "umans/test-model",
          ...(opts.modelMaxImages !== undefined ? { maxImages: opts.modelMaxImages } : {}),
        };
      },
      runTurn,
    });

    await orchestrator.handleMessage({
      conversationId: "conv-vision-cap",
      text: "look",
      ...(opts.withImage !== false ? { images: [{ url: "data:image/png;base64,AAAA" }] } : {}),
      modelName: "umans/test-model",
      onEvent: () => {},
    });

    return { captured, modelInfoCalls };
  }

  it("clamps the global limit down to a model-reported maxImages", async () => {
    const { captured } = await runImageTurn({ globalLimit: 10, modelMaxImages: 4 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.imageLimit).toBe(4);
  });

  it("keeps the global limit when the model reports no cap", async () => {
    const { captured } = await runImageTurn({ globalLimit: 10 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.imageLimit).toBe(10);
  });

  it("keeps the LOWER global limit when it is below the model cap", async () => {
    const { captured } = await runImageTurn({ globalLimit: 3, modelMaxImages: 8 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.imageLimit).toBe(3);
  });

  it("uses the model cap when the global limit is disabled (0)", async () => {
    const { captured } = await runImageTurn({ globalLimit: 0, modelMaxImages: 8 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.imageLimit).toBe(8);
  });

  it("does not resolve model info for a text-only turn", async () => {
    const { modelInfoCalls } = await runImageTurn({
      globalLimit: 10,
      modelMaxImages: 4,
      withImage: false,
    });

    expect(modelInfoCalls).toBe(0);
  });
});

describe("terminal turn-ended", () => {
  it.each([
    "sealed",
    "provider-error",
    "thrown",
    "setup",
    "unknown",
    "unavailable",
    "aborted",
  ])("emits exactly one terminal event after persistence/error for %s", async (path) => {
    const store = createConversationStore(storageFromMap());
    const provider: ProviderContract = {
      id: "terminal-test",
      async *stream() {
        if (path === "aborted") {
          orchestrator.stopTurn("terminal");
          orchestrator.stopTurn("terminal");
        }
        if (path === "provider-error") yield { type: "error", message: "provider failed" };
        else yield { type: "finish", reason: "stop" };
      },
    };
    const { orchestrator, activeConversations } = createSessionOrchestrator({
      conversationStore: {
        ...store,
        ...(path === "thrown"
          ? {
              load: async () => {
                throw new Error("load failed");
              },
            }
          : {}),
        ...(path === "setup"
          ? {
              getEffectiveCwd: async () => {
                throw new Error("setup failed");
              },
            }
          : {}),
      },
      resolveProvider: () => provider,
      resolveModel: () => (path === "unknown" ? undefined : { provider, model: "test" }),
      resolveVisionHandoff: () => ({
        storeImages: async () => [{ url: "/images/terminal/image.png", mediaType: "image/png" }],
        prepareForProvider: async (messages) => messages,
        purgeConversationImages: async () => {},
      }),
      resolveModelUsability: async () => {
        if (path === "unknown" || path === "unavailable") {
          expect((await store.load("terminal"))[0]?.chunks).toEqual([
            { type: "text", text: "go" },
            { type: "image", url: "/images/terminal/image.png" },
          ]);
        }
        return path !== "unavailable";
      },
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    const events: AgentEvent[] = [];
    await orchestrator.handleMessage({
      conversationId: "terminal",
      text: "go",
      images: [{ url: "data:image/png;base64,AAAA", mediaType: "image/png" }],
      modelName: "test/model",
      onEvent: (event) => events.push(event),
    });
    const reason =
      path === "unknown" || path === "unavailable"
        ? "rejected"
        : path === "sealed" || path === "aborted"
          ? path
          : "error";
    expect(events.filter((event) => event.type === "turn-ended")).toEqual([
      { type: "turn-ended", conversationId: "terminal", turnId: events[0]?.turnId, reason },
    ]);
    expect(events.at(-1)?.type).toBe("turn-ended");
    if (reason === "rejected") {
      expect(await store.load("terminal")).toEqual([
        {
          role: "user",
          chunks: [
            { type: "text", text: "go" },
            { type: "image", url: "/images/terminal/image.png" },
          ],
        },
      ]);
    }
    expect(events.some((event) => event.type === "error")).toBe(
      reason === "error" || reason === "rejected",
    );
    expect(events.some((event) => event.type === "turn-sealed")).toBe(
      ["sealed", "aborted", "provider-error"].includes(path),
    );
    expect(orchestrator.isActive("terminal")).toBe(false);
    expect(activeConversations.size).toBe(0);
  });
});

// Step 4.5: real store/queue/kernel integration at failure boundaries.
describe("turn failure durability and queue policy", () => {
  it.each([
    "provider-error",
    "thrown",
    "rejected",
  ])("carries queued input after %s", async (path) => {
    const store = createConversationStore(storageFromMap());
    const queue = createMessageQueueService({ id: () => "q", now: () => 0, notify: () => {} });
    let calls = 0;
    const provider: ProviderContract = {
      id: "failure",
      async *stream() {
        if (path === "provider-error" && calls === 1) {
          orchestrator.enqueue({ conversationId: "carry", text: "queued" });
          yield { type: "error", message: "failed" };
        } else yield { type: "finish", reason: "stop" };
      },
    };
    const { orchestrator, activeConversations } = createSessionOrchestrator({
      conversationStore: store,
      resolveQueue: () => queue,
      resolveProvider: () => {
        calls++;
        if (path === "thrown" && calls === 1) {
          orchestrator.enqueue({ conversationId: "carry", text: "queued" });
          throw new Error("failed");
        }
        return provider;
      },
      resolveModel: () => {
        orchestrator.enqueue({ conversationId: "carry", text: "queued" });
        return undefined;
      },
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    const ended: AgentEvent[] = [];
    const completed = new Promise<void>((resolve) =>
      orchestrator.subscribe("carry", (event) => {
        if (event.type === "turn-ended") {
          ended.push(event);
          if (ended.length === 2) resolve();
        }
      }),
    );
    orchestrator.startTurn({
      conversationId: "carry",
      text: "original",
      ...(path === "rejected" ? { modelName: "invalid/model" } : {}),
    });
    await completed;
    expect(ended.map((event) => event.type === "turn-ended" && event.reason)).toEqual([
      path === "rejected" ? "rejected" : "error",
      "sealed",
    ]);
    expect(
      (await store.load("carry"))
        .filter((message) => message.role === "user")
        .map((message) => message.chunks),
    ).toEqual([[{ type: "text", text: "original" }], [{ type: "text", text: "queued" }]]);
    expect(queue.getQueue("carry")).toEqual([]);
    expect(activeConversations.size).toBe(0);
  });

  it.each([
    "stop",
    "close",
  ])("%s applies its queue policy to existing and abort-window input", async (operation) => {
    const store = createConversationStore(storageFromMap());
    const snapshots: number[] = [];
    const queue = createMessageQueueService({
      id: () => "q",
      now: () => 0,
      notify: () => snapshots.push(queue.getQueue("cancel").length),
    });
    let calls = 0;
    const events: AgentEvent[] = [];
    const provider: ProviderContract = {
      id: "cancel",
      async *stream() {
        if (++calls === 1) {
          await orchestrator.enqueue({ conversationId: "cancel", text: "cancel one" });
          await orchestrator.enqueue({ conversationId: "cancel", text: "cancel two" });
          if (operation === "close") orchestrator.closeConversation("cancel");
          else orchestrator.stopTurn("cancel");
          orchestrator.stopTurn("cancel");
          const racing = await orchestrator.enqueue({ conversationId: "cancel", text: "racing" });
          expect(racing.startedTurn).toBe(false);
          expect(racing.queue.map((message) => message.text)).toEqual(
            operation === "close" ? [] : ["cancel one", "cancel two", "racing"],
          );
        }
        yield { type: "finish", reason: "stop" };
      },
    };
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveQueue: () => queue,
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    const allEvents: AgentEvent[] = [];
    const completed = new Promise<void>((resolve) =>
      orchestrator.subscribe("cancel", (event) => {
        allEvents.push(event);
        if (
          allEvents.filter((item) => item.type === "turn-ended").length ===
          (operation === "close" ? 1 : 2)
        )
          resolve();
      }),
    );
    await orchestrator.handleMessage({
      conversationId: "cancel",
      text: "original",
      onEvent: (event) => events.push(event),
    });
    await completed;
    expect(calls).toBe(operation === "close" ? 1 : 2);
    expect(
      allEvents.filter((event) => event.type === "user-message").map((event) => event.text),
    ).toEqual(
      operation === "close" ? ["original"] : ["original", "cancel one\n\ncancel two\n\nracing"],
    );
    if (operation === "stop") {
      const terminal = allEvents.findIndex((event) => event.type === "turn-ended");
      const carried = allEvents.findIndex(
        (event) => event.type === "user-message" && event.text !== "original",
      );
      expect(terminal).toBeLessThan(carried);
      expect(
        allEvents.filter((event) => event.type === "turn-ended").map((event) => event.reason),
      ).toEqual(["aborted", "sealed"]);
    }
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", reason: "aborted" });
    expect(events.some((event) => event.type === "steering")).toBe(false);
    expect(snapshots).toEqual(operation === "close" ? [1, 2, 0] : [1, 2, 3, 0]);
    await orchestrator.handleMessage({
      conversationId: "cancel",
      text: "explicit next",
      onEvent: () => {},
    });
    expect((await store.load("cancel")).flatMap((message) => message.chunks)).toEqual([
      { type: "text", text: "original" },
      ...(operation === "stop"
        ? [{ type: "text", text: "cancel one\n\ncancel two\n\nracing" }]
        : []),
      { type: "text", text: "explicit next" },
    ]);
  });
});

describe("persisted workspace and background failures", () => {
  it("uses workspace X for initial and carried prompt construction and concurrency admission", async () => {
    const store = createConversationStore(storageFromMap());
    const prompt = createSystemPromptService({
      storage: storageFromMap(),
      adapters: {
        spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        fs: { readText: async () => "", exists: async () => false },
      },
    });
    await prompt.setTemplate("[prompt:workspace_id]");
    const queue = createMessageQueueService({ id: () => "q", now: () => 0, notify: () => {} });
    const workspaces: string[] = [];
    const prompts: string[] = [];
    const provider: ProviderContract = {
      id: "workspace",
      async *stream(_messages, _tools, opts) {
        prompts.push(opts?.systemPrompt ?? "missing");
        if (prompts.length === 1) {
          await store.setCwd("workspace", "/changed-cwd");
          orchestrator.enqueue({ conversationId: "workspace", text: "carried" });
        }
        yield { type: "finish", reason: "stop" };
      },
    };
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: store,
      resolveProvider: () => provider,
      resolveQueue: () => queue,
      resolveSystemPrompt: () => prompt,
      resolveConcurrencyLimiter: () => ({
        acquire: async (_provider, _conversation, workspace) => {
          workspaces.push(workspace);
          return () => {};
        },
        reportRateLimit: () => {},
      }),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
    });
    let ends = 0;
    const completed = new Promise<void>((resolve) =>
      orchestrator.subscribe("workspace", (event) => {
        if (event.type === "turn-ended" && ++ends === 2) resolve();
      }),
    );
    orchestrator.startTurn({
      conversationId: "workspace",
      text: "first",
      workspaceId: "X",
      cwd: "/initial-cwd",
    });
    await completed;
    expect(workspaces).toEqual(["X", "X"]);
    expect(prompts).toEqual(["X", "X"]);
    expect((await prompt.getWithMeta("workspace")).cwd).toBe("/changed-cwd");
  });

  it("logs rejected background work but preserves images on close", async () => {
    const store = createConversationStore(storageFromMap());
    const records: LogRecord[] = [];
    const logger = createLogger(
      { extensionId: "session-orchestrator" },
      { emit: (record) => records.push(record) },
      { now: () => 0, newId: () => "log" },
    );
    const fail = async (): Promise<never> => {
      throw new Error("background failure");
    };
    let closing = false;
    let purges = 0;
    const { orchestrator } = createSessionOrchestrator({
      conversationStore: {
        ...store,
        setConversationStatus: fail,
        getWorkspaceId: async (id) => (closing ? fail() : store.getWorkspaceId(id)),
      },
      resolveProvider: () => createFakeProvider([[{ type: "finish", reason: "stop" }]]),
      resolveTools: () => [],
      applyToolsFilter: identityApplyToolsFilter,
      runTurn,
      logger,
      resolveCompaction: () => ({ compact: fail }),
      resolveVisionHandoff: () => ({
        storeImages: async (_id, images) => images,
        prepareForProvider: async (messages) => messages,
        purgeConversationImages: async () => {
          purges++;
        },
      }),
    });
    await orchestrator.handleMessage({
      conversationId: "background",
      text: "go",
      onEvent: () => {},
    });
    // Flush nested best-effort branches, including the post-terminal settled hook.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    closing = true;
    orchestrator.closeConversation("background");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(purges).toBe(0);
    for (const operation of [
      "set active status",
      "set idle status",
      "set closed status",
      "closed workspace",
      "auto-compaction",
    ]) {
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: "log",
          level: "debug",
          conversationId: "background",
          msg: `orchestrator: ${operation} failed`,
          attributes: { error: "background failure" },
        }),
      );
    }
  });
});
