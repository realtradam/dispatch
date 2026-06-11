import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	EventHookDescriptor,
	ProviderContract,
	ProviderEvent,
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
} {
	const data = new Map<string, ChatMessage[]>();
	const metricsData = new Map<string, TurnMetrics[]>();
	return {
		data,
		metricsData,
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

	it("passes abort signal through to runTurn", async () => {
		const store = createInMemoryStore();
		const ac = new AbortController();
		ac.abort();

		const provider = createFakeProvider([
			[
				{ type: "text-delta", delta: "should not appear" },
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

		await orchestrator.handleMessage({
			conversationId: "conv-abort",
			text: "test",
			onEvent: () => {},
			signal: ac.signal,
		});

		const stored = store.data.get("conv-abort");
		expect(stored).toBeDefined();
		expect(stored).toHaveLength(1);
		expect(stored?.[0]?.role).toBe("user");
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
		expect(captured[0]?.providerOpts).toEqual({ model: "gpt-4" });
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
		expect(captured[0]?.providerOpts).toBeUndefined();
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

		expect(ordering).toEqual(["append", "appendMetrics", "turn-sealed"]);
	});

	it("does not emit turn-sealed when append throws", async () => {
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
		};

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: failingStore,
			resolveProvider: () => provider,
			resolveTools: () => [],
			applyToolsFilter: identityApplyToolsFilter,
			runTurn,
		});

		const { events, onEvent } = collectEvents();

		await expect(
			orchestrator.handleMessage({
				conversationId: "conv-fail",
				text: "test",
				onEvent,
			}),
		).rejects.toThrow("storage failure");

		const sealedEvents = events.filter((e) => e.type === "turn-sealed");
		expect(sealedEvents).toHaveLength(0);
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
		};

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: failingMetricsStore,
			resolveProvider: () => provider,
			resolveTools: () => [],
			applyToolsFilter: identityApplyToolsFilter,
			runTurn,
		});

		const { events, onEvent } = collectEvents();

		await expect(
			orchestrator.handleMessage({
				conversationId: "conv-fail-metrics",
				text: "test",
				onEvent,
			}),
		).rejects.toThrow("storage failure");

		const sealedEvents = events.filter((e) => e.type === "turn-sealed");
		expect(sealedEvents).toHaveLength(0);
		expect(metricsAppended).toBe(false);
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

		expect(emitted).toHaveLength(2);
		expect(emitted[0]?.hook).toBe("session-orchestrator/turn-started");
		expect(emitted[0]?.payload.conversationId).toBe("conv-lifecycle");
		expect(emitted[0]?.payload.cwd).toBe("/work");
		expect(emitted[0]?.payload.modelName).toBe("mymodel");
		expect(emitted[0]?.order).toBe(0);

		expect(emitted[1]?.hook).toBe("session-orchestrator/turn-settled");
		expect(emitted[1]?.payload.conversationId).toBe("conv-lifecycle");
		expect(emitted[1]?.payload.cwd).toBe("/work");
		expect(emitted[1]?.payload.modelName).toBe("mymodel");
		expect(emitted[1]?.order).toBe(1);
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
