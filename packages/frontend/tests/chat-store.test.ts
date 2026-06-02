/**
 * Integration tests for the tab store at `src/lib/tabs.svelte.ts`.
 *
 * These tests drive the **real** Svelte 5 `$state`-backed store via
 * `createTabStore()` and `handleEvent()`. The previous version of this
 * file used a POJO harness (plain arrays) that duplicated the store
 * logic from the production file, which meant any drift between the
 * harness and the real code went undetected.
 *
 * What this catches:
 *  - Logic bugs inside `handleEvent`, `applyChunkEvent`, `routeSystemEvent`.
 *  - Reactivity contract bugs where the real `$state` proxies behave
 *    differently than POJO arrays (e.g., reassignment patterns, derived
 *    state propagation).
 *  - Any case where the helper-imported-from-core (`appendEventToChunks`,
 *    `applySystemEvent`) disagrees with how the store wires it.
 *
 * What this DOES NOT catch (a known limitation):
 *  - The specific `structuredClone(svelteProxy)` failure that hit
 *    production. Browsers' `structuredClone` rejects certain
 *    Proxy/internal-slot patterns Svelte 5 uses; Bun's `structuredClone`
 *    (which is what vitest runs against here) is more permissive and
 *    happily clones these proxies. Empirically: temporarily reverting
 *    `applyChunkEvent` to `structuredClone(m.chunks)` keeps these tests
 *    green even though the same change breaks the browser at runtime.
 *    Catching that class of bug would require a browser-runtime test
 *    (Playwright or vitest browser mode) — out of scope for this round,
 *    but worth filing.
 *
 * Mocks: `wsClient`, `config`, and the global `fetch` are mocked so the
 * store doesn't try to open a real WebSocket / read localStorage / hit
 * an HTTP backend during module init.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `config.ts` reads `localStorage` at module load. Bun's runtime defines
// `localStorage` as a partial shim that lacks `getItem`, so the real
// module throws before we can even import the store. Mocking the
// module itself sidesteps that entirely — tests don't depend on the
// real API base resolution logic.
vi.mock("../src/lib/config.js", () => ({
	config: {
		apiBase: "http://test.local:3000",
		wsUrl: "ws://test.local:3000/ws",
		defaultApiBase: "http://test.local:3000",
		setApiBase: vi.fn(),
	},
}));

// Mock the WS module before importing the store so the module-load
// side effects (clearCallbacks/onEvent registration, status effect)
// see the stub. Tests interact with the store via the returned
// `handleEvent` method directly — no WS wiring needed.
vi.mock("../src/lib/ws.svelte.js", () => ({
	wsClient: {
		connectionStatus: "connected",
		clearCallbacks: vi.fn(),
		onEvent: vi.fn(),
		send: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
	},
}));

// Mock fetch so async network operations (createNewTab POSTs, auto-skill
// loaders, etc.) resolve immediately without hitting a real backend.
beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("test: fetch mocked"))),
	);
});

import { computeContextUsage } from "../src/lib/context-window.js";
import { appSettings } from "../src/lib/settings.svelte.js";
import { createTabStore } from "../src/lib/tabs.svelte.js";
import type { Chunk, PermissionPrompt } from "../src/lib/types.js";
import { wsClient } from "../src/lib/ws.svelte.js";

/**
 * Create a fresh store and a tab to drive events into. Returns both the
 * store and the tab id; tests should use `tabId` for `handleEvent` calls.
 */
async function setupStoreWithTab() {
	const store = createTabStore();
	const tab = await store.createNewTab();
	return { store, tabId: tab.id };
}

/**
 * Read the active assistant message's chunks. Most chunk tests are
 * structured "drive events → inspect chunks of the resulting assistant
 * message" — this helper avoids the boilerplate.
 */
function getAssistantChunks(store: ReturnType<typeof createTabStore>): Chunk[] | undefined {
	const tab = store.tabs[0];
	const assistant = tab?.renderGroups.find((m) => m.role === "assistant");
	return assistant?.chunks;
}

/**
 * Build a raw `ChunkRow` as the `GET /tabs/:id/chunks` endpoint returns them.
 * The chunk-native store loads/paginates raw rows and groups them for render.
 */
function chunkRow(
	id: string,
	tabId: string,
	seq: number,
	turnId: string,
	role: "user" | "assistant" | "tool" | "system",
	type: "text" | "thinking" | "tool_call" | "tool_result" | "error" | "system",
	data: unknown,
	step = 0,
): Record<string, unknown> {
	return { id, tabId, seq, turnId, step, role, type, data, createdAt: seq };
}

describe("tabStore — streaming chunk flow (real $state)", () => {
	it("text-delta creates a streaming assistant message and appends deltas", async () => {
		const { store, tabId } = await setupStoreWithTab();

		store.handleEvent({ type: "text-delta", delta: "Hello", tabId });

		const assistant = store.tabs[0]?.renderGroups.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.isStreaming).toBe(true);
		expect(assistant?.chunks).toEqual([{ type: "text", text: "Hello" }]);

		store.handleEvent({ type: "text-delta", delta: " world", tabId });
		expect(getAssistantChunks(store)).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("consecutive text-deltas coalesce into one text chunk", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "text-delta", delta: "A", tabId });
		store.handleEvent({ type: "text-delta", delta: "B", tabId });
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(1);
		expect(chunks?.[0]).toEqual({ type: "text", text: "AB" });
	});

	it("tool-call after text creates a tool-batch chunk", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "text-delta", delta: "Calling tool...", tabId });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "test" } },
			tabId,
		});
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(2);
		expect(chunks?.[0]?.type).toBe("text");
		expect(chunks?.[1]?.type).toBe("tool-batch");
		if (chunks?.[1]?.type === "tool-batch") {
			expect(chunks[1].calls).toHaveLength(1);
			expect(chunks[1].calls[0]?.id).toBe("tc1");
			expect(chunks[1].calls[0]?.name).toBe("search");
		}
	});

	it("tool-result fills in result on the matching tool-batch entry", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "text-delta", delta: "...", tabId });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "search", arguments: { query: "x" } },
			tabId,
		});
		store.handleEvent({
			type: "tool-result",
			toolResult: { toolCallId: "tc1", result: "found it", isError: false },
			tabId,
		});
		const chunks = getAssistantChunks(store);
		const tb = chunks?.[1];
		if (tb?.type === "tool-batch") {
			expect(tb.calls[0]?.result).toBe("found it");
			expect(tb.calls[0]?.isError).toBe(false);
		} else {
			expect.fail("Expected tool-batch chunk");
		}
	});

	it("two consecutive tool-calls coalesce into one tool-batch with two entries", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read", arguments: {} },
			tabId,
		});
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc2", name: "write", arguments: {} },
			tabId,
		});
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(1);
		expect(chunks?.[0]?.type).toBe("tool-batch");
		if (chunks?.[0]?.type === "tool-batch") {
			expect(chunks[0].calls).toHaveLength(2);
		}
	});

	it("text after tool-call opens a new text chunk", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read", arguments: {} },
			tabId,
		});
		store.handleEvent({ type: "text-delta", delta: "Result: here", tabId });
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(2);
		expect(chunks?.[0]?.type).toBe("tool-batch");
		expect(chunks?.[1]).toEqual({ type: "text", text: "Result: here" });
	});

	it("done finalizes the current assistant message", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "text-delta", delta: "partial", tabId });
		store.handleEvent({
			type: "done",
			message: { role: "assistant", chunks: [] },
			tabId,
		} as Parameters<typeof store.handleEvent>[0]);
		const assistant = store.tabs[0]?.renderGroups.find((m) => m.role === "assistant");
		expect(assistant?.chunks).toEqual([{ type: "text", text: "partial" }]);
		expect(assistant?.isStreaming).toBe(false);
		expect(store.tabs[0]?.currentAssistantId).toBeNull();
	});

	it("status:idle clears currentAssistantId", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "status", status: "running", tabId });
		expect(store.tabs[0]?.agentStatus).toBe("running");
		store.handleEvent({ type: "status", status: "idle", tabId });
		expect(store.tabs[0]?.agentStatus).toBe("idle");
		expect(store.tabs[0]?.currentAssistantId).toBeNull();
	});

	it("reasoning-delta accumulates a thinking chunk", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "reasoning-delta", delta: "First thought.", tabId });
		expect(getAssistantChunks(store)).toEqual([{ type: "thinking", text: "First thought." }]);

		store.handleEvent({ type: "reasoning-delta", delta: " Second thought.", tabId });
		expect(getAssistantChunks(store)).toEqual([
			{ type: "thinking", text: "First thought. Second thought." },
		]);
	});

	it("reasoning-end seals the thinking chunk with metadata (end-to-end signature seal)", async () => {
		const { store, tabId } = await setupStoreWithTab();

		store.handleEvent({ type: "reasoning-delta", delta: "plan", tabId });
		store.handleEvent({
			type: "reasoning-end",
			metadata: { anthropic: { signature: "wire-sig" } },
			tabId,
		});

		const chunks = getAssistantChunks(store);
		expect(chunks).toEqual([
			{ type: "thinking", text: "plan", metadata: { anthropic: { signature: "wire-sig" } } },
		]);
	});

	it("reasoning-delta after reasoning-end opens a new thinking chunk (v6 multi-block)", async () => {
		const { store, tabId } = await setupStoreWithTab();

		// First thinking block: delta → seal
		store.handleEvent({ type: "reasoning-delta", delta: "block-1", tabId });
		store.handleEvent({
			type: "reasoning-end",
			metadata: { anthropic: { signature: "sig-1" } },
			tabId,
		});

		// Second thinking block: new delta after seal must NOT extend the sealed chunk
		store.handleEvent({ type: "reasoning-delta", delta: "block-2", tabId });

		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(2);
		// First chunk sealed — text must not have been extended
		expect(chunks?.[0]).toEqual({
			type: "thinking",
			text: "block-1",
			metadata: { anthropic: { signature: "sig-1" } },
		});
		// Second chunk is fresh — no metadata yet
		expect(chunks?.[1]).toEqual({ type: "thinking", text: "block-2" });
	});

	it("reasoning-end without metadata is a no-op (subsequent delta still extends the chunk)", async () => {
		const { store, tabId } = await setupStoreWithTab();

		store.handleEvent({ type: "reasoning-delta", delta: "start", tabId });
		// reasoning-end with no metadata → helper returns early, chunk stays unsealed
		store.handleEvent({ type: "reasoning-end", tabId });
		// Next delta should extend the existing (still unsealed) chunk
		store.handleEvent({ type: "reasoning-delta", delta: " continued", tabId });

		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(1);
		expect(chunks?.[0]).toEqual({ type: "thinking", text: "start continued" });
	});

	it("interleaved think→text→think yields three chunks in order", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "reasoning-delta", delta: "thinking-1", tabId });
		store.handleEvent({ type: "text-delta", delta: "speaking-1", tabId });
		store.handleEvent({ type: "reasoning-delta", delta: "thinking-2", tabId });
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(3);
		expect(chunks?.[0]?.type).toBe("thinking");
		expect(chunks?.[1]?.type).toBe("text");
		expect(chunks?.[2]?.type).toBe("thinking");
	});

	it("error event during a turn appends an error chunk to the in-flight message", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "text-delta", delta: "before", tabId });
		store.handleEvent({ type: "error", error: "something went wrong", tabId });
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(2);
		expect(chunks?.[0]).toEqual({ type: "text", text: "before" });
		expect(chunks?.[1]?.type).toBe("error");
		if (chunks?.[1]?.type === "error") {
			expect(chunks[1].message).toBe("something went wrong");
		}
		expect(store.tabs[0]?.agentStatus).toBe("error");
	});

	it("error event with no in-flight turn opens a fresh assistant message", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "error", error: "boom", tabId });
		const assistantMessages =
			store.tabs[0]?.renderGroups.filter((m) => m.role === "assistant") ?? [];
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
		const errChunks = assistantMessages[assistantMessages.length - 1]?.chunks;
		expect(errChunks).toHaveLength(1);
		expect(errChunks?.[0]?.type).toBe("error");
		if (errChunks?.[0]?.type === "error") {
			expect(errChunks[0].message).toBe("boom");
		}
		expect(store.tabs[0]?.agentStatus).toBe("error");
	});

	it("notice during a turn appends a system chunk on the assistant message", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "text-delta", delta: "hi", tabId });
		store.handleEvent({ type: "notice", message: "heads up", tabId });
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(2);
		expect(chunks?.[1]?.type).toBe("system");
		if (chunks?.[1]?.type === "system") {
			expect(chunks[1].kind).toBe("notice");
			expect(chunks[1].text).toBe("heads up");
		}
	});

	it("notice with no turn in flight creates a role:system message", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "notice", message: "standalone", tabId });
		const systemMsg = store.tabs[0]?.renderGroups.find((m) => m.role === "system");
		expect(systemMsg).toBeDefined();
		const chunks = systemMsg?.chunks;
		expect(chunks).toHaveLength(1);
		if (chunks?.[0]?.type === "system") {
			expect(chunks[0].text).toBe("standalone");
		}
	});

	it("two notices with no turn coalesce onto the same system message as two chunks", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "notice", message: "first", tabId });
		store.handleEvent({ type: "notice", message: "second", tabId });
		const sysMsgs = store.tabs[0]?.renderGroups.filter((m) => m.role === "system") ?? [];
		expect(sysMsgs).toHaveLength(1);
		expect(sysMsgs[0]?.chunks).toHaveLength(2);
	});

	it("shell-output stdout/stderr append to the most recent tool-batch entry", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "tc1", name: "run_shell", arguments: { command: "ls" } },
			tabId,
		});
		store.handleEvent({ type: "shell-output", data: "file1\n", stream: "stdout", tabId });
		store.handleEvent({ type: "shell-output", data: "file2\n", stream: "stdout", tabId });
		store.handleEvent({ type: "shell-output", data: "err line\n", stream: "stderr", tabId });
		const chunk = getAssistantChunks(store)?.[0];
		if (chunk?.type === "tool-batch") {
			expect(chunk.calls[0]?.shellOutput?.stdout).toBe("file1\nfile2\n");
			expect(chunk.calls[0]?.shellOutput?.stderr).toBe("err line\n");
		} else {
			expect.fail("Expected tool-batch chunk");
		}
	});
});

describe("tabStore — reactivity contract", () => {
	// These tests specifically exercise the structuredClone-vs-$state.snapshot
	// regression. If applyChunkEvent reverts to `structuredClone(m.chunks)`,
	// the call will throw DataCloneError on the Svelte reactive proxy, the
	// throw will surface (post-fix to ws.svelte.ts) or be swallowed (pre-fix),
	// and either way the chunks below will end up empty rather than
	// populated. These assertions ensure the bug class can't return silently.

	it("a streaming sequence produces non-empty chunks on a real $state-backed message", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({ type: "status", status: "running", tabId });
		store.handleEvent({ type: "reasoning-delta", delta: "I should...", tabId });
		store.handleEvent({
			type: "tool-call",
			toolCall: { id: "t1", name: "list_files", arguments: { path: "." } },
			tabId,
		});
		store.handleEvent({
			type: "tool-result",
			toolResult: { toolCallId: "t1", result: "files", isError: false },
			tabId,
		});
		store.handleEvent({ type: "text-delta", delta: "Result is...", tabId });
		store.handleEvent({ type: "status", status: "idle", tabId });

		const chunks = getAssistantChunks(store);
		// 3 chunks: thinking, tool-batch, text. Anything less means the
		// reactive-clone step swallowed events.
		expect(chunks).toHaveLength(3);
		expect(chunks?.[0]?.type).toBe("thinking");
		expect(chunks?.[1]?.type).toBe("tool-batch");
		expect(chunks?.[2]?.type).toBe("text");
		// And the chunks must NOT be reactive proxies — they must be
		// plain snapshot-cloned objects safe to serialize/pass around.
		// Probing via JSON round-trip is a cheap correctness check.
		expect(() => JSON.stringify(chunks)).not.toThrow();
	});

	it("multiple events on the same message accumulate (this is the chunks=0 regression)", async () => {
		const { store, tabId } = await setupStoreWithTab();
		// Drive a fairly large number of deltas. The original bug had every
		// content event after the first one silently failing — so this would
		// produce 1 chunk with 1 char (or 0 chunks if the first one also
		// failed for some reason). With the fix, the text accumulates.
		for (let i = 0; i < 50; i++) {
			store.handleEvent({ type: "text-delta", delta: `${i} `, tabId });
		}
		const chunks = getAssistantChunks(store);
		expect(chunks).toHaveLength(1);
		expect(chunks?.[0]?.type).toBe("text");
		if (chunks?.[0]?.type === "text") {
			// "0 1 2 ... 49 " is well over 100 chars.
			expect(chunks[0].text.length).toBeGreaterThan(100);
		}
	});

	it("statuses event resyncs a tab the frontend thought was running but the backend says is idle", async () => {
		const { store, tabId } = await setupStoreWithTab();
		// Drive the frontend into 'thinks it's running' state.
		store.handleEvent({ type: "status", status: "running", tabId });
		store.handleEvent({ type: "text-delta", delta: "starting", tabId });
		expect(store.tabs[0]?.agentStatus).toBe("running");
		expect(store.tabs[0]?.currentAssistantId).not.toBeNull();

		// Backend says: idle. (Simulates the WS-reconnect statuses snapshot
		// after the in-flight agent was lost — bun --watch restart, network
		// hiccup, etc.)
		store.handleEvent({
			type: "statuses",
			statuses: { [tabId]: { status: "idle" } },
		});

		expect(store.tabs[0]?.agentStatus).toBe("idle");
		expect(store.tabs[0]?.currentAssistantId).toBeNull();
		// The streaming flag on the in-flight message should be cleared.
		const assistant = store.tabs[0]?.renderGroups.find((m) => m.role === "assistant");
		expect(assistant?.isStreaming).toBe(false);
	});
});

describe("tabStore — permission flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("permission-prompt sets pendingPermissions", async () => {
		const store = createTabStore();
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

	it("permission-prompt replaces previous pending permissions", async () => {
		const store = createTabStore();
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

	it("replyPermission removes the permission and sends over WS", async () => {
		const store = createTabStore();
		const prompt: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: [],
			always: [],
			description: "Run command",
			metadata: { command: "echo hi" },
		};
		store.handleEvent({ type: "permission-prompt", pending: [prompt] });
		store.replyPermission("p1", "once");
		expect(store.pendingPermissions).toHaveLength(0);
		expect(wsClient.send).toHaveBeenCalledWith({
			type: "permission-reply",
			id: "p1",
			reply: "once",
		});
	});

	it("replyPermission with 'always' sends correct payload", async () => {
		const store = createTabStore();
		const prompt: PermissionPrompt = {
			id: "p2",
			permission: "read",
			patterns: ["src/**"],
			always: ["src/**"],
			description: "Read a file",
			metadata: { filepath: "src/foo.ts" },
		};
		store.handleEvent({ type: "permission-prompt", pending: [prompt] });
		store.replyPermission("p2", "always");
		expect(wsClient.send).toHaveBeenCalledWith({
			type: "permission-reply",
			id: "p2",
			reply: "always",
		});
		expect(store.pendingPermissions).toHaveLength(0);
	});

	it("replyPermission with 'reject' removes the permission", async () => {
		const store = createTabStore();
		const prompt: PermissionPrompt = {
			id: "p3",
			permission: "edit",
			patterns: [],
			always: [],
			description: "Edit a file",
			metadata: {},
		};
		store.handleEvent({ type: "permission-prompt", pending: [prompt] });
		store.replyPermission("p3", "reject");
		expect(store.pendingPermissions).toHaveLength(0);
		expect(wsClient.send).toHaveBeenCalledWith({
			type: "permission-reply",
			id: "p3",
			reply: "reject",
		});
	});

	it("replyPermission adds an entry to permissionLog", async () => {
		const store = createTabStore();
		const prompt: PermissionPrompt = {
			id: "p1",
			permission: "bash",
			patterns: ["*"],
			always: ["*"],
			description: "Run a command",
			metadata: {},
		};
		store.handleEvent({ type: "permission-prompt", pending: [prompt] });
		store.replyPermission("p1", "once");
		expect(store.permissionLog).toHaveLength(1);
		expect(store.permissionLog[0]?.permission).toBe("bash");
		expect(store.permissionLog[0]?.action).toBe("once");
		expect(store.permissionLog[0]?.description).toBe("Run a command");
	});

	it("permissionLog accumulates multiple entries", async () => {
		const store = createTabStore();
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
		store.handleEvent({ type: "permission-prompt", pending: [p1, p2] });
		store.replyPermission("p1", "always");
		store.replyPermission("p2", "reject");
		expect(store.permissionLog).toHaveLength(2);
		expect(store.permissionLog[0]?.action).toBe("always");
		expect(store.permissionLog[1]?.action).toBe("reject");
	});

	it("replyPermission for unknown id does not add to log", async () => {
		const store = createTabStore();
		store.replyPermission("nonexistent", "once");
		expect(store.permissionLog).toHaveLength(0);
	});
});

// Shell output JSON parsing — a small helper that mirrors logic in
// ToolCallDisplay.svelte. Kept here as a self-contained unit; the
// component itself isn't tested in this file.
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

describe("shell output parsing helper", () => {
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

// ─── hydrateFromBackend ─────────────────────────────────────────
//
// Verifies the browser-reopen restore path: GET /tabs + GET /status +
// GET /tabs/:id/messages combined into the in-memory tab store with
// in-flight chunks seeded for any running tab.

describe("hydrateFromBackend", () => {
	it("restores tabs from /tabs with their persisted messages", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{ id: "t1", title: "First", keyId: null, modelId: null, parentTabId: null },
									{ id: "t2", title: "Second", keyId: "k", modelId: "m", parentTabId: null },
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ statuses: {} }),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/t1/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								chunks: [
									chunkRow("m1", "t1", 0, "u1", "user", "text", { text: "hello" }),
									chunkRow("m2", "t1", 1, "u1", "assistant", "text", { text: "hi back" }),
								],
								total: 2,
								oldestSeq: 0,
							}),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/t2/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(2);
		expect(store.tabs.length).toBe(2);
		expect(store.tabs[0]?.id).toBe("t1");
		expect(store.tabs[0]?.renderGroups.length).toBe(2);
		expect(store.tabs[1]?.id).toBe("t2");
		expect(store.tabs[1]?.renderGroups.length).toBe(0);
		expect(store.activeTabId).toBe("t1");
	});

	it("seeds the in-flight assistant message from /status for a running tab", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{ id: "tr", title: "Running tab", keyId: null, modelId: null, parentTabId: null },
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								statuses: {
									tr: {
										status: "running",
										currentAssistantId: "live-msg-id",
										currentChunks: [
											{ type: "thinking", text: "still thinking" },
											{ type: "text", text: "partial " },
										],
									},
								},
							}),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/tr/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								chunks: [chunkRow("u1", "tr", 0, "turn-r", "user", "text", { text: "go" })],
								total: 1,
								oldestSeq: 0,
							}),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(1);
		const tab = store.tabs[0];
		expect(tab?.agentStatus).toBe("running");
		expect(tab?.currentAssistantId).toBe("live-msg-id");
		// Two messages: the user message + the seeded in-flight assistant.
		expect(tab?.renderGroups.length).toBe(2);
		const inflight = tab?.renderGroups.find((m) => m.id === "live-msg-id");
		expect(inflight).toBeDefined();
		expect(inflight?.isStreaming).toBe(true);
		expect(inflight?.chunks).toEqual([
			{ type: "thinking", text: "still thinking" },
			{ type: "text", text: "partial " },
		]);
	});

	it("returns 0 and leaves tabs empty when /tabs fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(0);
		expect(store.tabs.length).toBe(0);
	});

	it("returns 0 and leaves tabs empty when /tabs returns an empty array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ tabs: [] }) });
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);
		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(0);
		expect(store.tabs.length).toBe(0);
	});

	it("is a no-op when the store already has tabs (idempotency)", async () => {
		const store = createTabStore();
		// Pretend the store already has a tab (e.g. from a hot-reload).
		// We do this by reaching into the store via the public API.
		// Use the create path with mocked fetch failure (existing
		// `createNewTab` already tolerates fetch failure — adds locally).
		// (beforeEach already stubs fetch to reject, so createNewTab will
		// proceed past the failed POST and add the tab locally.)
		await store.createNewTab();
		expect(store.tabs.length).toBe(1);

		// Now swap to a fetch that would lie about there being 3 tabs;
		// hydrateFromBackend must NOT call it. We use a fresh mock that
		// rejects to catch any stray background async calls too.
		let hydrateCallCount = 0;
		const sentinelFetch = vi.fn((url: string) => {
			// Allow background auto-agent/skill fetches that fire from
			// createNewTab's void async closure (autoSelectDefaultAgent,
			// autoCheckDefaultSkills) — they use /agents and /skills paths,
			// not /tabs. Reject them so they don't interfere.
			if (url.includes("/agents") || url.includes("/skills")) {
				return Promise.reject(new Error("test: background fetch ignored"));
			}
			// Any /tabs call would mean hydrateFromBackend ran — count it.
			hydrateCallCount++;
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ tabs: [{ id: "x" }, { id: "y" }, { id: "z" }] }),
			});
		});
		vi.stubGlobal("fetch", sentinelFetch);
		const n = await store.hydrateFromBackend();
		expect(n).toBe(0);
		expect(store.tabs.length).toBe(1);
		expect(hydrateCallCount).toBe(0);
	});

	it("restores a tab with an idle status when /status omits it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [{ id: "ti", title: "Idle", keyId: null, modelId: null, parentTabId: null }],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/ti/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);
		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(1);
		expect(store.tabs[0]?.agentStatus).toBe("idle");
		expect(store.tabs[0]?.currentAssistantId).toBeNull();
	});

	it("restores a tab with empty messages when /tabs/:id/messages fails (per-tab failure isolation)", async () => {
		// The hydrateFromBackend implementation wraps each per-tab
		// messages fetch in a try/catch so one tab's failure can't
		// destroy the whole restore pass. This test covers BOTH failure
		// modes the try/catch protects against:
		//   - response.ok === false (HTTP error like 500)
		//   - the fetch rejects (network error)
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{
										id: "tA",
										title: "Healthy",
										keyId: null,
										modelId: null,
										parentTabId: null,
									},
									{
										id: "tB",
										title: "Broken (HTTP 500)",
										keyId: null,
										modelId: null,
										parentTabId: null,
									},
									{
										id: "tC",
										title: "Broken (network)",
										keyId: null,
										modelId: null,
										parentTabId: null,
									},
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tA/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								chunks: [chunkRow("msg-a", "tA", 0, "turn-a", "user", "text", { text: "ok" })],
								total: 1,
								oldestSeq: 0,
							}),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/tB/chunks")) {
					// HTTP error path: response is not ok.
					return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tC/chunks")) {
					// Network error path: the fetch itself rejects.
					return Promise.reject(new Error("simulated network failure"));
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(3);

		// Healthy tab restored with its message.
		const tA = store.tabs.find((t) => t.id === "tA");
		expect(tA?.renderGroups.length).toBe(1);
		expect(tA?.renderGroups[0]?.chunks).toEqual([{ type: "text", text: "ok" }]);

		// Both broken tabs restored with empty message lists — neither
		// crashed the hydration nor leaked an error chunk into the UI.
		const tB = store.tabs.find((t) => t.id === "tB");
		expect(tB).toBeDefined();
		expect(tB?.renderGroups.length).toBe(0);
		expect(tB?.agentStatus).toBe("idle");

		const tC = store.tabs.find((t) => t.id === "tC");
		expect(tC).toBeDefined();
		expect(tC?.renderGroups.length).toBe(0);
		expect(tC?.agentStatus).toBe("idle");
	});

	// ─── usage persistence: seed cacheStats from the backend aggregate ──
	it("seeds cacheStats from a tab's usageStats on hydrate (reload persistence)", async () => {
		const usageStats = {
			inputTokens: 2200,
			outputTokens: 100,
			cacheReadTokens: 1000,
			cacheWriteTokens: 1000,
			requests: 2,
			last: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 100 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{
										id: "tu",
										title: "Has usage",
										keyId: null,
										modelId: null,
										parentTabId: null,
										usageStats,
									},
									{
										id: "tn",
										title: "No usage",
										keyId: null,
										modelId: null,
										parentTabId: null,
										usageStats: null,
									},
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tu/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/tn/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(2);
		// Tab with persisted usage → cacheStats seeded directly from the aggregate.
		expect(store.tabs.find((t) => t.id === "tu")?.cacheStats).toEqual(usageStats);
		// Tab with null usageStats → cacheStats stays undefined (no usage yet).
		expect(store.tabs.find((t) => t.id === "tn")?.cacheStats).toBeUndefined();
	});

	it("does not re-seed or double-count cacheStats on a statuses reconnect after hydrate", async () => {
		const usageStats = {
			inputTokens: 1000,
			outputTokens: 40,
			cacheReadTokens: 0,
			cacheWriteTokens: 900,
			requests: 1,
			last: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{
										id: "tr",
										title: "Reconnect",
										keyId: null,
										modelId: null,
										parentTabId: null,
										usageStats,
									},
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tr/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		await store.hydrateFromBackend();
		expect(store.tabs.find((t) => t.id === "tr")?.cacheStats).toEqual(usageStats);

		// A WS reconnect snapshot must NOT touch cacheStats (in-session live
		// `usage` events own the running totals; the aggregate seed is reload-only).
		store.handleEvent({ type: "statuses", statuses: { tr: { status: "idle" } } });
		expect(store.tabs.find((t) => t.id === "tr")?.cacheStats).toEqual(usageStats);
	});

	it("keeps accumulating live usage events after a hydrate seed", async () => {
		const usageStats = {
			inputTokens: 1000,
			outputTokens: 40,
			cacheReadTokens: 0,
			cacheWriteTokens: 900,
			requests: 1,
			last: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{
										id: "tl",
										title: "Live after hydrate",
										keyId: null,
										modelId: null,
										parentTabId: null,
										usageStats,
									},
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tl/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		await store.hydrateFromBackend();

		// A new in-session usage event folds ON TOP of the seeded aggregate.
		store.handleEvent({
			type: "usage",
			tabId: "tl",
			usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 150, cacheWriteTokens: 0 },
		});
		const stats = store.tabs.find((t) => t.id === "tl")?.cacheStats;
		expect(stats?.requests).toBe(2);
		expect(stats?.inputTokens).toBe(1200);
		expect(stats?.outputTokens).toBe(50);
		expect(stats?.cacheReadTokens).toBe(150);
		expect(stats?.cacheWriteTokens).toBe(900);
		expect(stats?.last).toEqual({
			inputTokens: 200,
			outputTokens: 10,
			cacheReadTokens: 150,
			cacheWriteTokens: 0,
		});
	});

	// Cross-feature contract (Context Window view, branch u2): the panel derives
	// current context size from `cacheStats.last` via computeContextUsage. This
	// test proves persistence restores that field on hydrate, so the view shows a
	// real "x / max" immediately after a reload on a NEW DEVICE — not "No context
	// data yet". Guards the contract so neither side can silently break it.
	it("restores cacheStats.last on hydrate so the Context Window view has data after reload", async () => {
		const usageStats = {
			inputTokens: 90000,
			outputTokens: 3000,
			cacheReadTokens: 40000,
			cacheWriteTokens: 5000,
			requests: 3,
			// Most recent request's snapshot — the numerator the view reads.
			last: { inputTokens: 47000, outputTokens: 1200, cacheReadTokens: 30000, cacheWriteTokens: 0 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{
										id: "tc",
										title: "Context after reload",
										keyId: null,
										modelId: null,
										parentTabId: null,
										usageStats,
									},
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tc/chunks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ chunks: [], total: 0, oldestSeq: null }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		await store.hydrateFromBackend();

		// What App.svelte passes into ContextWindowPanel: the active tab's cacheStats
		// plus the model's max (re-resolved from models.dev on load — here 200k).
		const cacheStats = store.tabs.find((t) => t.id === "tc")?.cacheStats ?? null;
		expect(cacheStats?.last).not.toBeNull();

		const usage = computeContextUsage(cacheStats, 200000);
		// current = last.inputTokens + last.outputTokens (47000 + 1200), NOT the
		// cumulative session totals (which would double-count history).
		expect(usage.current).toBe(48200);
		expect(usage.max).toBe(200000);
		expect(usage.percent).toBeCloseTo(24.1, 5);
	});
});

// ─── statuses WS event with the wider TabStatusSnapshot shape ───
//
// The handler must reconcile snapshot.status against the local tab,
// and (when running) seed currentChunks into the in-flight assistant
// message.

describe("handleEvent statuses with TabStatusSnapshot", () => {
	it("seeds the in-flight assistant message when a running snapshot arrives", async () => {
		const store = createTabStore();
		// Manually add a tab to the store via the existing createNewTab path
		// (fetch was mocked to reject in beforeEach; createNewTab tolerates).
		// We then drive a statuses event.
		await store.createNewTab();
		const tabId = store.tabs[0]?.id;
		if (!tabId) throw new Error("test fixture: tab id missing");

		store.handleEvent({
			type: "statuses",
			statuses: {
				[tabId]: {
					status: "running",
					currentAssistantId: "live-x",
					currentChunks: [{ type: "text", text: "live data" }],
				},
			},
		});

		const tab = store.tabs.find((t) => t.id === tabId);
		expect(tab?.agentStatus).toBe("running");
		expect(tab?.currentAssistantId).toBe("live-x");
		const inflight = tab?.renderGroups.find((m) => m.id === "live-x");
		expect(inflight).toBeDefined();
		expect(inflight?.chunks).toEqual([{ type: "text", text: "live data" }]);
		expect(inflight?.isStreaming).toBe(true);
	});

	it("clears in-flight pointers when snapshot says the tab is idle", async () => {
		const store = createTabStore();
		await store.createNewTab();
		const tabId = store.tabs[0]?.id;
		if (!tabId) throw new Error("test fixture: tab id missing");

		// First put the tab into a running state with an in-flight message.
		store.handleEvent({
			type: "statuses",
			statuses: {
				[tabId]: {
					status: "running",
					currentAssistantId: "msg-a",
					currentChunks: [{ type: "text", text: "x" }],
				},
			},
		});
		expect(store.tabs.find((t) => t.id === tabId)?.currentAssistantId).toBe("msg-a");

		// Now snapshot says idle.
		store.handleEvent({
			type: "statuses",
			statuses: { [tabId]: { status: "idle" } },
		});
		const tab = store.tabs.find((t) => t.id === tabId);
		expect(tab?.agentStatus).toBe("idle");
		expect(tab?.currentAssistantId).toBeNull();
		const msgA = tab?.renderGroups.find((m) => m.id === "msg-a");
		expect(msgA?.isStreaming).toBe(false);
	});
});

describe("tabStore — cache rate (usage events)", () => {
	it("accumulates usage events into per-tab cacheStats and tracks the last request", async () => {
		const { store, tabId } = await setupStoreWithTab();

		// No usage yet.
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats).toBeUndefined();

		// First request: mostly a cache write (cold prefix).
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
		});
		// Second request: mostly a cache hit.
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 100 },
		});

		const stats = store.tabs.find((t) => t.id === tabId)?.cacheStats;
		expect(stats).toBeDefined();
		expect(stats?.requests).toBe(2);
		// Cumulative totals.
		expect(stats?.inputTokens).toBe(2200);
		expect(stats?.outputTokens).toBe(100);
		expect(stats?.cacheReadTokens).toBe(1000);
		expect(stats?.cacheWriteTokens).toBe(1000);
		// `last` reflects only the most recent request.
		expect(stats?.last).toEqual({
			inputTokens: 1200,
			outputTokens: 60,
			cacheReadTokens: 1000,
			cacheWriteTokens: 100,
		});
	});

	it("ignores usage events with no tabId", async () => {
		const { store } = await setupStoreWithTab();
		store.handleEvent({
			type: "usage",
			usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 0 },
		});
		expect(store.tabs[0]?.cacheStats).toBeUndefined();
	});

	it("turn-sealed REPLACES cacheStats with the carried DB aggregate (reconcile to truth)", async () => {
		const { store, tabId } = await setupStoreWithTab();
		// Live events accumulate during the turn.
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
		});
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats?.inputTokens).toBe(1000);

		// turn-sealed carries the authoritative aggregate → cacheStats is REPLACED.
		const aggregate = {
			inputTokens: 1000,
			outputTokens: 40,
			cacheReadTokens: 0,
			cacheWriteTokens: 900,
			requests: 1,
			last: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
		};
		store.handleEvent({ type: "turn-sealed", turnId: "t1", tabId, usageStats: aggregate });
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats).toEqual(aggregate);
	});

	it("turn-sealed self-heals a live overshoot from a discarded fallback attempt", async () => {
		const { store, tabId } = await setupStoreWithTab();
		// Attempt 1 streamed usage live (overshoot), then rate-limited & discarded
		// server-side; attempt 2's usage also streamed live. Live = sum of BOTH.
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 999, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 222, outputTokens: 22, cacheReadTokens: 100, cacheWriteTokens: 5 },
		});
		const overshoot = store.tabs.find((t) => t.id === tabId)?.cacheStats;
		expect(overshoot?.requests).toBe(2);
		expect(overshoot?.inputTokens).toBe(1221); // inflated: includes discarded attempt

		// The DB only persisted attempt 2 (the survivor). turn-sealed reconciles.
		const persisted = {
			inputTokens: 222,
			outputTokens: 22,
			cacheReadTokens: 100,
			cacheWriteTokens: 5,
			requests: 1,
			last: { inputTokens: 222, outputTokens: 22, cacheReadTokens: 100, cacheWriteTokens: 5 },
		};
		store.handleEvent({ type: "turn-sealed", turnId: "t1", tabId, usageStats: persisted });
		// Overshoot healed: cacheStats now matches the DB truth exactly.
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats).toEqual(persisted);
	});

	it("turn-sealed without usageStats leaves cacheStats untouched (back-compat)", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 500, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		const before = store.tabs.find((t) => t.id === tabId)?.cacheStats;
		// Older backend: turn-sealed carries no usageStats field.
		store.handleEvent({ type: "turn-sealed", turnId: "t1", tabId });
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats).toEqual(before);
	});

	it("turn-sealed with usageStats: null clears cacheStats", async () => {
		const { store, tabId } = await setupStoreWithTab();
		store.handleEvent({
			type: "usage",
			tabId,
			usage: { inputTokens: 500, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
		});
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats).toBeDefined();
		// A null aggregate (no persisted usage rows) explicitly clears live stats.
		store.handleEvent({ type: "turn-sealed", turnId: "t1", tabId, usageStats: null });
		expect(store.tabs.find((t) => t.id === tabId)?.cacheStats).toBeUndefined();
	});
});

// ─── chunk-native store: eviction, pagination, reconcile ────────
//
// The store's source of truth for HISTORY is a flat ChunkRow[] (`tab.chunks`,
// real seqs); the live turn is a transient tail (`tab.live`) folded from
// stream deltas and reconciled into `chunks` on `turn-sealed`. `tab.renderGroups`
// is a derived render projection. These tests drive the real store.

describe("tabStore — chunk-native eviction / pagination / reconcile", () => {
	function chunksResponse(rows: Array<Record<string, unknown>>, total?: number) {
		const oldestSeq = rows.length > 0 ? ((rows[0]?.seq as number) ?? null) : null;
		return {
			ok: true,
			json: () => Promise.resolve({ chunks: rows, total: total ?? rows.length, oldestSeq }),
		};
	}
	function tabsListResponse(id: string) {
		return {
			ok: true,
			json: () => Promise.resolve({ tabs: [{ id, title: id, parentTabId: null }] }),
		};
	}
	function emptyStatuses() {
		return { ok: true, json: () => Promise.resolve({ statuses: {} }) };
	}
	const tick = () => new Promise((r) => setTimeout(r, 0));

	it("evicts sealed chunks to chunkLimit, trimming WITHIN one large turn", async () => {
		appSettings.chunkLimit = 5;
		try {
			// One turn of 10 chunk rows (the pathological single big turn).
			const rows = Array.from({ length: 10 }, (_, i) =>
				chunkRow(`c${i}`, "big", i, "turn-1", i === 0 ? "user" : "assistant", "text", {
					text: `t${i}`,
				}),
			);
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.endsWith("/tabs")) return Promise.resolve(tabsListResponse("big"));
					if (url.endsWith("/status")) return Promise.resolve(emptyStatuses());
					if (url.split("?")[0]?.endsWith("/tabs/big/chunks"))
						return Promise.resolve(chunksResponse(rows, 10));
					return Promise.reject(new Error(`unexpected ${url}`));
				}),
			);
			const store = createTabStore();
			await store.hydrateFromBackend();
			const tab = store.tabs.find((t) => t.id === "big");
			// Bounded to chunkLimit; the OLDEST rows of the single turn were trimmed.
			expect(tab?.chunks.length).toBe(5);
			expect(tab?.chunks.map((c) => c.seq)).toEqual([5, 6, 7, 8, 9]);
			// Pagination cursor points at a real remaining seq.
			expect(tab?.oldestLoadedSeq).toBe(5);
		} finally {
			appSettings.chunkLimit = 100;
		}
	});

	it("loadOlderChunks prepends an older page and dedupes by seq", async () => {
		appSettings.chunkLimit = 1000; // don't evict during this test
		try {
			const newer = [6, 7, 8, 9].map((s) =>
				chunkRow(`c${s}`, "pg", s, "t", "assistant", "text", { text: `t${s}` }),
			);
			// Overlaps the newer window at seq 6 — must dedupe.
			const older = [2, 3, 4, 5, 6].map((s) =>
				chunkRow(`c${s}`, "pg", s, "t", "assistant", "text", { text: `t${s}` }),
			);
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					if (url.endsWith("/tabs")) return Promise.resolve(tabsListResponse("pg"));
					if (url.endsWith("/status")) return Promise.resolve(emptyStatuses());
					if (url.split("?")[0]?.endsWith("/tabs/pg/chunks")) {
						return Promise.resolve(
							url.includes("before=") ? chunksResponse(older, 8) : chunksResponse(newer, 8),
						);
					}
					return Promise.reject(new Error(`unexpected ${url}`));
				}),
			);
			const store = createTabStore();
			await store.hydrateFromBackend();
			let tab = store.tabs.find((t) => t.id === "pg");
			expect(tab?.chunks.map((c) => c.seq)).toEqual([6, 7, 8, 9]);
			expect(tab?.oldestLoadedSeq).toBe(6);

			await store.loadOlderChunks("pg");
			tab = store.tabs.find((t) => t.id === "pg");
			expect(tab?.chunks.map((c) => c.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
			expect(tab?.oldestLoadedSeq).toBe(2);
		} finally {
			appSettings.chunkLimit = 100;
		}
	});

	it("turn-sealed folds the live turn into the sealed chunk log with real seqs", async () => {
		const sealed = [
			chunkRow("u", "rc", 0, "turn-x", "user", "text", { text: "hi" }),
			chunkRow("a", "rc", 1, "turn-x", "assistant", "text", { text: "answer" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.split("?")[0]?.endsWith("/tabs/rc/chunks"))
					return Promise.resolve(chunksResponse(sealed, 2));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "rc",
			title: "RC",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		store.handleEvent({ type: "turn-start", turnId: "turn-x", tabId: "rc" });
		store.handleEvent({ type: "text-delta", delta: "answer", tabId: "rc" });
		// While streaming: live tail holds the in-flight assistant; sealed empty.
		let tab = store.tabs.find((t) => t.id === "rc");
		expect(tab?.live.length).toBe(1);
		expect(tab?.chunks.length).toBe(0);
		// The live assistant is tagged with the turn id (stable render key basis).
		expect(tab?.live[0]?.turnId).toBe("turn-x");

		store.handleEvent({ type: "turn-sealed", turnId: "turn-x", tabId: "rc" });
		await tick(); // reconcile refetch is async
		tab = store.tabs.find((t) => t.id === "rc");
		expect(tab?.live.length).toBe(0);
		expect(tab?.chunks.map((c) => c.seq)).toEqual([0, 1]);
		expect(tab?.renderGroups.map((m) => m.role)).toEqual(["user", "assistant"]);
		// The sealed messages carry the SAME turn id as the live ones did, so the
		// turn-scoped render key is stable across reconcile (no remount/flash).
		expect(tab?.renderGroups.every((m) => m.turnId === "turn-x")).toBe(true);
	});

	it("defers reconcile while scrolled up, then runs it on return to bottom", async () => {
		const sealed = [chunkRow("u", "df", 0, "turn-y", "user", "text", { text: "q" })];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.split("?")[0]?.endsWith("/tabs/df/chunks"))
					return Promise.resolve(chunksResponse(sealed, 1));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "df",
			title: "DF",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		store.handleEvent({ type: "turn-start", turnId: "turn-y", tabId: "df" });
		store.handleEvent({ type: "text-delta", delta: "partial", tabId: "df" });
		store.setScrolledUp("df", true);
		store.handleEvent({ type: "turn-sealed", turnId: "turn-y", tabId: "df" });
		await tick();
		// Deferred: live tail still present, not yet folded into sealed chunks.
		expect(store.tabs.find((t) => t.id === "df")?.live.length).toBe(1);

		store.setScrolledUp("df", false);
		await tick();
		const tab = store.tabs.find((t) => t.id === "df");
		expect(tab?.live.length).toBe(0);
		expect(tab?.chunks.length).toBe(1);
	});

	it("preserves an optimistic queued user message when an earlier turn reconciles", async () => {
		const sealed = [
			chunkRow("u", "q", 0, "turn-a", "user", "text", { text: "first" }),
			chunkRow("a", "q", 1, "turn-a", "assistant", "text", { text: "answer" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.split("?")[0]?.endsWith("/tabs/q/chunks"))
					return Promise.resolve(chunksResponse(sealed, 2));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "q",
			title: "Q",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		store.handleEvent({ type: "turn-start", turnId: "turn-a", tabId: "q" });
		store.handleEvent({ type: "text-delta", delta: "answer", tabId: "q" });
		// User queues a follow-up WHILE turn-a streams (optimistic, no turn id yet).
		store.handleEvent({
			type: "message-queued",
			tabId: "q",
			messageId: "q1",
			message: "do this next",
		});
		expect(store.tabs.find((t) => t.id === "q")?.live.some((m) => m.id === "queued-q1")).toBe(true);

		// turn-a seals → reconcile. The queued user bubble must survive.
		store.handleEvent({ type: "turn-sealed", turnId: "turn-a", tabId: "q" });
		await tick();
		const tab = store.tabs.find((t) => t.id === "q");
		expect(tab?.chunks.map((c) => c.seq)).toEqual([0, 1]);
		expect(tab?.live.some((m) => m.id === "queued-q1")).toBe(true);
		// The sealed turn's assistant was folded out of the live tail.
		expect(tab?.live.some((m) => m.role === "assistant")).toBe(false);
	});

	it("turn-start backfill skips a pending queued row (race), tags only the initiator", async () => {
		// Realistic race: the user sends a prompt (plain optimistic row, no turn id
		// yet) and, before the WS `turn-start` arrives, sends a follow-up that the
		// backend queues (`queued-` prefix). When `turn-start` finally lands, the
		// backfill must tag ONLY the plain initiator and SKIP the pending queued
		// row — otherwise the queued row inherits the sealing turn's id and is
		// wiped on reconcile (the Pass-2 Blocker).
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "rq",
			title: "RQ",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		store.switchTab("rq"); // sendMessage targets the active tab
		const sealed = [
			chunkRow("u", "rq", 0, "turn-a", "user", "text", { text: "first" }),
			chunkRow("a", "rq", 1, "turn-a", "assistant", "text", { text: "answer" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, opts?: { body?: string }) => {
				const path = url.split("?")[0] ?? "";
				if (path.endsWith("/tabs/rq/chunks")) return Promise.resolve(chunksResponse(sealed, 2));
				if (path.endsWith("/chat")) {
					// The 2nd send carries a queueId → backend reports it queued.
					const queued = (opts?.body ?? "").includes("queueId");
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve(queued ? { status: "queued", messageId: "srv" } : { status: "ok" }),
					});
				}
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({}),
					text: () => Promise.resolve(""),
				});
			}),
		);

		// A freshly created tab defaults to "running"; the agent is idle here.
		store.handleEvent({ type: "status", status: "idle", tabId: "rq" });
		await store.sendMessage("first"); // idle → plain optimistic user row
		store.handleEvent({ type: "status", status: "running", tabId: "rq" });
		await store.sendMessage("second"); // running → queued (queued- prefix)

		let tab = store.tabs.find((t) => t.id === "rq");
		const initiatorId = tab?.live.find((m) => m.role === "user" && !m.id.startsWith("queued-"))?.id;
		const queuedId = tab?.live.find((m) => m.id.startsWith("queued-"))?.id;
		expect(initiatorId).toBeTruthy();
		expect(queuedId).toBeTruthy();

		// turn-start arrives LATE: the queued follow-up is already in the live tail.
		store.handleEvent({ type: "turn-start", turnId: "turn-a", tabId: "rq" });
		tab = store.tabs.find((t) => t.id === "rq");
		expect(tab?.live.find((m) => m.id === initiatorId)?.turnId).toBe("turn-a");
		expect(tab?.live.find((m) => m.id === queuedId)?.turnId).toBeUndefined();

		store.handleEvent({ type: "text-delta", delta: "answer", tabId: "rq" });
		store.handleEvent({ type: "turn-sealed", turnId: "turn-a", tabId: "rq" });
		await tick();
		tab = store.tabs.find((t) => t.id === "rq");
		// Initiator folded cleanly into its sealed row (no duplicate user bubble);
		// the queued follow-up survives, still untagged and still queued.
		expect(tab?.chunks.map((c) => c.seq)).toEqual([0, 1]);
		expect(tab?.live.find((m) => m.id === queuedId)?.turnId).toBeUndefined();
		expect(tab?.live.some((m) => m.role === "assistant")).toBe(false);
		expect(tab?.renderGroups.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("a consumed interrupt message collapses into the sealed turn (no lingering bubble)", async () => {
		// During a running turn the user queues a message; the agent CONSUMES it
		// (interrupt), folding its text into the turn's persisted chunks. The
		// frontend's consumed user bubble must be BOUND to the in-flight turn so it
		// is dropped on reconcile — otherwise it lingers untagged forever AND
		// duplicates the interrupt text now living in the sealed chunk (Pass-3 Block).
		const sealed = [
			chunkRow("u", "ic", 0, "turn-a", "user", "text", { text: "do a thing" }),
			chunkRow("a", "ic", 1, "turn-a", "assistant", "text", { text: "working ...resumed" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.split("?")[0]?.endsWith("/tabs/ic/chunks"))
					return Promise.resolve(chunksResponse(sealed, 2));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "ic",
			title: "IC",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		store.handleEvent({ type: "turn-start", turnId: "turn-a", tabId: "ic" });
		store.handleEvent({ type: "text-delta", delta: "working", tabId: "ic" });
		store.handleEvent({ type: "message-queued", tabId: "ic", messageId: "qx", message: "stop" });
		// Agent consumes the queued message mid-turn (interrupt injection).
		store.handleEvent({ type: "message-consumed", tabId: "ic", messageIds: ["qx"] });
		let tab = store.tabs.find((t) => t.id === "ic");
		const consumed = tab?.live.find((m) => m.id === "qx");
		expect(consumed).toBeTruthy();
		// The fix: the consumed row is bound to the active turn, not left untagged.
		expect(consumed?.turnId).toBe("turn-a");
		expect(tab?.queuedMessages.some((m) => m.id === "qx")).toBe(false);

		store.handleEvent({ type: "text-delta", delta: "resumed", tabId: "ic" });
		store.handleEvent({ type: "turn-sealed", turnId: "turn-a", tabId: "ic" });
		await tick();
		tab = store.tabs.find((t) => t.id === "ic");
		// Collapsed to the persisted shape: the consumed bubble was dropped; only
		// the sealed chunks remain (no lingering / duplicated interrupt bubble).
		expect(tab?.live.length).toBe(0);
		expect(tab?.live.some((m) => m.id === "qx")).toBe(false);
		expect(tab?.chunks.map((c) => c.seq)).toEqual([0, 1]);
	});

	it("a continuation-consumed queued message becomes the next turn's initiator", async () => {
		// The turn-end fix: a message queued during turn-a is drained AFTER the
		// turn ends (reason: "continuation") to START turn-b. Its optimistic
		// `queued-` bubble must collapse into a single UNTAGGED user row so the
		// imminent turn-b `turn-start` tags it as that turn's initiator — and it
		// then folds cleanly into turn-b's sealed chunks (no linger, no dup).
		const sealedB = [
			chunkRow("ua", "cc", 0, "turn-a", "user", "text", { text: "first" }),
			chunkRow("aa", "cc", 1, "turn-a", "assistant", "text", { text: "first answer" }),
			chunkRow("ub", "cc", 2, "turn-b", "user", "text", { text: "next please" }),
			chunkRow("ab", "cc", 3, "turn-b", "assistant", "text", { text: "second answer" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.split("?")[0]?.endsWith("/tabs/cc/chunks"))
					return Promise.resolve(chunksResponse(sealedB, 4));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "cc",
			title: "CC",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		// Turn A streams; user queues a follow-up while it runs.
		store.handleEvent({ type: "turn-start", turnId: "turn-a", tabId: "cc" });
		store.handleEvent({ type: "text-delta", delta: "first answer", tabId: "cc" });
		store.handleEvent({
			type: "message-queued",
			tabId: "cc",
			messageId: "q1",
			message: "next please",
		});
		let tab = store.tabs.find((t) => t.id === "cc");
		expect(tab?.live.some((m) => m.id === "queued-q1")).toBe(true);

		// Turn A ends. The backend drains the queue as a CONTINUATION (not an
		// interrupt) and emits message-consumed{reason:"continuation"}.
		store.handleEvent({
			type: "message-consumed",
			tabId: "cc",
			messageIds: ["q1"],
			reason: "continuation",
		});
		tab = store.tabs.find((t) => t.id === "cc");
		// The queued- bubble collapsed into ONE plain (untagged, un-prefixed) user row.
		expect(tab?.live.some((m) => m.id === "queued-q1")).toBe(false);
		const initiator = tab?.live.find((m) => m.role === "user");
		expect(initiator).toBeTruthy();
		expect(initiator?.id.startsWith("queued-")).toBe(false);
		expect(initiator?.turnId).toBeUndefined();
		expect(tab?.queuedMessages.some((m) => m.id === "q1")).toBe(false);

		// turn-a seals first (it was the running turn when the queue drained).
		store.handleEvent({ type: "turn-sealed", turnId: "turn-a", tabId: "cc" });
		// Now turn-b starts — it must tag the collapsed initiator row.
		store.handleEvent({ type: "turn-start", turnId: "turn-b", tabId: "cc" });
		tab = store.tabs.find((t) => t.id === "cc");
		const taggedInitiator = tab?.live.find((m) => m.role === "user" && m.turnId === "turn-b");
		expect(taggedInitiator).toBeTruthy();

		store.handleEvent({ type: "text-delta", delta: "second answer", tabId: "cc" });
		store.handleEvent({ type: "turn-sealed", turnId: "turn-b", tabId: "cc" });
		await tick();
		tab = store.tabs.find((t) => t.id === "cc");
		// Both turns are durable; the live tail is empty (initiator folded into
		// turn-b, no lingering/duplicated user bubble).
		expect(tab?.chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
		expect(tab?.live.length).toBe(0);
		expect(tab?.renderGroups.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("collapses MULTIPLE continuation-consumed queued messages into one initiator row", async () => {
		// The backend joins several drained queued messages into a SINGLE user
		// turn (with a "\n---\n" separator). The frontend must mirror that: N
		// optimistic `queued-` bubbles collapse into exactly ONE untagged user
		// row carrying the joined text, which the next turn-start then tags.
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "mc",
			title: "MC",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		store.handleEvent({ type: "turn-start", turnId: "turn-a", tabId: "mc" });
		store.handleEvent({ type: "text-delta", delta: "answer", tabId: "mc" });
		// Two follow-ups queued while turn-a streams.
		store.handleEvent({ type: "message-queued", tabId: "mc", messageId: "q1", message: "first" });
		store.handleEvent({ type: "message-queued", tabId: "mc", messageId: "q2", message: "second" });
		let tab = store.tabs.find((t) => t.id === "mc");
		expect(tab?.live.filter((m) => m.id.startsWith("queued-")).length).toBe(2);

		// Turn ends; backend drains BOTH as one continuation.
		store.handleEvent({
			type: "message-consumed",
			tabId: "mc",
			messageIds: ["q1", "q2"],
			reason: "continuation",
		});
		tab = store.tabs.find((t) => t.id === "mc");
		// Exactly one user row, untagged, with the joined text — no queued- bubbles left.
		const userRows = tab?.live.filter((m) => m.role === "user") ?? [];
		expect(userRows.length).toBe(1);
		expect(userRows[0]?.id.startsWith("queued-")).toBe(false);
		expect(userRows[0]?.turnId).toBeUndefined();
		const textChunk = userRows[0]?.chunks.find((c) => c.type === "text");
		expect(textChunk && textChunk.type === "text" ? textChunk.text : "").toBe("first\n---\nsecond");
		expect(tab?.queuedMessages.length).toBe(0);

		// The next turn-start tags that single collapsed row as its initiator.
		store.handleEvent({ type: "turn-sealed", turnId: "turn-a", tabId: "mc" });
		store.handleEvent({ type: "turn-start", turnId: "turn-b", tabId: "mc" });
		tab = store.tabs.find((t) => t.id === "mc");
		const tagged = tab?.live.filter((m) => m.role === "user" && m.turnId === "turn-b") ?? [];
		expect(tagged.length).toBe(1);
	});

	it("preserves a concurrent newer turn when an earlier deferred reconcile flushes", async () => {
		const sealedA = [
			chunkRow("ua", "c", 0, "turn-a", "user", "text", { text: "A?" }),
			chunkRow("aa", "c", 1, "turn-a", "assistant", "text", { text: "A!" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.split("?")[0]?.endsWith("/tabs/c/chunks"))
					return Promise.resolve(chunksResponse(sealedA, 2));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);
		const store = createTabStore();
		store.handleEvent({
			type: "tab-created",
			id: "c",
			title: "C",
			keyId: null,
			modelId: null,
			parentTabId: null,
		});
		// Turn A streams; user scrolls up; A finishes → reconcile deferred.
		store.handleEvent({ type: "turn-start", turnId: "turn-a", tabId: "c" });
		store.handleEvent({ type: "text-delta", delta: "A!", tabId: "c" });
		store.setScrolledUp("c", true);
		store.handleEvent({ type: "status", status: "idle", tabId: "c" });
		store.handleEvent({ type: "turn-sealed", turnId: "turn-a", tabId: "c" });
		// Turn B (a queued message) starts streaming while still scrolled up.
		store.handleEvent({ type: "turn-start", turnId: "turn-b", tabId: "c" });
		store.handleEvent({ type: "status", status: "running", tabId: "c" });
		store.handleEvent({ type: "text-delta", delta: "B in progress", tabId: "c" });
		let tab = store.tabs.find((t) => t.id === "c");
		expect(tab?.liveTurnId).toBe("turn-b");
		const bId = tab?.currentAssistantId;
		expect(bId).toBeTruthy();

		// User scrolls down → the deferred reconcile for turn-a flushes.
		store.setScrolledUp("c", false);
		await tick();
		tab = store.tabs.find((t) => t.id === "c");
		// Turn A folded into the sealed log...
		expect(tab?.chunks.map((c) => c.seq)).toEqual([0, 1]);
		// ...but turn B's in-flight state survived intact (no wipe / no remount).
		expect(tab?.liveTurnId).toBe("turn-b");
		expect(tab?.currentAssistantId).toBe(bId);
		expect(tab?.live.some((m) => m.turnId === "turn-b")).toBe(true);
		expect(tab?.live.some((m) => m.turnId === "turn-a")).toBe(false);
	});
});

describe("tabStore — tab reorder", () => {
	it("reorders user tabs and persists the new order", async () => {
		const calls: Array<{ url: string; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, opts?: { body?: string }) => {
				calls.push({ url, body: opts?.body ?? "" });
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
			}),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		const b = await store.createNewTab();
		const c = await store.createNewTab();
		expect(store.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);

		// Move the last tab to the front.
		store.reorderTabs([c.id, a.id, b.id]);
		expect(store.tabs.map((t) => t.id)).toEqual([c.id, a.id, b.id]);

		const reorderCall = calls.find((call) => call.url.endsWith("/tabs/reorder"));
		expect(reorderCall).toBeTruthy();
		expect(JSON.parse(reorderCall?.body ?? "{}")).toEqual({ ids: [c.id, a.id, b.id] });
	});

	it("ignores a stale order that doesn't cover all user tabs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		const b = await store.createNewTab();
		store.reorderTabs([a.id]); // missing b → no-op
		expect(store.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
	});

	it("keeps subagent tabs after the user tabs when reordering", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		const b = await store.createNewTab();
		// A subagent tab arrives via WS (parentTabId set).
		store.handleEvent({
			type: "tab-created",
			id: "sub",
			title: "Sub",
			keyId: null,
			modelId: null,
			parentTabId: a.id,
		});
		store.reorderTabs([b.id, a.id]);
		const ids = store.tabs.map((t) => t.id);
		expect(ids).toEqual([b.id, a.id, "sub"]);
	});
});

describe("tabStore — rename + auto-title guard", () => {
	it("renameTab sets the title and persists it", async () => {
		const calls: Array<{ url: string; method?: string; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, opts?: { method?: string; body?: string }) => {
				calls.push({ url, method: opts?.method, body: opts?.body ?? "" });
				return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
			}),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		store.renameTab(a.id, "  My Tab  ");
		expect(store.tabs[0]?.title).toBe("My Tab");
		expect(store.tabs[0]?.manualTitle).toBe(true);
		const patch = calls.find(
			(call) => call.url.endsWith(`/tabs/${a.id}`) && call.method === "PATCH",
		);
		expect(JSON.parse(patch?.body ?? "{}")).toEqual({ title: "My Tab" });
	});

	it("renameTab ignores an empty/whitespace name", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		store.renameTab(a.id, "   ");
		expect(store.tabs[0]?.title).toBe("New Tab");
		expect(store.tabs[0]?.manualTitle).toBe(false);
	});

	it("sendMessage does NOT auto-title a manually renamed tab", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) })),
		);
		const store = createTabStore();
		await store.createNewTab();
		store.renameTab(store.tabs[0]?.id ?? "", "Keep Me");
		await store.sendMessage("hello there this is the first message");
		expect(store.tabs[0]?.title).toBe("Keep Me");
	});

	it("sendMessage still auto-titles a tab that was never renamed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) })),
		);
		const store = createTabStore();
		await store.createNewTab();
		await store.sendMessage("first message becomes the title");
		expect(store.tabs[0]?.title).toBe("first message becomes the title");
		expect(store.tabs[0]?.manualTitle).toBe(false);
	});
});

describe("tabStore — per-tab chat input draft", () => {
	it("stores drafts per tab and restores them on switch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		const b = await store.createNewTab();

		store.switchTab(a.id);
		store.setDraft(a.id, "draft for A");
		store.switchTab(b.id);
		store.setDraft(b.id, "draft for B");

		// Active tab is B → its draft is exposed.
		expect(store.activeTab?.draft).toBe("draft for B");
		// Switching back to A restores A's draft without clobbering B's.
		store.switchTab(a.id);
		expect(store.activeTab?.draft).toBe("draft for A");
		expect(store.tabs.find((t) => t.id === b.id)?.draft).toBe("draft for B");
	});

	it("new tabs start with an empty draft and setDraft no-ops for unknown tabs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		expect(a.draft).toBe("");
		store.setDraft("nope", "ignored"); // unknown tab → no throw, no effect
		expect(store.tabs.every((t) => t.draft === "")).toBe(true);
	});
});

describe("tabStore — image/pdf attachments", () => {
	function imgAttachment(id: string) {
		return { id, kind: "image" as const, mediaType: "image/png", data: "QQ==" };
	}

	it("stages attachments and reconciles them against intact draft tokens", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const a = await store.createNewTab();
		store.switchTab(a.id);

		store.addAttachment(a.id, imgAttachment("aaaaaa"));
		// Draft carries the token → attachment survives.
		store.setDraft(a.id, "look 【image:aaaaaa】");
		expect(store.activeTab?.attachments.map((x) => x.id)).toEqual(["aaaaaa"]);

		// Remove the token from the draft → attachment is detached.
		store.setDraft(a.id, "look ");
		expect(store.activeTab?.attachments).toHaveLength(0);
	});

	it("sendMessage posts ordered multimodal content and clears the draft", async () => {
		const fetchMock = vi.fn((url: string) => {
			if (typeof url === "string" && url.endsWith("/chat")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});
		vi.stubGlobal("fetch", fetchMock);

		const store = createTabStore();
		const a = await store.createNewTab();
		store.switchTab(a.id);

		await store.sendMessage("here is A: [image]", [
			{ type: "text", text: "here is A: " },
			{ type: "attachment", mediaType: "image/png", data: "QQ==" },
		]);

		const chatCall = fetchMock.mock.calls.find(
			(c) => typeof c[0] === "string" && (c[0] as string).endsWith("/chat"),
		);
		expect(chatCall).toBeDefined();
		const body = JSON.parse((chatCall?.[1] as { body: string }).body);
		expect(body.message).toBe("here is A: [image]");
		expect(body.content).toEqual([
			{ type: "text", text: "here is A: " },
			{ type: "attachment", mediaType: "image/png", data: "QQ==" },
		]);
	});

	it("sendMessage omits content for a plain-text message", async () => {
		const fetchMock = vi.fn((url: string) => {
			if (typeof url === "string" && url.endsWith("/chat")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});
		vi.stubGlobal("fetch", fetchMock);

		const store = createTabStore();
		await store.createNewTab();
		await store.sendMessage("just text");

		const chatCall = fetchMock.mock.calls.find(
			(c) => typeof c[0] === "string" && (c[0] as string).endsWith("/chat"),
		);
		const body = JSON.parse((chatCall?.[1] as { body: string }).body);
		expect(body.content).toBeUndefined();
	});
});
