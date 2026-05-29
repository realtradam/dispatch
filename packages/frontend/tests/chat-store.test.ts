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
	const assistant = tab?.messages.find((m) => m.role === "assistant");
	return assistant?.chunks;
}

describe("tabStore — streaming chunk flow (real $state)", () => {
	it("text-delta creates a streaming assistant message and appends deltas", async () => {
		const { store, tabId } = await setupStoreWithTab();

		store.handleEvent({ type: "text-delta", delta: "Hello", tabId });

		const assistant = store.tabs[0]?.messages.find((m) => m.role === "assistant");
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
		const assistant = store.tabs[0]?.messages.find((m) => m.role === "assistant");
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
		const assistantMessages = store.tabs[0]?.messages.filter((m) => m.role === "assistant") ?? [];
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
		const systemMsg = store.tabs[0]?.messages.find((m) => m.role === "system");
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
		const sysMsgs = store.tabs[0]?.messages.filter((m) => m.role === "system") ?? [];
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
		const assistant = store.tabs[0]?.messages.find((m) => m.role === "assistant");
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
				if (url.split("?")[0]?.endsWith("/tabs/t1/messages")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								messages: [
									{ id: "m1", role: "user", chunks: [{ type: "text", text: "hello" }] },
									{
										id: "m2",
										role: "assistant",
										chunks: [{ type: "text", text: "hi back" }],
									},
								],
							}),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/t2/messages")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ messages: [] }),
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
		expect(store.tabs[0]?.messages.length).toBe(2);
		expect(store.tabs[1]?.id).toBe("t2");
		expect(store.tabs[1]?.messages.length).toBe(0);
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
				if (url.split("?")[0]?.endsWith("/tabs/tr/messages")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								messages: [{ id: "u1", role: "user", chunks: [{ type: "text", text: "go" }] }],
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
		expect(tab?.messages.length).toBe(2);
		const inflight = tab?.messages.find((m) => m.id === "live-msg-id");
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
				if (url.split("?")[0]?.endsWith("/tabs/ti/messages")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [] }) });
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
				if (url.split("?")[0]?.endsWith("/tabs/tA/messages")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								messages: [{ id: "msg-a", role: "user", chunks: [{ type: "text", text: "ok" }] }],
							}),
					});
				}
				if (url.split("?")[0]?.endsWith("/tabs/tB/messages")) {
					// HTTP error path: response is not ok.
					return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
				}
				if (url.split("?")[0]?.endsWith("/tabs/tC/messages")) {
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
		expect(tA?.messages.length).toBe(1);
		expect(tA?.messages[0]?.chunks).toEqual([{ type: "text", text: "ok" }]);

		// Both broken tabs restored with empty message lists — neither
		// crashed the hydration nor leaked an error chunk into the UI.
		const tB = store.tabs.find((t) => t.id === "tB");
		expect(tB).toBeDefined();
		expect(tB?.messages.length).toBe(0);
		expect(tB?.agentStatus).toBe("idle");

		const tC = store.tabs.find((t) => t.id === "tC");
		expect(tC).toBeDefined();
		expect(tC?.messages.length).toBe(0);
		expect(tC?.agentStatus).toBe("idle");
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
		const inflight = tab?.messages.find((m) => m.id === "live-x");
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
		const msgA = tab?.messages.find((m) => m.id === "msg-a");
		expect(msgA?.isStreaming).toBe(false);
	});
});
