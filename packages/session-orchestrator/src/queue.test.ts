import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	ProviderContract,
	ProviderEvent,
	ReasoningEffort,
	RunTurnInput,
	RunTurnResult,
	StoredChunk,
	ToolContract,
	TurnMetrics,
} from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import { createMessageQueueService } from "@dispatch/message-queue";
import { describe, expect, it } from "vitest";
import { createSessionOrchestrator } from "./orchestrator.js";
import type { ToolAssembly } from "./tools-filter.js";

// --- Shared test helpers (duplicated from orchestrator.test.ts per isolation-over-dRY;
//     a shared test-helper module wired between test files is a coupling smell) ---

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
	};
}

function identityApplyToolsFilter(assembly: ToolAssembly): Promise<ToolAssembly> {
	return Promise.resolve(assembly);
}

function noTools(): readonly ToolContract[] {
	return [];
}

function simpleProvider(): ProviderContract {
	return {
		id: "fake",
		stream: async function* () {
			yield { type: "text-delta", delta: "ok" } as ProviderEvent;
			yield { type: "finish", reason: "stop" } as ProviderEvent;
		},
	};
}

/**
 * A capturing runTurn that simulates the kernel calling `drainSteering` at the
 * tool-result boundary. It records the RunTurnInput (so the test can assert
 * drainSteering was wired) and collects what drainSteering returned. NOT a mock
 * of @dispatch/* — it's a plain fake of the outermost runTurn edge.
 */
function createDrainingCaptureRunTurn(): {
	captured: RunTurnInput[];
	drainedMessages: ChatMessage[];
	wasDrainCalled: () => boolean;
	runTurn: (input: RunTurnInput) => Promise<RunTurnResult>;
} {
	const captured: RunTurnInput[] = [];
	const drainedMessages: ChatMessage[] = [];
	let drainCalled = false;
	return {
		captured,
		drainedMessages,
		wasDrainCalled: () => drainCalled,
		runTurn: async (input) => {
			captured.push(input);
			if (input.drainSteering !== undefined) {
				drainCalled = true;
				const drained = input.drainSteering();
				drainedMessages.push(...drained);
			}
			return {
				messages: [{ role: "assistant", chunks: [{ type: "text", text: "ok" }] }],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			};
		},
	};
}

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

function waitForSealedCount(
	orchestrator: ReturnType<typeof createSessionOrchestrator>["orchestrator"],
	conversationId: string,
	count: number,
): Promise<void> {
	return new Promise((resolve) => {
		let seen = 0;
		const unsub = orchestrator.subscribe(conversationId, (e) => {
			if (e.type === "turn-sealed") {
				seen++;
				if (seen >= count) {
					unsub();
					resolve();
				}
			}
		});
	});
}

function isSteering(e: AgentEvent): e is Extract<AgentEvent, { type: "steering" }> {
	return e.type === "steering";
}

function isUserMessage(e: AgentEvent): e is Extract<AgentEvent, { type: "user-message" }> {
	return e.type === "user-message";
}

function createTestQueue() {
	return createMessageQueueService({
		id: () => `q-${Math.random().toString(36).slice(2, 8)}`,
		now: () => 1000,
		notify: () => {},
	});
}

// --- drainSteering (mid-turn, at the tool-result boundary) ---

describe("drainSteering", () => {
	it("drainSteering drains the queue + emits a steering event + returns one combined user message", async () => {
		const store = createInMemoryStore();
		const queue = createTestQueue();
		queue.enqueue("conv-drain", "first");
		queue.enqueue("conv-drain", "second");

		const { captured, drainedMessages, runTurn: captureRunTurn } = createDrainingCaptureRunTurn();

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => ({ id: "p", stream: async function* () {} }),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn: captureRunTurn,
			resolveQueue: () => queue,
		});

		const events: AgentEvent[] = [];
		const unsub = orchestrator.subscribe("conv-drain", (e) => events.push(e));

		orchestrator.startTurn({ conversationId: "conv-drain", text: "go" });
		await waitForSealed(orchestrator, "conv-drain");
		unsub();

		// drainSteering was wired on the RunTurnInput
		expect(captured).toHaveLength(1);
		expect(captured[0]?.drainSteering).toBeDefined();
		expect(typeof captured[0]?.drainSteering).toBe("function");

		// The fake runTurn called drainSteering → returned one combined user message
		expect(drainedMessages).toHaveLength(1);
		const steerMsg = drainedMessages[0];
		if (steerMsg === undefined) throw new Error("expected drained message");
		expect(steerMsg.role).toBe("user");
		expect(steerMsg.chunks).toHaveLength(1);
		const chunk = steerMsg.chunks[0];
		if (chunk === undefined) throw new Error("expected chunk");
		expect(chunk.type).toBe("text");
		if (chunk.type === "text") {
			expect(chunk.text).toBe("first\n\nsecond");
		}

		// The queue was drained (cleared)
		expect(queue.getQueue("conv-drain")).toHaveLength(0);

		// A steering event was emitted into the hub with the combined text
		const steering = events.find(isSteering);
		expect(steering).toBeDefined();
		expect(steering?.conversationId).toBe("conv-drain");
		expect(steering?.text).toBe("first\n\nsecond");
		expect(steering?.turnId).toMatch(/^turn-/);
	});

	it("drainSteering on an empty queue returns [] and emits nothing", async () => {
		const store = createInMemoryStore();
		const queue = createTestQueue();

		const {
			drainedMessages,
			wasDrainCalled,
			runTurn: captureRunTurn,
		} = createDrainingCaptureRunTurn();

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => ({ id: "p", stream: async function* () {} }),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn: captureRunTurn,
			resolveQueue: () => queue,
		});

		const events: AgentEvent[] = [];
		const unsub = orchestrator.subscribe("conv-empty", (e) => events.push(e));

		orchestrator.startTurn({ conversationId: "conv-empty", text: "go" });
		await waitForSealed(orchestrator, "conv-empty");
		unsub();

		// drainSteering was wired and called, but returned []
		expect(wasDrainCalled()).toBe(true);
		expect(drainedMessages).toHaveLength(0);

		// No steering event was emitted
		expect(events.filter(isSteering)).toHaveLength(0);
	});

	it("no queue ext (resolveQueue undefined) → drainSteering omitted; turn unchanged", async () => {
		const store = createInMemoryStore();

		const { captured, wasDrainCalled, runTurn: captureRunTurn } = createDrainingCaptureRunTurn();

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => ({ id: "p", stream: async function* () {} }),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn: captureRunTurn,
			// resolveQueue intentionally omitted — feature degrades off
		});

		const events: AgentEvent[] = [];
		const unsub = orchestrator.subscribe("conv-noqueue", (e) => events.push(e));

		orchestrator.startTurn({ conversationId: "conv-noqueue", text: "go" });
		await waitForSealed(orchestrator, "conv-noqueue");
		unsub();

		// drainSteering is absent from the RunTurnInput (not undefined — omitted)
		expect(captured).toHaveLength(1);
		expect(captured[0]?.drainSteering).toBeUndefined();
		expect(wasDrainCalled()).toBe(false);

		// No steering event; turn sealed normally
		expect(events.filter(isSteering)).toHaveLength(0);
		expect(events.filter((e) => e.type === "turn-sealed")).toHaveLength(1);
	});
});

// --- Post-seal carry (turn ended with a non-empty queue → new turn) ---

describe("post-seal carry", () => {
	it("post-seal: non-empty queue → a new turn starts with the combined message", async () => {
		const store = createInMemoryStore();
		const queue = createTestQueue();
		queue.enqueue("conv-carry", "queued-a");
		queue.enqueue("conv-carry", "queued-b");

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => simpleProvider(),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn,
			resolveQueue: () => queue,
		});

		const events: AgentEvent[] = [];
		const unsub = orchestrator.subscribe("conv-carry", (e) => events.push(e));

		orchestrator.startTurn({ conversationId: "conv-carry", text: "original" });
		// Wait for the original turn + the carried turn to both seal.
		await waitForSealedCount(orchestrator, "conv-carry", 2);
		unsub();

		// Two user-message events: the original prompt + the carried combined text.
		const userMessages = events.filter(isUserMessage);
		expect(userMessages).toHaveLength(2);
		expect(userMessages[0]?.text).toBe("original");
		expect(userMessages[1]?.text).toBe("queued-a\n\nqueued-b");

		// No steering event — the carry case emits user-message, not steering.
		expect(events.filter(isSteering)).toHaveLength(0);

		// The queue was drained by the carry.
		expect(queue.getQueue("conv-carry")).toHaveLength(0);

		// Both turns persisted (original + carry).
		expect(store.data.get("conv-carry")?.length).toBeGreaterThanOrEqual(4);
	});

	it("post-seal: empty queue → no new turn", async () => {
		const store = createInMemoryStore();
		const queue = createTestQueue();

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => simpleProvider(),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn,
			resolveQueue: () => queue,
		});

		const events: AgentEvent[] = [];
		const unsub = orchestrator.subscribe("conv-no-carry", (e) => events.push(e));

		orchestrator.startTurn({ conversationId: "conv-no-carry", text: "original" });
		await waitForSealed(orchestrator, "conv-no-carry");
		// Give the carry check a chance to run (it's in the finally, synchronous
		// after turn-sealed, but await yields first).
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		unsub();

		// Only one user-message (the original) — no carry turn.
		expect(events.filter(isUserMessage)).toHaveLength(1);
		expect(events.filter((e) => e.type === "turn-sealed")).toHaveLength(1);
	});
});

// --- enqueue facade (the single entry transports call) ---

describe("enqueue", () => {
	it("enqueue when idle → starts a turn (startedTurn:true)", async () => {
		const store = createInMemoryStore();
		const queue = createTestQueue();

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => simpleProvider(),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn,
			resolveQueue: () => queue,
		});

		const result = orchestrator.enqueue({ conversationId: "conv-idle", text: "hello" });
		expect(result.startedTurn).toBe(true);
		expect(result.queue).toHaveLength(0);

		await waitForSealed(orchestrator, "conv-idle");

		// The turn ran and persisted.
		expect(store.data.get("conv-idle")).toBeDefined();
		expect(store.data.get("conv-idle")?.length).toBeGreaterThanOrEqual(2);
	});

	it("enqueue when active → queues (startedTurn:false, snapshot with the message)", async () => {
		const store = createInMemoryStore();
		const queue = createTestQueue();

		let resolveFirst: (() => void) | undefined;
		const firstBlocker = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		let callCount = 0;
		const blockingFirstRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
			callCount++;
			if (callCount === 1) {
				await firstBlocker;
			}
			return {
				messages: [{ role: "assistant", chunks: [{ type: "text", text: "done" }] }],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			};
		};

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => simpleProvider(),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn: blockingFirstRunTurn,
			resolveQueue: () => queue,
		});

		// Start the original turn (it blocks in runTurn).
		orchestrator.startTurn({ conversationId: "conv-active", text: "first" });
		// Let the turn reach the blocked runTurn call.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// Enqueue while active.
		const result = orchestrator.enqueue({ conversationId: "conv-active", text: "second" });
		expect(result.startedTurn).toBe(false);
		expect(result.queue).toHaveLength(1);
		expect(result.queue[0]?.text).toBe("second");

		// The queue holds the enqueued message.
		expect(queue.getQueue("conv-active")).toHaveLength(1);

		// Release the original turn → it seals → post-seal carry starts a new
		// turn with the enqueued message. Subscribe before releasing to catch
		// both turn-sealed events.
		const sealed = waitForSealedCount(orchestrator, "conv-active", 2);
		resolveFirst?.();
		await sealed;
	});

	it("enqueue when active + no queue ext → startedTurn:false, empty queue (degraded)", async () => {
		const store = createInMemoryStore();

		let resolveFirst: (() => void) | undefined;
		const firstBlocker = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		let callCount = 0;
		const blockingFirstRunTurn = async (_input: RunTurnInput): Promise<RunTurnResult> => {
			callCount++;
			if (callCount === 1) {
				await firstBlocker;
			}
			return {
				messages: [{ role: "assistant", chunks: [{ type: "text", text: "done" }] }],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			};
		};

		const { orchestrator } = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => simpleProvider(),
			resolveTools: noTools,
			applyToolsFilter: identityApplyToolsFilter,
			runTurn: blockingFirstRunTurn,
			// resolveQueue omitted — no queue extension loaded (degraded)
		});

		orchestrator.startTurn({ conversationId: "conv-degraded", text: "first" });
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// Enqueue while active, but no queue ext → message dropped, empty snapshot.
		const result = orchestrator.enqueue({ conversationId: "conv-degraded", text: "second" });
		expect(result.startedTurn).toBe(false);
		expect(result.queue).toHaveLength(0);

		// Release the original turn; no carry (no queue ext).
		const sealed = waitForSealed(orchestrator, "conv-degraded");
		resolveFirst?.();
		await sealed;
	});
});
