import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/lib/types.js";

// We test the logic inline since runes require svelte compilation context.
// The chat store logic is tested via a plain reimplementation of the same logic.

function generateId() {
	return Math.random().toString(36).slice(2, 11);
}

interface ToolCallDisplay {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	isExpanded: boolean;
}

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	toolCalls?: ToolCallDisplay[];
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
				content: "",
				toolCalls: [],
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
			case "text-delta": {
				ensureCurrentAssistantMessage();
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						return {
							...m,
							content: m.content + event.delta,
							isStreaming: true,
						};
					}
					return m;
				});
				break;
			}
			case "tool-call": {
				ensureCurrentAssistantMessage();
				const toolCall: ToolCallDisplay = {
					id: event.toolCall.id,
					name: event.toolCall.name,
					arguments: event.toolCall.arguments,
					isExpanded: false,
				};
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						return { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] };
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
							toolCalls: (m.toolCalls ?? []).map((tc) => {
								if (tc.id === event.toolResult.toolCallId) {
									return {
										...tc,
										result: event.toolResult.result,
										isError: event.toolResult.isError,
									};
								}
								return tc;
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
						return { ...m, content: event.message.content, isStreaming: false };
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
						content: `Error: ${event.error}`,
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
			content: text,
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
		expect(store.messages[0]?.content).toBe("hello");
	});

	it("text-delta creates a streaming assistant message and appends deltas", () => {
		store.handleEvent({ type: "text-delta", delta: "Hello" });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("assistant");
		expect(store.messages[0]?.content).toBe("Hello");
		expect(store.messages[0]?.isStreaming).toBe(true);

		store.handleEvent({ type: "text-delta", delta: " world" });
		expect(store.messages[0]?.content).toBe("Hello world");
	});

	it("tool-call adds to current assistant message toolCalls", () => {
		store.handleEvent({ type: "text-delta", delta: "Calling tool..." });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "test" } },
		});
		const msg = store.messages[0];
		expect(msg?.toolCalls).toHaveLength(1);
		expect(msg?.toolCalls?.[0]?.name).toBe("search");
		expect(msg?.toolCalls?.[0]?.id).toBe("tc1");
	});

	it("tool-result fills in result on matching tool call", () => {
		store.handleEvent({ type: "text-delta", delta: "..." });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "x" } },
		});
		store.handleEvent({
			type: "tool-result",
			toolResult: { toolCallId: "tc1", result: "found it", isError: false },
		});
		const tc = store.messages[0]?.toolCalls?.[0];
		expect(tc?.result).toBe("found it");
		expect(tc?.isError).toBe(false);
	});

	it("done finalizes the current assistant message", () => {
		store.handleEvent({ type: "text-delta", delta: "partial" });
		store.handleEvent({
			type: "done",
			message: { role: "assistant", content: "full content" },
		});
		expect(store.messages[0]?.content).toBe("full content");
		expect(store.messages[0]?.isStreaming).toBe(false);
	});

	it("error event adds an error message and sets status to error", () => {
		store.handleEvent({ type: "error", error: "something went wrong" });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.content).toBe("Error: something went wrong");
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
});
