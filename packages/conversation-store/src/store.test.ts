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
});
