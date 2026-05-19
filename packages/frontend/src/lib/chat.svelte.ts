import { config } from "./config.js";
import type { AgentEvent, ChatMessage, ContentSegment, DebugInfo, LogEntry, PermissionPrompt } from "./types.js";
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

		if (msg.thinking) {
			lines.push(`  [Thinking]: ${msg.thinking}`);
		}

		for (const seg of msg.content) {
			if (seg.type === "text") {
				lines.push(seg.text);
			} else if (seg.type === "tool-call") {
				lines.push(`  [Tool: ${seg.name}]`);
				lines.push(`  Args: ${JSON.stringify(seg.arguments)}`);
				if (seg.result !== undefined) {
					const prefix = seg.isError ? "  Error: " : "  Result: ";
					lines.push(`${prefix}${seg.result}`);
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
	let pendingPermissions: PermissionPrompt[] = $state([]);
	let permissionLog: LogEntry[] = $state([]);

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
				const errMsg: ChatMessage = {
					id: generateId(),
					role: "assistant",
					content: [{ type: "text", text: `Error: ${event.error}` }],
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
			case "permission-prompt": {
				pendingPermissions = event.pending;
				break;
			}
			case "shell-output": {
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						// Find the last tool-call segment
						const segments = [...m.content];
						let found = false;
						for (let i = segments.length - 1; i >= 0; i--) {
							const seg = segments[i];
							if (seg && seg.type === "tool-call") {
								segments[i] = {
									...seg,
									shellOutput: {
										stdout: (seg.shellOutput?.stdout ?? "") + (event.stream === "stdout" ? event.data : ""),
										stderr: (seg.shellOutput?.stderr ?? "") + (event.stream === "stderr" ? event.data : ""),
									},
								};
								found = true;
								break;
							}
						}
						if (!found) return m; // no tool-call segment yet
						return { ...m, content: segments };
					}
					return m;
				});
				break;
			}
		}
	}

	async function sendMessage(text: string) {
		const userMsg: ChatMessage = {
			id: generateId(),
			role: "user",
			content: [{ type: "text", text }],
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
					content: [{ type: "text", text: `Error: Failed to send message (HTTP ${res.status})` }],
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
				content: [{ type: "text", text: "Error: Could not reach the server" }],
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

	function replyPermission(id: string, reply: "once" | "always" | "reject") {
		if (wsClient.connectionStatus !== "connected") {
			// WebSocket is not connected; skip optimistic removal to avoid losing the prompt
			return;
		}
		const prompt = pendingPermissions.find((p) => p.id === id);
		wsClient.send({ type: "permission-reply", id, reply });
		pendingPermissions = pendingPermissions.filter((p) => p.id !== id);
		if (prompt) {
			const entry: LogEntry = {
				id: generateId(),
				permission: prompt.permission,
				patterns: prompt.patterns,
				action: reply,
				timestamp: new Date().toISOString(),
				description: prompt.description,
			};
			permissionLog = [...permissionLog, entry];
		}
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
		get pendingPermissions() {
			return pendingPermissions;
		},
		get permissionLog() {
			return permissionLog;
		},
		sendMessage,
		handleEvent,
		replyPermission,
		copyConversation,
		clear,
	};
}

export const chatStore = createChatStore();
