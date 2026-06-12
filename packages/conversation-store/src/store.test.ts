import type {
	ChatMessage,
	Logger,
	Span,
	StepId,
	StorageNamespace,
	TurnMetrics,
} from "@dispatch/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { createConversationStore } from "./store.js";

interface SpanEvent {
	readonly kind: "span-open" | "span-close";
	readonly name: string;
	readonly attrs?: Record<string, string | number | boolean | null> | undefined;
	readonly conversationId?: string | undefined;
}

function createCapturingLogger(): { logger: Logger; events: SpanEvent[] } {
	const events: SpanEvent[] = [];

	function createSpan(name: string, conversationId?: string | undefined): Span {
		events.push({ kind: "span-open", name, conversationId });
		const span: Span = {
			id: `span_${events.length}`,
			log: createFakeLogger(conversationId),
			setAttributes: () => {},
			addLink: () => {},
			child: (childName, attrs) => {
				const child = createSpan(childName, conversationId);
				if (attrs !== undefined) {
					const prev = events[events.length - 1];
					if (prev !== undefined) {
						events[events.length - 1] = {
							...prev,
							attrs: attrs as Record<string, string | number | boolean | null>,
						};
					}
				}
				return child;
			},
			end: (outcome) => {
				const attrs = outcome?.attrs as
					| Record<string, string | number | boolean | null>
					| undefined;
				events.push({ kind: "span-close", name, attrs, conversationId });
			},
		};
		return span;
	}

	function createFakeLogger(conversationId?: string | undefined): Logger {
		return {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			child: (ctx) => createFakeLogger(ctx.conversationId ?? conversationId),
			span: (name, attrs) => {
				const span = createSpan(name, conversationId);
				if (attrs !== undefined) {
					const prev = events[events.length - 1];
					if (prev !== undefined) {
						events[events.length - 1] = {
							...prev,
							attrs: attrs as Record<string, string | number | boolean | null>,
						};
					}
				}
				return span;
			},
		};
	}

	return { logger: createFakeLogger(), events };
}

function createMemoryStorage(): StorageNamespace {
	const data = new Map<string, string>();
	return {
		get: async (key) => data.get(key) ?? null,
		set: async (key, value) => {
			data.set(key, value);
		},
		delete: async (key) => {
			data.delete(key);
		},
		has: async (key) => data.has(key),
		keys: async (prefix) => {
			const all = [...data.keys()];
			if (!prefix) return all;
			return all.filter((k) => k.startsWith(prefix));
		},
	};
}

describe("ConversationStore", () => {
	let storage: StorageNamespace;

	beforeEach(() => {
		storage = createMemoryStorage();
	});

	it("returns empty array for unknown conversation", async () => {
		const store = createConversationStore(storage);
		const result = await store.load("nonexistent");
		expect(result).toEqual([]);
	});

	it("round-trips a single message", async () => {
		const store = createConversationStore(storage);
		const msg: ChatMessage = { role: "user", chunks: [{ type: "text", text: "hello" }] };
		await store.append("conv1", [msg]);
		const result = await store.load("conv1");
		expect(result).toEqual([msg]);
	});

	it("round-trips multiple messages in one append", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hi" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "hello" }] },
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toEqual(messages);
	});

	it("accumulates messages across multiple appends", async () => {
		const store = createConversationStore(storage);
		const turn1: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "turn 1" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "reply 1" }] },
		];
		const turn2: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "turn 2" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "reply 2" }] },
		];
		await store.append("conv1", turn1);
		await store.append("conv1", turn2);
		const result = await store.load("conv1");
		expect(result).toEqual([...turn1, ...turn2]);
	});

	it("preserves message ordering", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push({ role: "user", chunks: [{ type: "text", text: `msg ${i}` }] });
		}
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toEqual(messages);
		for (let i = 0; i < 10; i++) {
			const chunk = result[i]?.chunks[0];
			expect(chunk?.type === "text" ? chunk.text : null).toBe(`msg ${i}`);
		}
	});

	it("isolates conversations by id", async () => {
		const store = createConversationStore(storage);
		const msgA: ChatMessage = { role: "user", chunks: [{ type: "text", text: "A" }] };
		const msgB: ChatMessage = { role: "user", chunks: [{ type: "text", text: "B" }] };
		await store.append("convA", [msgA]);
		await store.append("convB", [msgB]);
		expect(await store.load("convA")).toEqual([msgA]);
		expect(await store.load("convB")).toEqual([msgB]);
	});

	it("reconciles orphaned tool-calls on load", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "do it" }] },
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "someTool",
						input: {},
					},
				],
			},
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toHaveLength(3);
		expect(result[2]?.role).toBe("tool");
		const chunk = result[2]?.chunks[0];
		expect(chunk?.type === "tool-result" ? chunk.isError : null).toBe(true);
	});

	it("handles tool-call/tool-result round-trip", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "readFile",
						input: { path: "/tmp/x" },
					},
				],
			},
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "readFile",
						content: "contents",
						isError: false,
					},
				],
			},
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toEqual(messages);
	});

	it("append assigns gap-free 1-based per-chunk seq", async () => {
		const store = createConversationStore(storage);
		const msg: ChatMessage = {
			role: "assistant",
			chunks: [
				{ type: "text", text: "first" },
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "second" },
			],
		};
		await store.append("conv1", [msg]);
		const chunks = await store.loadSince("conv1");
		expect(chunks).toHaveLength(3);
		expect(chunks[0]?.seq).toBe(1);
		expect(chunks[1]?.seq).toBe(2);
		expect(chunks[2]?.seq).toBe(3);
	});

	it("seq continues monotonically across separate append calls", async () => {
		const store = createConversationStore(storage);
		const msg1: ChatMessage = {
			role: "user",
			chunks: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		};
		const msg2: ChatMessage = {
			role: "assistant",
			chunks: [
				{ type: "text", text: "c" },
				{ type: "text", text: "d" },
				{ type: "text", text: "e" },
			],
		};
		await store.append("conv1", [msg1]);
		await store.append("conv1", [msg2]);
		const chunks = await store.loadSince("conv1");
		expect(chunks).toHaveLength(5);
		expect(chunks[0]?.seq).toBe(1);
		expect(chunks[1]?.seq).toBe(2);
		expect(chunks[2]?.seq).toBe(3);
		expect(chunks[3]?.seq).toBe(4);
		expect(chunks[4]?.seq).toBe(5);
	});

	it("loadSince() returns every StoredChunk ascending by seq, carrying role + chunk", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "world" }] },
		];
		await store.append("conv1", messages);
		const chunks = await store.loadSince("conv1");
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.seq).toBe(1);
		expect(chunks[0]?.role).toBe("user");
		expect(chunks[0]?.chunk).toEqual({ type: "text", text: "hello" });
		expect(chunks[1]?.seq).toBe(2);
		expect(chunks[1]?.role).toBe("assistant");
		expect(chunks[1]?.chunk).toEqual({ type: "text", text: "world" });
	});

	it("loadSince(sinceSeq=N) returns only chunks with seq > N", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "a" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "b" }] },
			{ role: "user", chunks: [{ type: "text", text: "c" }] },
		];
		await store.append("conv1", messages);
		const chunks = await store.loadSince("conv1", 2);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.seq).toBe(3);
		expect(chunks[0]?.role).toBe("user");
		expect(chunks[0]?.chunk).toEqual({ type: "text", text: "c" });
	});

	it("load() round-trips the exact ChatMessage[] that was appended", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "read file" }] },
			{
				role: "assistant",
				chunks: [
					{ type: "thinking", text: "let me think" },
					{ type: "text", text: "I will read it" },
					{
						type: "tool-call",
						toolCallId: "call_rt",
						toolName: "readFile",
						input: { path: "/tmp/x" },
					},
				],
			},
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_rt",
						toolName: "readFile",
						content: "file contents here",
						isError: false,
					},
				],
			},
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toEqual(messages);
	});

	it("load() does not merge consecutive same-role messages", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "first user msg" }] },
			{ role: "user", chunks: [{ type: "text", text: "second user msg" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "reply" }] },
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toHaveLength(3);
		expect(result).toEqual(messages);
		expect(result[0]?.chunks[0]?.type === "text" ? result[0]?.chunks[0]?.text : null).toBe(
			"first user msg",
		);
		expect(result[1]?.chunks[0]?.type === "text" ? result[1]?.chunks[0]?.text : null).toBe(
			"second user msg",
		);
	});

	it("reconcile still synthesizes a result for an interrupted tool-call on load", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "do it" }] },
			{
				role: "assistant",
				chunks: [
					{ type: "text", text: "calling tool" },
					{
						type: "tool-call",
						toolCallId: "call_orphan",
						toolName: "someTool",
						input: { x: 1 },
					},
				],
			},
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toHaveLength(3);
		expect(result[2]?.role).toBe("tool");
		const chunk = result[2]?.chunks[0];
		if (chunk === undefined) throw new Error("expected chunk");
		expect(chunk.type).toBe("tool-result");
		if (chunk.type === "tool-result") {
			expect(chunk.toolCallId).toBe("call_orphan");
			expect(chunk.isError).toBe(true);
			expect(chunk.content).toBe("interrupted: tool execution did not complete");
		}
	});

	it("loadSince returns empty array for unknown conversation", async () => {
		const store = createConversationStore(storage);
		const result = await store.loadSince("nonexistent");
		expect(result).toEqual([]);
	});

	it("loadSince(0) returns all chunks", async () => {
		const store = createConversationStore(storage);
		const msg: ChatMessage = {
			role: "user",
			chunks: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		};
		await store.append("conv1", [msg]);
		const all = await store.loadSince("conv1", 0);
		expect(all).toHaveLength(2);
		expect(all[0]?.seq).toBe(1);
		expect(all[1]?.seq).toBe(2);
	});

	it("append → loadSince preserves a tool chunk's stepId", async () => {
		const store = createConversationStore(storage);
		const stepId = "step_abc" as StepId;
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_sid",
						toolName: "myTool",
						input: {},
						stepId,
					},
				],
			},
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_sid",
						toolName: "myTool",
						content: "ok",
						isError: false,
						stepId,
					},
				],
			},
		];
		await store.append("conv1", messages);
		const chunks = await store.loadSince("conv1");
		expect(chunks).toHaveLength(2);
		const callChunk = chunks[0]?.chunk;
		expect(callChunk?.type).toBe("tool-call");
		if (callChunk?.type === "tool-call") {
			expect(callChunk.stepId).toBe(stepId);
		}
		const resultChunk = chunks[1]?.chunk;
		expect(resultChunk?.type).toBe("tool-result");
		if (resultChunk?.type === "tool-result") {
			expect(resultChunk.stepId).toBe(stepId);
		}
	});

	it("load preserves a tool chunk's stepId", async () => {
		const store = createConversationStore(storage);
		const stepId = "step_xyz" as StepId;
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_lid",
						toolName: "myTool",
						input: { a: 1 },
						stepId,
					},
				],
			},
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_lid",
						toolName: "myTool",
						content: "done",
						isError: false,
						stepId,
					},
				],
			},
		];
		await store.append("conv1", messages);
		const result = await store.load("conv1");
		expect(result).toHaveLength(2);
		const callChunk = result[0]?.chunks[0];
		expect(callChunk?.type).toBe("tool-call");
		if (callChunk?.type === "tool-call") {
			expect(callChunk.stepId).toBe(stepId);
		}
		const resultChunk = result[1]?.chunks[0];
		expect(resultChunk?.type).toBe("tool-result");
		if (resultChunk?.type === "tool-result") {
			expect(resultChunk.stepId).toBe(stepId);
		}
	});
});

describe("ConversationStore loadSince windowing", () => {
	let storage: StorageNamespace;

	beforeEach(() => {
		storage = createMemoryStorage();
	});

	// Append `count` single-chunk user messages so seq runs 1..count, gap-free.
	async function seed(store: ReturnType<typeof createConversationStore>, count: number) {
		const messages: ChatMessage[] = [];
		for (let i = 1; i <= count; i++) {
			messages.push({ role: "user", chunks: [{ type: "text", text: `m${i}` }] });
		}
		await store.append("conv1", messages);
	}

	it("limit returns the newest N of the selection, ascending by seq", async () => {
		const store = createConversationStore(storage);
		await seed(store, 5);
		const chunks = await store.loadSince("conv1", 0, { limit: 2 });
		expect(chunks.map((c) => c.seq)).toEqual([4, 5]);
	});

	it("limit >= selection size returns the whole selection (exact, not truncated)", async () => {
		const store = createConversationStore(storage);
		await seed(store, 3);
		const exactlyAll = await store.loadSince("conv1", 0, { limit: 3 });
		expect(exactlyAll.map((c) => c.seq)).toEqual([1, 2, 3]);
		const overAll = await store.loadSince("conv1", 0, { limit: 99 });
		expect(overAll.map((c) => c.seq)).toEqual([1, 2, 3]);
	});

	it("beforeSeq bounds the selection exclusively (seq < beforeSeq)", async () => {
		const store = createConversationStore(storage);
		await seed(store, 5);
		const chunks = await store.loadSince("conv1", 0, { beforeSeq: 3 });
		expect(chunks.map((c) => c.seq)).toEqual([1, 2]);
	});

	it("sinceSeq + beforeSeq combine to sinceSeq < seq < beforeSeq", async () => {
		const store = createConversationStore(storage);
		await seed(store, 6);
		const chunks = await store.loadSince("conv1", 2, { beforeSeq: 5 });
		expect(chunks.map((c) => c.seq)).toEqual([3, 4]);
	});

	it("beforeSeq + limit: newest N below the bound, ascending (page older history in)", async () => {
		const store = createConversationStore(storage);
		await seed(store, 8);
		const chunks = await store.loadSince("conv1", 0, { beforeSeq: 6, limit: 2 });
		expect(chunks.map((c) => c.seq)).toEqual([4, 5]);
	});

	it("empty selection returns [] (beforeSeq=1, and sinceSeq past the tail)", async () => {
		const store = createConversationStore(storage);
		await seed(store, 4);
		expect(await store.loadSince("conv1", 0, { beforeSeq: 1 })).toEqual([]);
		expect(await store.loadSince("conv1", 4, { limit: 3 })).toEqual([]);
	});

	it("non-positive / non-integer limit and beforeSeq are treated as absent", async () => {
		const store = createConversationStore(storage);
		await seed(store, 4);
		const all = [1, 2, 3, 4];
		expect((await store.loadSince("conv1", 0, { limit: 0 })).map((c) => c.seq)).toEqual(all);
		expect((await store.loadSince("conv1", 0, { limit: -2 })).map((c) => c.seq)).toEqual(all);
		expect((await store.loadSince("conv1", 0, { limit: 1.5 })).map((c) => c.seq)).toEqual(all);
		expect((await store.loadSince("conv1", 0, { beforeSeq: 0 })).map((c) => c.seq)).toEqual(all);
		expect((await store.loadSince("conv1", 0, { beforeSeq: -3 })).map((c) => c.seq)).toEqual(all);
		expect((await store.loadSince("conv1", 0, { beforeSeq: 2.7 })).map((c) => c.seq)).toEqual(all);
	});

	it("window omitted is identical to today's behavior (regression guard)", async () => {
		const store = createConversationStore(storage);
		await seed(store, 5);
		const base = await store.loadSince("conv1", 1);
		const withEmptyWindow = await store.loadSince("conv1", 1, {});
		// A caller whose window fields happen to be undefined (e.g. unset query
		// params) — modelled as an optional-field record, not explicit `undefined`
		// literals (which exactOptionalPropertyTypes rejects on the contract).
		const undefinedFieldsWindow: { beforeSeq?: number; limit?: number } = {};
		const withUndefinedFields = await store.loadSince("conv1", 1, undefinedFieldsWindow);
		expect(base.map((c) => c.seq)).toEqual([2, 3, 4, 5]);
		expect(withEmptyWindow).toEqual(base);
		expect(withUndefinedFields).toEqual(base);
	});
});

describe("ConversationStore metrics", () => {
	let storage: StorageNamespace;

	beforeEach(() => {
		storage = createMemoryStorage();
	});

	it("appendMetrics → loadMetrics round-trips a TurnMetrics (usage + durationMs + steps)", async () => {
		const store = createConversationStore(storage);
		const stepId = "step_1" as StepId;
		const metrics: TurnMetrics = {
			turnId: "turn_abc",
			usage: { inputTokens: 100, outputTokens: 50 },
			durationMs: 1234,
			steps: [
				{
					stepId,
					usage: { inputTokens: 100, outputTokens: 50 },
					ttftMs: 200,
					decodeMs: 800,
					genTotalMs: 1000,
				},
			],
		};
		await store.appendMetrics("conv1", metrics);
		const result = await store.loadMetrics("conv1");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(metrics);
	});

	it("loadMetrics returns turns in append order", async () => {
		const store = createConversationStore(storage);
		const metrics1: TurnMetrics = {
			turnId: "turn_first",
			usage: { inputTokens: 10, outputTokens: 5 },
			steps: [],
		};
		const metrics2: TurnMetrics = {
			turnId: "turn_second",
			usage: { inputTokens: 20, outputTokens: 10 },
			steps: [],
		};
		const metrics3: TurnMetrics = {
			turnId: "turn_third",
			usage: { inputTokens: 30, outputTokens: 15 },
			steps: [],
		};
		await store.appendMetrics("conv1", metrics1);
		await store.appendMetrics("conv1", metrics2);
		await store.appendMetrics("conv1", metrics3);
		const result = await store.loadMetrics("conv1");
		expect(result).toHaveLength(3);
		expect(result[0]?.turnId).toBe("turn_first");
		expect(result[1]?.turnId).toBe("turn_second");
		expect(result[2]?.turnId).toBe("turn_third");
	});

	it("loadMetrics returns [] for a conversation with no persisted metrics", async () => {
		const store = createConversationStore(storage);
		const result = await store.loadMetrics("nonexistent");
		expect(result).toEqual([]);
	});

	it("appendMetrics does not affect chunk load / loadSince", async () => {
		const store = createConversationStore(storage);
		const msg: ChatMessage = { role: "user", chunks: [{ type: "text", text: "hello" }] };
		await store.append("conv1", [msg]);

		const metrics: TurnMetrics = {
			turnId: "turn_iso",
			usage: { inputTokens: 100, outputTokens: 50 },
			steps: [],
		};
		await store.appendMetrics("conv1", metrics);

		const messages = await store.load("conv1");
		expect(messages).toEqual([msg]);

		const chunks = await store.loadSince("conv1");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.chunk).toEqual({ type: "text", text: "hello" });
	});

	it("TurnMetrics with cache tokens + per-step ttft/decode/genTotal round-trips losslessly", async () => {
		const store = createConversationStore(storage);
		const stepId1 = "step_a" as StepId;
		const stepId2 = "step_b" as StepId;
		const metrics: TurnMetrics = {
			turnId: "turn_cache",
			usage: {
				inputTokens: 500,
				outputTokens: 200,
				cacheReadTokens: 300,
				cacheWriteTokens: 100,
			},
			durationMs: 5000,
			steps: [
				{
					stepId: stepId1,
					usage: {
						inputTokens: 300,
						outputTokens: 100,
						cacheReadTokens: 200,
						cacheWriteTokens: 50,
					},
					ttftMs: 150,
					decodeMs: 600,
					genTotalMs: 750,
				},
				{
					stepId: stepId2,
					usage: {
						inputTokens: 200,
						outputTokens: 100,
						cacheReadTokens: 100,
						cacheWriteTokens: 50,
					},
					ttftMs: 100,
					decodeMs: 400,
					genTotalMs: 500,
				},
			],
		};
		await store.appendMetrics("conv1", metrics);
		const result = await store.loadMetrics("conv1");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(metrics);
		expect(result[0]?.usage.cacheReadTokens).toBe(300);
		expect(result[0]?.usage.cacheWriteTokens).toBe(100);
		expect(result[0]?.steps[0]?.ttftMs).toBe(150);
		expect(result[0]?.steps[0]?.decodeMs).toBe(600);
		expect(result[0]?.steps[0]?.genTotalMs).toBe(750);
		expect(result[0]?.steps[1]?.ttftMs).toBe(100);
		expect(result[0]?.steps[1]?.decodeMs).toBe(400);
		expect(result[0]?.steps[1]?.genTotalMs).toBe(500);
	});
});

describe("ConversationStore reconcile.repair span", () => {
	let storage: StorageNamespace;

	beforeEach(() => {
		storage = createMemoryStorage();
	});

	it("load() emits a reconcile.repair span when a dangling tool-call is repaired", async () => {
		const { logger, events } = createCapturingLogger();
		const store = createConversationStore(storage, logger);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "do it" }] },
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_dangle",
						toolName: "someTool",
						input: {},
					},
				],
			},
		];
		await store.append("conv_span", messages);
		await store.load("conv_span");

		const spanOpens = events.filter((e) => e.kind === "span-open" && e.name === "reconcile.repair");
		const spanCloses = events.filter(
			(e) => e.kind === "span-close" && e.name === "reconcile.repair",
		);
		expect(spanOpens).toHaveLength(1);
		expect(spanCloses).toHaveLength(1);
	});

	it("load() emits NO reconcile.repair span when the history is already valid", async () => {
		const { logger, events } = createCapturingLogger();
		const store = createConversationStore(storage, logger);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "hi" }] },
		];
		await store.append("conv_valid", messages);
		await store.load("conv_valid");

		const repairSpans = events.filter((e) => e.name === "reconcile.repair");
		expect(repairSpans).toHaveLength(0);
	});

	it("the reconcile.repair span carries conversationId + a repair count attribute", async () => {
		const { logger, events } = createCapturingLogger();
		const store = createConversationStore(storage, logger);
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_a",
						toolName: "toolA",
						input: {},
					},
					{
						type: "tool-call",
						toolCallId: "call_b",
						toolName: "toolB",
						input: {},
					},
				],
			},
		];
		await store.append("conv_multi", messages);
		await store.load("conv_multi");

		const spanOpen = events.find((e) => e.kind === "span-open" && e.name === "reconcile.repair");
		expect(spanOpen).toBeDefined();
		if (spanOpen === undefined) throw new Error("expected spanOpen");
		expect(spanOpen.conversationId).toBe("conv_multi");
		expect(spanOpen.attrs).toBeDefined();
		if (spanOpen.attrs === undefined) throw new Error("expected attrs");
		expect(spanOpen.attrs.repairedCount).toBe(2);
		expect(spanOpen.attrs.firstRepairedToolCallId).toBe("call_a");
	});

	it("createConversationStore works with the logger omitted (optional)", async () => {
		const store = createConversationStore(storage);
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "do it" }] },
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_nolog",
						toolName: "someTool",
						input: {},
					},
				],
			},
		];
		await store.append("conv_nolog", messages);
		const result = await store.load("conv_nolog");
		expect(result).toHaveLength(3);
		expect(result[2]?.role).toBe("tool");
		const chunk = result[2]?.chunks[0];
		if (chunk === undefined) throw new Error("expected chunk");
		expect(chunk.type).toBe("tool-result");
		if (chunk.type === "tool-result") {
			expect(chunk.toolCallId).toBe("call_nolog");
			expect(chunk.isError).toBe(true);
		}
	});
});

describe("ConversationStore cwd", () => {
	let storage: StorageNamespace;

	beforeEach(() => {
		storage = createMemoryStorage();
	});

	it("setCwd then getCwd returns the value", async () => {
		const store = createConversationStore(storage);
		await store.setCwd("conv1", "/home/user/project");
		const result = await store.getCwd("conv1");
		expect(result).toBe("/home/user/project");
	});

	it("getCwd returns null when never set", async () => {
		const store = createConversationStore(storage);
		const result = await store.getCwd("conv_unknown");
		expect(result).toBeNull();
	});

	it("setCwd is an upsert (second set overwrites)", async () => {
		const store = createConversationStore(storage);
		await store.setCwd("conv1", "/first/path");
		await store.setCwd("conv1", "/second/path");
		const result = await store.getCwd("conv1");
		expect(result).toBe("/second/path");
	});

	it("cwd persists across a fresh store instance on the same db file", async () => {
		const store1 = createConversationStore(storage);
		await store1.setCwd("conv1", "/persisted/path");

		const store2 = createConversationStore(storage);
		const result = await store2.getCwd("conv1");
		expect(result).toBe("/persisted/path");
	});

	it("cwd of one conversation does not leak into another", async () => {
		const store = createConversationStore(storage);
		await store.setCwd("convA", "/path/a");
		await store.setCwd("convB", "/path/b");
		expect(await store.getCwd("convA")).toBe("/path/a");
		expect(await store.getCwd("convB")).toBe("/path/b");
	});
});
