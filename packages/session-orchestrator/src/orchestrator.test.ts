import type { ConversationStore } from "@dispatch/conversation-store";
import type { AgentEvent, ChatMessage, ProviderContract, ProviderEvent } from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createSessionOrchestrator } from "./orchestrator.js";

function createInMemoryStore(): ConversationStore & {
	readonly data: Map<string, ChatMessage[]>;
} {
	const data = new Map<string, ChatMessage[]>();
	return {
		data,
		async append(conversationId, messages) {
			const existing = data.get(conversationId) ?? [];
			data.set(conversationId, [...existing, ...messages]);
		},
		async load(conversationId) {
			return [...(data.get(conversationId) ?? [])];
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

		const orchestrator = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => provider,
			resolveTools: () => [],
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

		const orchestrator = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => provider,
			resolveTools: () => [],
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

		const orchestrator = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => provider,
			resolveTools: () => [],
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

		const orchestrator = createSessionOrchestrator({
			conversationStore: store,
			resolveProvider: () => provider,
			resolveTools: () => [],
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
