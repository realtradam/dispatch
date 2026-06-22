import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	EventHookDescriptor,
	Logger,
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
import { runTurn } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	createSessionOrchestrator,
	createWarmService,
	type TurnLifecyclePayload,
	type WarmCompletedPayload,
} from "./orchestrator.js";
import type { ToolAssembly } from "./tools-filter.js";

function createInMemoryStore(): ConversationStore & {
	readonly data: Map<string, ChatMessage[]>;
	readonly metricsData: Map<string, TurnMetrics[]>;
	readonly cwdData: Map<string, string>;
	readonly effortData: Map<string, ReasoningEffort>;
} {
	const data = new Map<string, ChatMessage[]>();
	const metricsData = new Map<string, TurnMetrics[]>();
	const cwdData = new Map<string, string>();
	const effortData = new Map<string, ReasoningEffort>();
	return {
		data,
		metricsData,
		cwdData,
		effortData,
		async append(conversationId, messages) {
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
		async getReasoningEffort(conversationId) {
			return effortData.get(conversationId) ?? null;
		},
		async setReasoningEffort(conversationId, effort) {
			effortData.set(conversationId, effort);
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
		async getCompactThreshold() {
			return null;
		},
		async setCompactThreshold() {},
		async forkHistory() {},
		async setCompactedFrom() {},
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

	it("uses custom dispatch policy when resolveDispatch is provided", async () => {
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
			resolveDispatch: () => ({ maxConcurrent: 4, eager: false }),
			runTurn,
		});

		await orchestrator.handleMessage({
			conversationId: "conv-dispatch",
			text: "test",
			onEvent: () => {},
		});

		const stored = store.data.get("conv-dispatch");
		expect(stored).toBeDefined();
		expect(stored?.length).toBeGreaterThanOrEqual(1);
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
			async append(conversationId, messages) {
				await store.append(conversationId, messages);
				ordering.push("append");
			},
			async load(conversationId) {
				return store.load(conversationId);
			},
			async loadSince(conversationId, sinceSeq) {
				return store.loadSince(conversationId, sinceSeq);
			},
			async appendMetrics(conversationId, metrics) {
				await store.appendMetrics(conversationId, metrics);
				ordering.push("appendMetrics");
			},
			async loadMetrics(conversationId) {
				return store.loadMetrics(conversationId);
			},
			async getCwd(conversationId) {
				return store.getCwd(conversationId);
			},
			async setCwd(conversationId, cwd) {
				await store.setCwd(conversationId, cwd);
			},
			async getReasoningEffort(conversationId) {
				return store.getReasoningEffort(conversationId);
			},
			async setReasoningEffort(conversationId, effort) {
				await store.setReasoningEffort(conversationId, effort);
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
			async getCompactThreshold() {
				return null;
			},
			async setCompactThreshold() {},
			async forkHistory() {},
			async setCompactedFrom() {},
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
			async getReasoningEffort() {
				return null;
			},
			async setReasoningEffort() {},
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
			async getCompactThreshold() {
				return null;
			},
			async setCompactThreshold() {},
			async forkHistory() {},
			async setCompactedFrom() {},
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
			async getReasoningEffort() {
				return null;
			},
			async setReasoningEffort() {},
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
			async getCompactThreshold() {
				return null;
			},
			async setCompactThreshold() {},
			async forkHistory() {},
			async setCompactedFrom() {},
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

		expect(emitted).toHaveLength(4);
		expect(emitted[0]?.hook).toBe("session-orchestrator/turn-started");
		expect(emitted[0]?.payload.conversationId).toBe("conv-lifecycle");
		expect(emitted[0]?.payload.cwd).toBe("/work");
		expect(emitted[0]?.payload.modelName).toBe("mymodel");
		expect(emitted[0]?.order).toBe(0);

		expect(emitted[1]?.hook).toBe("session-orchestrator/conversation-status-changed");
		expect((emitted[1]?.payload as unknown as { status: string }).status).toBe("active");

		expect(emitted[2]?.hook).toBe("session-orchestrator/turn-settled");
		expect(emitted[2]?.payload.conversationId).toBe("conv-lifecycle");
		expect(emitted[2]?.payload.cwd).toBe("/work");
		expect(emitted[2]?.payload.modelName).toBe("mymodel");

		expect(emitted[3]?.hook).toBe("session-orchestrator/conversation-status-changed");
		expect((emitted[3]?.payload as unknown as { status: string }).status).toBe("idle");
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
		await store.setCwd("conv-warm-cwd", "/home/tradam/projects/roblox");

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
		expect(assemblyCwd).toBe("/home/tradam/projects/roblox");
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
		expect(types[types.length - 1]).toBe("turn-sealed");

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
		expect(types[types.length - 1]).toBe("turn-sealed");
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

		expect(lateEvents.length).toBe(earlySnapshot.length);
		expect(lateEvents).toEqual(earlySnapshot);

		emitBarrierResolve?.();

		const sealed = waitForEvent(orchestrator, "conv-latejoin", "turn-sealed");
		await sealed;

		unsubEarly();
		unsubLate();

		expect(earlyEvents.length).toBeGreaterThan(earlySnapshot.length);
		expect(lateEvents.length).toBe(earlyEvents.length);
		expect(lateEvents).toEqual(earlyEvents);
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

	it("handleMessage convenience — drives turn end-to-end via onEvent and resolves on seal", async () => {
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
		expect(types[types.length - 1]).toBe("turn-sealed");

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

		expect(secondEvents).toHaveLength(1);
		expect(secondEvents[0]?.type).toBe("error");
		expect((secondEvents[0] as AgentEvent & { type: "error" }).message).toBe(
			"turn already active for this conversation",
		);

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

	it("is idempotent on an idle/unknown conversation: abortedTurn false, hook still emitted", () => {
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
		expect(emitted).toEqual([
			{
				hook: "session-orchestrator/conversation-closed",
				payload: { conversationId: "conv-never-seen" },
			},
			{
				hook: "session-orchestrator/conversation-status-changed",
				payload: { conversationId: "conv-never-seen", status: "closed" },
			},
		]);

		// Closing again is still safe.
		expect(orchestrator.closeConversation("conv-never-seen").abortedTurn).toBe(false);
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
