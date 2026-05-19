import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ContentSegment } from "../src/lib/types.js";

// We test the logic inline since runes require svelte compilation context.
// The chat store logic is tested via a plain reimplementation of the same logic.

function generateId() {
	return Math.random().toString(36).slice(2, 11);
}

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: ContentSegment[];
	thinking?: string;
	isStreaming?: boolean;
}

// Plain JS version of the chat store logic (no runes) for unit testing
function createTestStore() {
	let messages: ChatMessage[] = [];
	let agentStatus: "idle" | "running" | "error" = "idle";
	let currentAssistantId: string | null = null;

	function getCurrentAssistantMessage(): ChatMessage | null {
		if (!currentAssistantId) return null;
		return messages.find((m) => m.id === currentAssistantId) ?? null;
	}

	function ensureCurrentAssistantMessage(): ChatMessage {
		let msg = getCurrentAssistantMessage();
		if (!msg) {
			const id = generateId();
			currentAssistantId = id;
			const newMsg: ChatMessage = {
				id,
				role: "assistant",
				content: [],
				thinking: "",
				isStreaming: true,
			};
			messages = [...messages, newMsg];
			msg = newMsg;
		}
		return msg;
	}

	function handleEvent(event: AgentEvent) {
		switch (event.type) {
			case "status": {
				agentStatus = event.status;
				if (event.status === "idle" || event.status === "error") {
					currentAssistantId = null;
				}
				break;
			}
			case "reasoning-delta": {
				ensureCurrentAssistantMessage();
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						return { ...m, thinking: (m.thinking ?? "") + event.delta };
					}
					return m;
				});
				break;
			}
			case "text-delta": {
				ensureCurrentAssistantMessage();
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						const segments = [...m.content];
						const last = segments[segments.length - 1];
						if (last && last.type === "text") {
							segments[segments.length - 1] = { ...last, text: last.text + event.delta };
						} else {
							segments.push({ type: "text", text: event.delta });
						}
						return { ...m, content: segments, isStreaming: true };
					}
					return m;
				});
				break;
			}
			case "tool-call": {
				ensureCurrentAssistantMessage();
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						const segments: ContentSegment[] = [
							...m.content,
							{
								type: "tool-call",
								id: event.toolCall.id,
								name: event.toolCall.name,
								arguments: event.toolCall.arguments,
								isExpanded: false,
							},
						];
						return { ...m, content: segments };
					}
					return m;
				});
				break;
			}
			case "tool-result": {
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						return {
							...m,
							content: m.content.map((seg) => {
								if (seg.type === "tool-call" && seg.id === event.toolResult.toolCallId) {
									return { ...seg, result: event.toolResult.result, isError: event.toolResult.isError };
								}
								return seg;
							}),
						};
					}
					return m;
				});
				break;
			}
			case "done": {
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						return { ...m, isStreaming: false };
					}
					return m;
				});
				currentAssistantId = null;
				break;
			}
			case "error": {
				messages = [
					...messages,
					{
						id: generateId(),
						role: "assistant",
						content: [{ type: "text", text: `Error: ${event.error}` }] as ContentSegment[],
						isStreaming: false,
					},
				];
				currentAssistantId = null;
				agentStatus = "error";
				break;
			}
		}
	}

	function sendMessage(text: string) {
		const userMsg: ChatMessage = {
			id: generateId(),
			role: "user",
			content: [{ type: "text", text }],
		};
		messages = [...messages, userMsg];
		currentAssistantId = null;
	}

	function clear() {
		messages = [];
		currentAssistantId = null;
		agentStatus = "idle";
	}

	return {
		get messages() {
			return messages;
		},
		get agentStatus() {
			return agentStatus;
		},
		handleEvent,
		sendMessage,
		clear,
	};
}

describe("chat store logic", () => {
	let store: ReturnType<typeof createTestStore>;

	beforeEach(() => {
		store = createTestStore();
	});

	it("has correct initial state", () => {
		expect(store.messages).toHaveLength(0);
		expect(store.agentStatus).toBe("idle");
	});

	it("sendMessage adds a user message", () => {
		store.sendMessage("hello");
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("user");
		expect(store.messages[0]?.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("text-delta creates a streaming assistant message and appends deltas", () => {
		store.handleEvent({ type: "text-delta", delta: "Hello" });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("assistant");
		expect(store.messages[0]?.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(store.messages[0]?.isStreaming).toBe(true);

		store.handleEvent({ type: "text-delta", delta: " world" });
		expect(store.messages[0]?.content).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("text-delta appends to last text segment in same segment", () => {
		store.handleEvent({ type: "text-delta", delta: "A" });
		store.handleEvent({ type: "text-delta", delta: "B" });
		// Should be one text segment, not two
		expect(store.messages[0]?.content).toHaveLength(1);
		expect(store.messages[0]?.content[0]).toEqual({ type: "text", text: "AB" });
	});

	it("tool-call inserts as a segment after text", () => {
		store.handleEvent({ type: "text-delta", delta: "Calling tool..." });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "test" } },
		});
		const content = store.messages[0]?.content;
		expect(content).toHaveLength(2);
		expect(content?.[0]?.type).toBe("text");
		expect(content?.[1]?.type).toBe("tool-call");
		if (content?.[1]?.type === "tool-call") {
			expect(content[1].name).toBe("search");
			expect(content[1].id).toBe("tc1");
		}
	});

	it("tool-result fills in result on matching tool-call segment", () => {
		store.handleEvent({ type: "text-delta", delta: "..." });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "x" } },
		});
		store.handleEvent({
			type: "tool-result",
			toolResult: { toolCallId: "tc1", result: "found it", isError: false },
		});
		const tc = store.messages[0]?.content[1];
		if (tc?.type === "tool-call") {
			expect(tc.result).toBe("found it");
			expect(tc.isError).toBe(false);
		}
	});

	it("tool-call goes after previous tool-call, preserving both", () => {
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read", arguments: {} },
		});
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc2", name: "write", arguments: {} },
		});
		const content = store.messages[0]?.content;
		expect(content).toHaveLength(2);
		expect(content?.[0]?.type).toBe("tool-call");
		expect(content?.[1]?.type).toBe("tool-call");
	});

	it("text after tool-call creates new text segment", () => {
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read", arguments: {} },
		});
		store.handleEvent({ type: "text-delta", delta: "Result: here" });
		const content = store.messages[0]?.content;
		expect(content).toHaveLength(2);
		expect(content?.[0]?.type).toBe("tool-call");
		expect(content?.[1]).toEqual({ type: "text", text: "Result: here" });
	});

	it("done finalizes the current assistant message", () => {
		store.handleEvent({ type: "text-delta", delta: "partial" });
		store.handleEvent({
			type: "done",
			message: { role: "assistant", content: "full content" },
		});
		expect(store.messages[0]?.content).toEqual([{ type: "text", text: "partial" }]);
		expect(store.messages[0]?.isStreaming).toBe(false);
	});

	it("error event adds an error message and sets status to error", () => {
		store.handleEvent({ type: "error", error: "something went wrong" });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.content).toEqual([{ type: "text", text: "Error: something went wrong" }]);
		expect(store.agentStatus).toBe("error");
	});

	it("status event updates agentStatus", () => {
		store.handleEvent({ type: "status", status: "running" });
		expect(store.agentStatus).toBe("running");
		store.handleEvent({ type: "status", status: "idle" });
		expect(store.agentStatus).toBe("idle");
	});

	it("clear resets all state", () => {
		store.sendMessage("hi");
		store.handleEvent({ type: "text-delta", delta: "hello" });
		store.clear();
		expect(store.messages).toHaveLength(0);
		expect(store.agentStatus).toBe("idle");
	});

	it("reasoning-delta accumulates thinking text on current assistant message", () => {
		store.handleEvent({ type: "reasoning-delta", delta: "First thought." });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("assistant");
		expect(store.messages[0]?.thinking).toBe("First thought.");

		store.handleEvent({ type: "reasoning-delta", delta: " Second thought." });
		expect(store.messages[0]?.thinking).toBe("First thought. Second thought.");
	});
});
