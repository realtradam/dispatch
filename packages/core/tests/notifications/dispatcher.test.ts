import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationEvent, NtfyConfig } from "../../src/notifications/types.js";

// The dispatcher imports `loadNtfyConfig` from config.ts, which transitively
// pulls in `db/index.js` (bun:sqlite). Stub the DB so vitest under Node can
// load this file. All tests inject `loadConfig` explicitly, so the real
// settings table is never read.
vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => ({
		query: () => ({ get: () => null, run: () => {} }),
		run: () => {},
	})),
}));

const { NotificationDispatcher } = await import("../../src/notifications/dispatcher.js");

function makeConfig(overrides: Partial<NtfyConfig> = {}): NtfyConfig {
	return {
		enabled: true,
		topicUrl: "https://ntfy.sh/topic",
		authToken: "",
		events: {
			"turn-completed": true,
			"turn-error": true,
			"permission-required": true,
			"agent-spawned": true,
		},
		// Default to true in the test config so existing tests (which never
		// configure a getTabParentId lookup) keep firing for tab-1 / tab-2 / etc.
		// Tests of the new subagent gating override this explicitly.
		notifySubagents: true,
		...overrides,
	};
}

interface FakeAgentSource {
	onEvent(
		listener: (event: { type: string; tabId: string; [k: string]: unknown }) => void,
	): () => void;
	emit(event: { type: string; tabId: string; [k: string]: unknown }): void;
}

function makeAgentSource(): FakeAgentSource {
	let l: ((event: { type: string; tabId: string; [k: string]: unknown }) => void) | null = null;
	return {
		onEvent(listener) {
			l = listener;
			return () => {
				l = null;
			};
		},
		emit(event) {
			l?.(event);
		},
	};
}

interface FakePermissionSource {
	onPromptAdded(
		listener: (prompt: { id: string; permission: string; description: string }) => void,
	): () => void;
	emit(prompt: { id: string; permission: string; description: string }): void;
}

function makePermissionSource(): FakePermissionSource {
	let l: ((prompt: { id: string; permission: string; description: string }) => void) | null = null;
	return {
		onPromptAdded(listener) {
			l = listener;
			return () => {
				l = null;
			};
		},
		emit(p) {
			l?.(p);
		},
	};
}

// Microtask flush so the dispatcher's `void Promise.resolve(...).catch(...)`
// has a chance to settle before assertions.
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("NotificationDispatcher.notify", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("does not send when master switch is disabled", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ enabled: false }),
			send,
		});
		d.notify({ type: "turn-completed", title: "x", message: "y" });
		await flush();
		expect(send).not.toHaveBeenCalled();
	});

	it("does not send when per-event-type toggle is off", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const d = new NotificationDispatcher({
			loadConfig: () =>
				makeConfig({
					events: {
						"turn-completed": false,
						"turn-error": true,
						"permission-required": true,
						"agent-spawned": false,
					},
				}),
			send,
		});
		d.notify({ type: "turn-completed", title: "x", message: "y" });
		await flush();
		expect(send).not.toHaveBeenCalled();
	});

	it("sends when enabled and toggle is on", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.notify({ type: "turn-completed", title: "x", message: "y" });
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not throw or block when the transport rejects", async () => {
		const send = vi.fn(async () => {
			throw new Error("boom");
		});
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		expect(() => d.notify({ type: "turn-completed", title: "x", message: "y" })).not.toThrow();
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("dedupes events with the same dedupeKey within the window", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig(),
			send,
			dedupeWindowMs: 1000,
		});
		const event: NotificationEvent = {
			type: "permission-required",
			title: "p",
			message: "p",
			dedupeKey: "permission:42",
		};
		d.notify(event);
		d.notify(event);
		d.notify(event);
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not dedupe events without a dedupeKey", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.notify({ type: "turn-completed", title: "x", message: "y" });
		d.notify({ type: "turn-completed", title: "x", message: "y" });
		await flush();
		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe("NotificationDispatcher.attachToAgentManager", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("maps `done` → turn-completed (with tab title in the body)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig(),
			send,
			getTabTitle: (id) => (id === "tab-1" ? "My chat" : null),
		});
		d.attachToAgentManager(source);
		source.emit({ type: "done", tabId: "tab-1", message: { role: "assistant", chunks: [] } });
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		const event = send.mock.calls[0][1] as NotificationEvent;
		expect(event.type).toBe("turn-completed");
		expect(event.title).toContain("My chat");
		expect(event.tabId).toBe("tab-1");
	});

	it("maps `error` → turn-error and includes the error text", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.attachToAgentManager(source);
		source.emit({ type: "error", tabId: "tab-1", error: "Rate limit", statusCode: 429 });
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		const event = send.mock.calls[0][1] as NotificationEvent;
		expect(event.type).toBe("turn-error");
		expect(event.message).toContain("Rate limit");
		expect(event.message).toContain("429");
	});

	it("ignores `status` events (would spam every transition)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.attachToAgentManager(source);
		source.emit({ type: "status", tabId: "tab-1", status: "running" });
		source.emit({ type: "status", tabId: "tab-1", status: "idle" });
		await flush();
		expect(send).not.toHaveBeenCalled();
	});

	it("maps `tab-created` to agent-spawned only for top-level user agents (parentTabId=null AND agentSlug set)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.attachToAgentManager(source);

		// Manual "new tab" with no agent slug ⇒ no notification.
		source.emit({
			type: "tab-created",
			tabId: "tab-1",
			id: "tab-1",
			title: "New Tab",
			parentTabId: null,
			agentSlug: null,
		});
		// Subagent (has a parent) ⇒ no notification.
		source.emit({
			type: "tab-created",
			tabId: "tab-2",
			id: "tab-2",
			title: "Subagent",
			parentTabId: "tab-1",
			agentSlug: "researcher",
		});
		// Top-level user agent ⇒ notify.
		source.emit({
			type: "tab-created",
			tabId: "tab-3",
			id: "tab-3",
			title: "Refactor auth code",
			parentTabId: null,
			agentSlug: "engineer",
		});
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		const event = send.mock.calls[0][1] as NotificationEvent;
		expect(event.type).toBe("agent-spawned");
		expect(event.message).toBe("Refactor auth code");
		expect(event.title).toContain("engineer");
	});

	it("respects the per-event-type toggle (turn-completed off ⇒ silent)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () =>
				makeConfig({
					events: {
						"turn-completed": false,
						"turn-error": true,
						"permission-required": true,
						"agent-spawned": false,
					},
				}),
			send,
		});
		d.attachToAgentManager(source);
		source.emit({ type: "done", tabId: "tab-1", message: { role: "assistant", chunks: [] } });
		await flush();
		expect(send).not.toHaveBeenCalled();
	});
});

describe("NotificationDispatcher.attachToPermissionManager", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("notifies once per unique prompt id (dedupes re-emits)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makePermissionSource();
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.attachToPermissionManager(source);

		source.emit({ id: "1", permission: "bash", description: "Run git status" });
		source.emit({ id: "1", permission: "bash", description: "Run git status" });
		source.emit({ id: "2", permission: "read", description: "Read /etc/hosts" });
		await flush();
		expect(send).toHaveBeenCalledTimes(2);
		const events = send.mock.calls.map((c) => c[1] as NotificationEvent);
		expect(events.map((e) => e.type)).toEqual(["permission-required", "permission-required"]);
		expect(events.every((e) => e.dedupeKey?.startsWith("permission:"))).toBe(true);
	});
});

describe("NotificationDispatcher.dispose", () => {
	it("releases attached subscriptions", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({ loadConfig: () => makeConfig(), send });
		d.attachToAgentManager(source);
		d.dispose();
		source.emit({ type: "done", tabId: "tab-1", message: { role: "assistant", chunks: [] } });
		await flush();
		expect(send).not.toHaveBeenCalled();
	});
});

describe("NotificationDispatcher subagent suppression (notifySubagents flag)", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	const parents = new Map<string, string | null>([
		["top-level", null],
		["subagent", "top-level"],
	]);
	const getTabParentId = (id: string): string | null | undefined => parents.get(id);

	it("suppresses turn-completed from subagent tabs when notifySubagents=false (default)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: false }),
			send,
			getTabParentId,
		});
		d.attachToAgentManager(source);

		source.emit({ type: "done", tabId: "subagent", message: { role: "assistant", chunks: [] } });
		source.emit({ type: "done", tabId: "top-level", message: { role: "assistant", chunks: [] } });
		await flush();

		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0][1] as NotificationEvent).tabId).toBe("top-level");
	});

	it("suppresses turn-error from subagent tabs when notifySubagents=false", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: false }),
			send,
			getTabParentId,
		});
		d.attachToAgentManager(source);

		source.emit({ type: "error", tabId: "subagent", error: "boom" });
		source.emit({ type: "error", tabId: "top-level", error: "boom" });
		await flush();

		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0][1] as NotificationEvent).tabId).toBe("top-level");
	});

	it("still notifies subagents when notifySubagents=true", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: true }),
			send,
			getTabParentId,
		});
		d.attachToAgentManager(source);

		source.emit({ type: "done", tabId: "subagent", message: { role: "assistant", chunks: [] } });
		source.emit({ type: "done", tabId: "top-level", message: { role: "assistant", chunks: [] } });
		await flush();

		expect(send).toHaveBeenCalledTimes(2);
	});

	it("does NOT gate permission-required (subagents must still get human input)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const psource = makePermissionSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: false }),
			send,
			getTabParentId,
		});
		d.attachToPermissionManager(psource);

		psource.emit({ id: "p1", permission: "bash", description: "git status" });
		await flush();

		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0][1] as NotificationEvent).type).toBe("permission-required");
	});

	it("falls back to notifying when getTabParentId is not provided (treat as top-level)", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: false }),
			send,
			// intentionally NO getTabParentId
		});
		d.attachToAgentManager(source);

		source.emit({ type: "done", tabId: "anything", message: { role: "assistant", chunks: [] } });
		await flush();

		// Without a lookup, the dispatcher can't prove this is a subagent; it
		// must err on the side of notifying so legitimate top-level events
		// aren't silently dropped.
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("falls back to notifying when getTabParentId throws or returns undefined", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const source = makeAgentSource();
		const d = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: false }),
			send,
			getTabParentId: () => {
				throw new Error("db unavailable");
			},
		});
		d.attachToAgentManager(source);

		source.emit({ type: "done", tabId: "x", message: { role: "assistant", chunks: [] } });
		await flush();
		expect(send).toHaveBeenCalledTimes(1);

		const send2 = vi.fn(async () => ({ ok: true }));
		const source2 = makeAgentSource();
		const d2 = new NotificationDispatcher({
			loadConfig: () => makeConfig({ notifySubagents: false }),
			send: send2,
			getTabParentId: () => undefined,
		});
		d2.attachToAgentManager(source2);
		source2.emit({ type: "done", tabId: "x", message: { role: "assistant", chunks: [] } });
		await flush();
		expect(send2).toHaveBeenCalledTimes(1);
	});
});
