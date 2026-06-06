import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { createConversationStore } from "./store.js";

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
});
