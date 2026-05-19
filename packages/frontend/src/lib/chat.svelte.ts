import { config } from "./config.js";
import type { AgentEvent, ChatMessage, DebugInfo, ToolCallDisplay } from "./types.js";
import { wsClient } from "./ws.svelte.js";

function generateId() {
	return Math.random().toString(36).slice(2, 11);
}

function makeDebugInfo(overrides: Partial<DebugInfo> = {}): DebugInfo {
	return {
		timestamp: new Date().toISOString(),
		model: "deepseek-v4-flash",
		apiBase: config.apiBase,
		connectionStatus: wsClient.connectionStatus,
		...overrides,
	};
}

function formatConversation(msgs: ChatMessage[]): string {
	const lines: string[] = [];
	lines.push("=== Dispatch Conversation ===");
	lines.push(`Exported: ${new Date().toISOString()}`);
	lines.push("");

	for (const msg of msgs) {
		const role = msg.role === "user" ? "User" : "Assistant";
		lines.push(`--- ${role} ---`);
		lines.push(msg.content);

		if (msg.toolCalls && msg.toolCalls.length > 0) {
			for (const tc of msg.toolCalls) {
				lines.push(`  [Tool: ${tc.name}]`);
				lines.push(`  Args: ${JSON.stringify(tc.arguments)}`);
				if (tc.result !== undefined) {
					const prefix = tc.isError ? "  Error: " : "  Result: ";
					lines.push(`${prefix}${tc.result}`);
				}
			}
		}

		if (msg.debugInfo) {
			lines.push("  [Debug Info]");
			lines.push(`  Timestamp: ${msg.debugInfo.timestamp}`);
			if (msg.debugInfo.error) lines.push(`  Error: ${msg.debugInfo.error}`);
			if (msg.debugInfo.model) lines.push(`  Model: ${msg.debugInfo.model}`);
			if (msg.debugInfo.apiBase) lines.push(`  API Base: ${msg.debugInfo.apiBase}`);
			if (msg.debugInfo.connectionStatus)
				lines.push(`  Connection: ${msg.debugInfo.connectionStatus}`);
			if (msg.debugInfo.agentStatus) lines.push(`  Agent Status: ${msg.debugInfo.agentStatus}`);
			if (msg.debugInfo.httpStatus) lines.push(`  HTTP Status: ${msg.debugInfo.httpStatus}`);
			if (msg.debugInfo.httpBody) lines.push(`  HTTP Body: ${msg.debugInfo.httpBody}`);
			if (msg.debugInfo.rawEvent)
				lines.push(`  Raw Event: ${JSON.stringify(msg.debugInfo.rawEvent)}`);
		}

		lines.push("");
	}

	return lines.join("\n");
}

function createChatStore() {
	let messages: ChatMessage[] = $state([]);
	let agentStatus: "idle" | "running" | "error" = $state("idle");
	let isConnected = $state(false);
	let currentAssistantId: string | null = null;

	wsClient.onEvent((event) => {
		handleEvent(event);
	});

	$effect.root(() => {
		$effect(() => {
			isConnected = wsClient.connectionStatus === "connected";
		});
	});

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
						return {
							...m,
							content: event.message.content,
							isStreaming: false,
						};
					}
					return m;
				});
				currentAssistantId = null;
				break;
			}
			case "error": {
				const errMsg: ChatMessage = {
					id: generateId(),
					role: "assistant",
					content: `Error: ${event.error}`,
					isStreaming: false,
					debugInfo: makeDebugInfo({
						error: event.error,
						agentStatus,
						rawEvent: event,
					}),
				};
				messages = [...messages, errMsg];
				currentAssistantId = null;
				agentStatus = "error";
				break;
			}
		}
	}

	async function sendMessage(text: string) {
		const userMsg: ChatMessage = {
			id: generateId(),
			role: "user",
			content: text,
		};
		messages = [...messages, userMsg];
		currentAssistantId = null;

		const url = `${config.apiBase}/chat`;
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			if (!res.ok) {
				const body = await res.text();
				const errMsg: ChatMessage = {
					id: generateId(),
					role: "assistant",
					content: `Error: Failed to send message (HTTP ${res.status})`,
					isStreaming: false,
					debugInfo: makeDebugInfo({
						error: `POST ${url} returned ${res.status}`,
						agentStatus,
						httpStatus: res.status,
						httpBody: body,
					}),
				};
				messages = [...messages, errMsg];
			}
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const errMsg: ChatMessage = {
				id: generateId(),
				role: "assistant",
				content: "Error: Could not reach the server",
				isStreaming: false,
				debugInfo: makeDebugInfo({
					error: `POST ${url} failed: ${errorText}`,
					agentStatus,
				}),
			};
			messages = [...messages, errMsg];
		}
	}

	function copyConversation(): string {
		return formatConversation(messages);
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
		get isConnected() {
			return isConnected;
		},
		sendMessage,
		handleEvent,
		copyConversation,
		clear,
	};
}

export const chatStore = createChatStore();
