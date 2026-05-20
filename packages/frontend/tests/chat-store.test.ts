import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ContentSegment, LogEntry, PermissionPrompt } from "../src/lib/types.js";

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
function createTestStore(wsSend?: (data: unknown) => void) {
	let messages: ChatMessage[] = [];
	let agentStatus: "idle" | "running" | "error" = "idle";
	let currentAssistantId: string | null = null;
	let pendingPermissions: PermissionPrompt[] = [];
	let permissionLog: LogEntry[] = [];

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
			case "permission-prompt": {
				pendingPermissions = event.pending;
				break;
			}
			case "shell-output": {
				messages = messages.map((m) => {
					if (m.id === currentAssistantId) {
						return {
							...m,
							content: m.content.map((seg, i) => {
								if (seg.type === "tool-call" && i === m.content.length - 1) {
									const prev = seg.shellOutput ?? { stdout: "", stderr: "" };
									return {
										...seg,
										shellOutput:
											event.stream === "stdout"
												? { ...prev, stdout: prev.stdout + event.data }
												: { ...prev, stderr: prev.stderr + event.data },
									};
								}
								return seg;
							}),
						};
					}
					return m;
				});
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

	function replyPermission(id: string, reply: "once" | "always" | "reject") {
		const prompt = pendingPermissions.find((p) => p.id === id);
		if (wsSend) wsSend({ type: "permission-reply", id, reply });
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
		get pendingPermissions() {
			return pendingPermissions;
		},
		get permissionLog() {
			return permissionLog;
		},
		handleEvent,
		sendMessage,
		replyPermission,
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

describe("permission-prompt handling", () => {
	let store: ReturnType<typeof createTestStore>;

	beforeEach(() => {
		store = createTestStore();
	});

	it("permission-prompt sets pendingPermissions", () => {
		const prompt: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: ["*"],
			always: ["*"],
			description: "Run a command",
			metadata: { command: "ls" },
		};
		store.handleEvent({ type: "permission-prompt", pending: [prompt] });
		expect(store.pendingPermissions).toHaveLength(1);
		expect(store.pendingPermissions[0]?.id).toBe("p1");
	});

	it("permission-prompt replaces previous pending permissions", () => {
		const p1: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: [],
			always: [],
			description: "First",
			metadata: {},
		};
		const p2: PermissionPrompt = {
			id: "p2",
			permission: "read",
			patterns: [],
			always: [],
			description: "Second",
			metadata: {},
		};
		store.handleEvent({ type: "permission-prompt", pending: [p1] });
		store.handleEvent({ type: "permission-prompt", pending: [p2] });
		expect(store.pendingPermissions).toHaveLength(1);
		expect(store.pendingPermissions[0]?.id).toBe("p2");
	});

	it("replyPermission removes the permission from pending and calls wsSend", () => {
		const mockSend = vi.fn();
		const storeWithSend = createTestStore(mockSend);
		const prompt: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: [],
			always: [],
			description: "Run command",
			metadata: { command: "echo hi" },
		};
		storeWithSend.handleEvent({ type: "permission-prompt", pending: [prompt] });
		storeWithSend.replyPermission("p1", "once");
		expect(storeWithSend.pendingPermissions).toHaveLength(0);
		expect(mockSend).toHaveBeenCalledWith({ type: "permission-reply", id: "p1", reply: "once" });
	});

	it("replyPermission with 'always' sends correct payload", () => {
		const mockSend = vi.fn();
		const storeWithSend = createTestStore(mockSend);
		const prompt: PermissionPrompt = {
			id: "p2",
			permission: "read",
			patterns: ["src/**"],
			always: ["src/**"],
			description: "Read a file",
			metadata: { filepath: "src/foo.ts" },
		};
		storeWithSend.handleEvent({ type: "permission-prompt", pending: [prompt] });
		storeWithSend.replyPermission("p2", "always");
		expect(mockSend).toHaveBeenCalledWith({ type: "permission-reply", id: "p2", reply: "always" });
		expect(storeWithSend.pendingPermissions).toHaveLength(0);
	});

	it("replyPermission with 'reject' removes the permission", () => {
		const mockSend = vi.fn();
		const storeWithSend = createTestStore(mockSend);
		const prompt: PermissionPrompt = {
			id: "p3",
			permission: "edit",
			patterns: [],
			always: [],
			description: "Edit a file",
			metadata: {},
		};
		storeWithSend.handleEvent({ type: "permission-prompt", pending: [prompt] });
		storeWithSend.replyPermission("p3", "reject");
		expect(storeWithSend.pendingPermissions).toHaveLength(0);
		expect(mockSend).toHaveBeenCalledWith({ type: "permission-reply", id: "p3", reply: "reject" });
	});
});

describe("permission log", () => {
	let store: ReturnType<typeof createTestStore>;

	beforeEach(() => {
		store = createTestStore(vi.fn());
	});

	it("starts with empty permission log", () => {
		expect(store.permissionLog).toHaveLength(0);
	});

	it("replyPermission adds an entry to permissionLog", () => {
		const mockSend = vi.fn();
		const s = createTestStore(mockSend);
		const prompt: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: ["*"],
			always: ["*"],
			description: "Run a command",
			metadata: {},
		};
		s.handleEvent({ type: "permission-prompt", pending: [prompt] });
		s.replyPermission("p1", "once");
		expect(s.permissionLog).toHaveLength(1);
		expect(s.permissionLog[0]?.permission).toBe("bash");
		expect(s.permissionLog[0]?.action).toBe("once");
		expect(s.permissionLog[0]?.description).toBe("Run a command");
	});

	it("permissionLog accumulates multiple entries", () => {
		const mockSend = vi.fn();
		const s = createTestStore(mockSend);
		const p1: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: [],
			always: [],
			description: "First",
			metadata: {},
		};
		const p2: PermissionPrompt = {
			id: "p2",
			permission: "read",
			patterns: [],
			always: [],
			description: "Second",
			metadata: {},
		};
		s.handleEvent({ type: "permission-prompt", pending: [p1, p2] });
		s.replyPermission("p1", "always");
		s.replyPermission("p2", "reject");
		expect(s.permissionLog).toHaveLength(2);
		expect(s.permissionLog[0]?.action).toBe("always");
		expect(s.permissionLog[1]?.action).toBe("reject");
	});

	it("replyPermission for unknown id does not add to log", () => {
		const s = createTestStore(vi.fn());
		s.replyPermission("nonexistent", "once");
		expect(s.permissionLog).toHaveLength(0);
	});
});

// Shell output parsing logic (mirrors ToolCallDisplay logic)
function parseShellResult(result: string): { stdout: string; stderr: string; exitCode: number } | null {
	try {
		const parsed = JSON.parse(result) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"stdout" in parsed &&
			"stderr" in parsed &&
			"exitCode" in parsed
		) {
			const p = parsed as Record<string, unknown>;
			return {
				stdout: String(p.stdout ?? ""),
				stderr: String(p.stderr ?? ""),
				exitCode: Number(p.exitCode ?? 0),
			};
		}
		return null;
	} catch {
		return null;
	}
}

describe("shell output parsing", () => {
	it("parses a valid shell result JSON", () => {
		const result = JSON.stringify({ stdout: "hello\n", stderr: "", exitCode: 0 });
		const parsed = parseShellResult(result);
		expect(parsed).not.toBeNull();
		expect(parsed?.stdout).toBe("hello\n");
		expect(parsed?.stderr).toBe("");
		expect(parsed?.exitCode).toBe(0);
	});

	it("parses non-zero exit code and stderr", () => {
		const result = JSON.stringify({ stdout: "", stderr: "error: not found", exitCode: 1 });
		const parsed = parseShellResult(result);
		expect(parsed?.exitCode).toBe(1);
		expect(parsed?.stderr).toBe("error: not found");
	});

	it("returns null for invalid JSON", () => {
		expect(parseShellResult("not json")).toBeNull();
	});

	it("returns null for JSON that lacks required fields", () => {
		expect(parseShellResult(JSON.stringify({ stdout: "foo" }))).toBeNull();
	});

	it("returns null for non-object JSON", () => {
		expect(parseShellResult(JSON.stringify(42))).toBeNull();
	});
});

describe("shell-output event handling", () => {
	it("shell-output stdout appends to last tool-call shellOutput", () => {
		const s = createTestStore();
		s.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "run_shell", arguments: { command: "ls" } },
		});
		s.handleEvent({ type: "shell-output", data: "file1\n", stream: "stdout" });
		s.handleEvent({ type: "shell-output", data: "file2\n", stream: "stdout" });
		const seg = s.messages[0]?.content[0];
		if (seg?.type === "tool-call") {
			expect(seg.shellOutput?.stdout).toBe("file1\nfile2\n");
			expect(seg.shellOutput?.stderr).toBe("");
		} else {
			expect.fail("Expected tool-call segment");
		}
	});

	it("shell-output stderr appends to last tool-call shellOutput stderr", () => {
		const s = createTestStore();
		s.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "run_shell", arguments: { command: "ls" } },
		});
		s.handleEvent({ type: "shell-output", data: "err line\n", stream: "stderr" });
		const seg = s.messages[0]?.content[0];
		if (seg?.type === "tool-call") {
			expect(seg.shellOutput?.stderr).toBe("err line\n");
		} else {
			expect.fail("Expected tool-call segment");
		}
	});
});
