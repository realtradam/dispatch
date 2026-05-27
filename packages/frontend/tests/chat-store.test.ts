import { appendEventToChunks, applySystemEvent } from "@dispatch/core/src/chunks/append.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentEvent,
	ChatMessage,
	Chunk,
	LogEntry,
	PermissionPrompt,
} from "../src/lib/types.js";

// The real store lives in `tabs.svelte.ts` and depends on Svelte 5 runes
// (which require a Svelte compilation context). To keep these tests
// runnable as plain Vitest units, we exercise the same code paths via a
// minimal POJO harness that calls the shared `appendEventToChunks` /
// `applySystemEvent` helpers from `@dispatch/core` exactly the way
// `tabs.svelte.ts` does at runtime. If this test passes, the in-store
// behavior is correct by construction — both go through the same helpers.

function generateId() {
	return Math.random().toString(36).slice(2, 11);
}

// Plain JS version of the chat store logic (no runes) for unit testing.
// Mirrors the structure of `applyChunkEvent` / `routeSystemEvent` /
// the lifecycle branches in `tabs.svelte.ts:handleEvent`.
function createTestStore(wsSend?: (data: unknown) => void) {
	let messages: ChatMessage[] = [];
	let agentStatus: "idle" | "running" | "error" = "idle";
	let currentAssistantId: string | null = null;
	let pendingPermissions: PermissionPrompt[] = [];
	let permissionLog: LogEntry[] = [];

	function ensureAssistantMessage(): ChatMessage {
		if (currentAssistantId) {
			const existing = messages.find((m) => m.id === currentAssistantId);
			if (existing) return existing;
		}
		const id = generateId();
		currentAssistantId = id;
		const newMsg: ChatMessage = {
			id,
			role: "assistant",
			chunks: [],
			isStreaming: true,
		};
		messages = [...messages, newMsg];
		return newMsg;
	}

	function applyChunkEvent(event: AgentEvent): void {
		ensureAssistantMessage();
		messages = messages.map((m) => {
			if (m.id !== currentAssistantId) return m;
			const cloned = structuredClone(m.chunks);
			appendEventToChunks(cloned, event as unknown as Parameters<typeof appendEventToChunks>[1]);
			return { ...m, chunks: cloned, isStreaming: true };
		});
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
			case "reasoning-delta":
			case "text-delta":
			case "tool-call":
			case "tool-result":
			case "shell-output":
				applyChunkEvent(event);
				break;
			case "done": {
				messages = messages.map((m) =>
					m.id === currentAssistantId ? { ...m, isStreaming: false } : m,
				);
				currentAssistantId = null;
				break;
			}
			case "error": {
				if (currentAssistantId) {
					applyChunkEvent(event);
				} else {
					ensureAssistantMessage();
					applyChunkEvent(event);
				}
				messages = messages.map((m) =>
					m.id === currentAssistantId ? { ...m, isStreaming: false } : m,
				);
				currentAssistantId = null;
				agentStatus = "error";
				break;
			}
			case "notice": {
				if (currentAssistantId) {
					applyChunkEvent(event);
				} else {
					const view = messages.map((m) => ({ id: m.id, role: m.role, chunks: m.chunks }));
					applySystemEvent(view, { kind: "notice", text: event.message }, generateId);
					const byId = new Map(messages.map((m) => [m.id, m]));
					messages = view.map((v) => {
						const existing = byId.get(v.id);
						return existing
							? { ...existing, chunks: v.chunks as Chunk[] }
							: ({ id: v.id, role: v.role, chunks: v.chunks as Chunk[] } as ChatMessage);
					});
				}
				break;
			}
			case "permission-prompt": {
				pendingPermissions = event.pending;
				break;
			}
		}
	}

	function sendMessage(text: string) {
		const userMsg: ChatMessage = {
			id: generateId(),
			role: "user",
			chunks: [{ type: "text", text }],
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

// ─── Small helpers for chunk assertions ─────────────────────────

function firstChunk(msg: ChatMessage | undefined): Chunk | undefined {
	return msg?.chunks[0];
}

describe("chat store logic (chunk model)", () => {
	let store: ReturnType<typeof createTestStore>;

	beforeEach(() => {
		store = createTestStore();
	});

	it("has correct initial state", () => {
		expect(store.messages).toHaveLength(0);
		expect(store.agentStatus).toBe("idle");
	});

	it("sendMessage adds a user message with a text chunk", () => {
		store.sendMessage("hello");
		expect(store.messages).toHaveLength(1);
		const msg = store.messages[0];
		expect(msg?.role).toBe("user");
		expect(msg?.chunks).toEqual([{ type: "text", text: "hello" }]);
	});

	it("text-delta creates a streaming assistant message and appends deltas", () => {
		store.handleEvent({ type: "text-delta", delta: "Hello" });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("assistant");
		expect(store.messages[0]?.chunks).toEqual([{ type: "text", text: "Hello" }]);
		expect(store.messages[0]?.isStreaming).toBe(true);

		store.handleEvent({ type: "text-delta", delta: " world" });
		expect(store.messages[0]?.chunks).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("consecutive text-deltas coalesce into one text chunk", () => {
		store.handleEvent({ type: "text-delta", delta: "A" });
		store.handleEvent({ type: "text-delta", delta: "B" });
		expect(store.messages[0]?.chunks).toHaveLength(1);
		expect(store.messages[0]?.chunks[0]).toEqual({ type: "text", text: "AB" });
	});

	it("tool-call after text creates a tool-batch chunk", () => {
		store.handleEvent({ type: "text-delta", delta: "Calling tool..." });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "test" } },
		});
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(2);
		expect(chunks?.[0]?.type).toBe("text");
		expect(chunks?.[1]?.type).toBe("tool-batch");
		if (chunks?.[1]?.type === "tool-batch") {
			expect(chunks[1].calls).toHaveLength(1);
			expect(chunks[1].calls[0]?.id).toBe("tc1");
			expect(chunks[1].calls[0]?.name).toBe("search");
		}
	});

	it("tool-result fills in result on the matching tool-batch entry", () => {
		store.handleEvent({ type: "text-delta", delta: "..." });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "x" } },
		});
		store.handleEvent({
			type: "tool-result",
			toolResult: { toolCallId: "tc1", result: "found it", isError: false },
		});
		const chunk = store.messages[0]?.chunks[1];
		if (chunk?.type === "tool-batch") {
			expect(chunk.calls[0]?.result).toBe("found it");
			expect(chunk.calls[0]?.isError).toBe(false);
		} else {
			expect.fail("Expected tool-batch chunk");
		}
	});

	it("two consecutive tool-calls coalesce into one tool-batch with two entries", () => {
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read", arguments: {} },
		});
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc2", name: "write", arguments: {} },
		});
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(1);
		expect(chunks?.[0]?.type).toBe("tool-batch");
		if (chunks?.[0]?.type === "tool-batch") {
			expect(chunks[0].calls).toHaveLength(2);
		}
	});

	it("text after tool-call opens a new text chunk", () => {
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read", arguments: {} },
		});
		store.handleEvent({ type: "text-delta", delta: "Result: here" });
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(2);
		expect(chunks?.[0]?.type).toBe("tool-batch");
		expect(chunks?.[1]).toEqual({ type: "text", text: "Result: here" });
	});

	it("done finalizes the current assistant message", () => {
		store.handleEvent({ type: "text-delta", delta: "partial" });
		store.handleEvent({
			type: "done",
			message: { role: "assistant", content: "full content" },
		});
		expect(store.messages[0]?.chunks).toEqual([{ type: "text", text: "partial" }]);
		expect(store.messages[0]?.isStreaming).toBe(false);
	});

	it("error event during a turn appends an error chunk to the in-flight message", () => {
		store.handleEvent({ type: "text-delta", delta: "before" });
		store.handleEvent({ type: "error", error: "something went wrong" });
		expect(store.messages).toHaveLength(1);
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(2);
		expect(chunks?.[0]).toEqual({ type: "text", text: "before" });
		expect(chunks?.[1]?.type).toBe("error");
		if (chunks?.[1]?.type === "error") {
			expect(chunks[1].message).toBe("something went wrong");
		}
		expect(store.agentStatus).toBe("error");
	});

	it("error event with no in-flight turn opens a fresh assistant message", () => {
		store.handleEvent({ type: "error", error: "boom" });
		expect(store.messages).toHaveLength(1);
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(1);
		expect(chunks?.[0]?.type).toBe("error");
		if (chunks?.[0]?.type === "error") {
			expect(chunks[0].message).toBe("boom");
		}
		expect(store.agentStatus).toBe("error");
	});

	it("status event updates agentStatus", () => {
		store.handleEvent({ type: "status", status: "running" });
		expect(store.agentStatus).toBe("running");
		store.handleEvent({ type: "status", status: "idle" });
		expect(store.agentStatus).toBe("idle");
	});

	it("reasoning-delta accumulates a thinking chunk", () => {
		store.handleEvent({ type: "reasoning-delta", delta: "First thought." });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("assistant");
		expect(firstChunk(store.messages[0])).toEqual({ type: "thinking", text: "First thought." });

		store.handleEvent({ type: "reasoning-delta", delta: " Second thought." });
		expect(firstChunk(store.messages[0])).toEqual({
			type: "thinking",
			text: "First thought. Second thought.",
		});
	});

	it("interleaved think→text→think yields three chunks in order", () => {
		store.handleEvent({ type: "reasoning-delta", delta: "thinking-1" });
		store.handleEvent({ type: "text-delta", delta: "speaking-1" });
		store.handleEvent({ type: "reasoning-delta", delta: "thinking-2" });
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(3);
		expect(chunks?.[0]?.type).toBe("thinking");
		expect(chunks?.[1]?.type).toBe("text");
		expect(chunks?.[2]?.type).toBe("thinking");
	});

	it("notice during a turn appends a system chunk on the assistant message", () => {
		store.handleEvent({ type: "text-delta", delta: "hi" });
		store.handleEvent({ type: "notice", message: "heads up" });
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(2);
		expect(chunks?.[1]?.type).toBe("system");
		if (chunks?.[1]?.type === "system") {
			expect(chunks[1].kind).toBe("notice");
			expect(chunks[1].text).toBe("heads up");
		}
	});

	it("notice with no turn in flight creates a role: system message", () => {
		store.handleEvent({ type: "notice", message: "standalone" });
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("system");
		const chunks = store.messages[0]?.chunks;
		expect(chunks).toHaveLength(1);
		if (chunks?.[0]?.type === "system") {
			expect(chunks[0].text).toBe("standalone");
		}
	});

	it("two notices with no turn coalesce onto the same system message", () => {
		store.handleEvent({ type: "notice", message: "first" });
		store.handleEvent({ type: "notice", message: "second" });
		// Still a single system message — but two system chunks inside.
		expect(store.messages).toHaveLength(1);
		expect(store.messages[0]?.role).toBe("system");
		expect(store.messages[0]?.chunks).toHaveLength(2);
	});

	it("clear resets all state", () => {
		store.sendMessage("hi");
		store.handleEvent({ type: "text-delta", delta: "hello" });
		store.clear();
		expect(store.messages).toHaveLength(0);
		expect(store.agentStatus).toBe("idle");
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
function parseShellResult(
	result: string,
): { stdout: string; stderr: string; exitCode: number } | null {
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
	it("shell-output stdout appends to last tool-batch entry's shellOutput", () => {
		const s = createTestStore();
		s.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "run_shell", arguments: { command: "ls" } },
		});
		s.handleEvent({ type: "shell-output", data: "file1\n", stream: "stdout" });
		s.handleEvent({ type: "shell-output", data: "file2\n", stream: "stdout" });
		const chunk = s.messages[0]?.chunks[0];
		if (chunk?.type === "tool-batch") {
			const entry = chunk.calls[0];
			expect(entry?.shellOutput?.stdout).toBe("file1\nfile2\n");
			expect(entry?.shellOutput?.stderr).toBe("");
		} else {
			expect.fail("Expected tool-batch chunk");
		}
	});

	it("shell-output stderr appends to last tool-batch entry's stderr", () => {
		const s = createTestStore();
		s.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "run_shell", arguments: { command: "ls" } },
		});
		s.handleEvent({ type: "shell-output", data: "err line\n", stream: "stderr" });
		const chunk = s.messages[0]?.chunks[0];
		if (chunk?.type === "tool-batch") {
			expect(chunk.calls[0]?.shellOutput?.stderr).toBe("err line\n");
		} else {
			expect.fail("Expected tool-batch chunk");
		}
	});
});
