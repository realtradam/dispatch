import type { ToolDefinition } from "@dispatch/core";
import { describe, expect, it, vi } from "vitest";

// Seedable backing stores for the tabs route (GET /tabs enrichment). Declared
// before vi.mock so the hoisted factory closure can reference them; populated
// per-test.
interface FakeOpenTab {
	id: string;
	title: string;
	keyId: string | null;
	modelId: string | null;
	parentTabId: string | null;
	status: string;
	isOpen: boolean;
	position: number;
	createdAt: number;
	updatedAt: number;
}
const fakeOpenTabs: FakeOpenTab[] = [];
const fakeUsageStats = new Map<string, unknown>();

// Mock @dispatch/core's Agent to avoid real LLM calls
vi.mock("@dispatch/core", () => ({
	Agent: class MockAgent {
		status = "idle";
		messages: unknown[] = [];
		async *run(_message: string) {
			yield { type: "status", status: "running" } as const;
			// Simulate some processing time so status stays "running"
			await new Promise<void>((r) => setTimeout(r, 100));
			yield { type: "text-delta", delta: "Hello " } as const;
			yield { type: "text-delta", delta: "world" } as const;
			yield {
				type: "done",
				message: {
					role: "assistant",
					chunks: [{ type: "text", text: "Hello world" }],
				},
			} as const;
			yield { type: "status", status: "idle" } as const;
		}
	},
	PermissionService: class MockPermissionService {
		ask(_request: unknown, _rulesets: unknown[]) {
			return Promise.resolve("once");
		}
		reply(_id: string, _reply: unknown) {}
		getPending() {
			return [];
		}
	},
	createReadFileTool(_wd: string): ToolDefinition {
		return {
			name: "read_file",
			description: "read a file",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => "mock file content",
		};
	},
	createReadFileSliceTool(_wd: string): ToolDefinition {
		return {
			name: "read_file_slice",
			description: "read a char slice of a single line",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => "mock slice",
		};
	},
	clearSpillForTab(_tabId: string) {},
	createWriteFileTool(_wd: string): ToolDefinition {
		return {
			name: "write_file",
			description: "write a file",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => true,
		};
	},
	createListFilesTool(_wd: string): ToolDefinition {
		return {
			name: "list_files",
			description: "list files",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => ["file1.ts"],
		};
	},
	createRunShellTool(_wd: string): ToolDefinition {
		return {
			name: "run_shell",
			description: "run shell command",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};
	},
	loadConfig(_dir: string) {
		return { permissions: {} };
	},
	configToRuleset(_config: unknown) {
		return [];
	},
	validateConfig(_config: unknown) {
		return { config: _config, errors: [] };
	},
	createConfigWatcher(_dir: string, _onChange: unknown) {
		return { close() {} };
	},
	loadSkills(_dir: string) {
		return { skills: [], mappings: [] };
	},
	createSkillsWatcher(_dir: string, _onChange: unknown) {
		return { close() {} };
	},
	ModelRegistry: class MockModelRegistry {
		getModels() {
			return [];
		}
		getKeys() {
			return [];
		}
		getModelsByTag(_tag: string) {
			return [];
		}
		getAllTags() {
			return [];
		}
		hasAvailableKey(_provider: string) {
			return false;
		}
		allKeysExhausted() {
			return true;
		}
		markKeyExhausted() {}
		markKeyActive() {}
		updateConfig() {}
	},
	ModelResolver: class MockModelResolver {
		resolve(_tag: string) {
			return null;
		}
		waitForKey() {
			return Promise.resolve(null);
		}
	},
	TaskList: class MockTaskList {
		getTasks() {
			return [];
		}
		getTask() {
			return undefined;
		}
		addTask() {
			return { id: "task-1", title: "", description: "", status: "pending" };
		}
		updateTask() {
			return undefined;
		}
		removeTask() {
			return false;
		}
		onChange(_cb: unknown) {
			return () => {};
		}
	},
	createTaskListTool(_taskList: unknown) {
		return {
			name: "todo",
			description: "todo",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createSummonTool(_wd: string, _callbacks: unknown) {
		return {
			name: "summon",
			description: "summon",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createRetrieveTool(_callbacks: unknown) {
		return {
			name: "retrieve",
			description: "retrieve",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createTab() {},
	getTab() {
		return null;
	},
	listOpenTabs() {
		return [...fakeOpenTabs];
	},
	resolveTabPrefix() {
		return { status: "none" };
	},
	shortestUniquePrefix(id: string) {
		return (id ?? "").slice(0, 4);
	},
	createSendToTabTool(_callbacks: unknown) {
		return {
			name: "send_to_tab",
			description: "send to tab",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createReadTabTool(_callbacks: unknown) {
		return {
			name: "read_tab",
			description: "read tab",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	getClaudeAccountsFromDB() {
		return [];
	},
	refreshAccountCredentials() {
		return null;
	},
	refreshAccountCredentialsAsync() {
		return Promise.resolve(null);
	},
	resolveApiKey() {
		return null;
	},
	getSetting(_key: string) {
		return null;
	},
	appendChunks() {
		return [];
	},
	explodeUserText() {
		return [];
	},
	explodeTurn() {
		return [];
	},
	getMessagesForTab() {
		return [];
	},
	getChunksForTab() {
		return [];
	},
	groupRowsToMessages() {
		return [];
	},
	getTotalChunkCount() {
		return 0;
	},
	getUsageStatsForTab(tabId: string) {
		return fakeUsageStats.get(tabId) ?? null;
	},
	appendEventToChunks(_chunks: unknown[], _event: unknown) {
		// no-op stub
	},
	applySystemEvent(_messages: unknown[], _event: unknown) {
		return { messageId: "mock-system-msg" };
	},
	BackgroundShellStore: class MockBackgroundShellStore {
		has() {
			return false;
		}
		getResult() {
			return Promise.resolve({ status: "error", error: "not found" });
		}
	},
	BackgroundTranscriptStore: class MockBackgroundTranscriptStore {
		has() {
			return false;
		}
		getResult() {
			return Promise.resolve({ status: "error", error: "not found" });
		}
	},
	createWebSearchTool() {
		return {
			name: "web_search",
			description: "web search",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createYoutubeTranscribeTool() {
		return {
			name: "youtube_transcribe",
			description: "youtube transcribe",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	// ── models.dev context-limit stub ─────────────────────────────
	resolveContextLimit(provider: string, modelId: string) {
		if (provider === "anthropic" && modelId === "claude-sonnet-4-5") {
			return Promise.resolve(200000);
		}
		return Promise.resolve(null);
	},
	// ── ntfy notifications stubs ──────────────────────────────────
	NotificationDispatcher: class MockNotificationDispatcher {
		attachToAgentManager() {
			return () => {};
		}
		attachToPermissionManager() {
			return () => {};
		}
		notify() {}
		dispose() {}
	},
	loadNtfyConfig() {
		return {
			enabled: false,
			topic: "",
			authToken: "",
			events: {
				"turn-completed": true,
				"turn-error": true,
				"permission-required": true,
				"agent-spawned": false,
			},
			notifySubagents: false,
		};
	},
	saveNtfyConfig() {},
	normalizeNtfyConfig(c: unknown) {
		return c;
	},
	defaultNtfyConfig() {
		return {
			enabled: false,
			topic: "",
			authToken: "",
			events: {
				"turn-completed": true,
				"turn-error": true,
				"permission-required": true,
				"agent-spawned": false,
			},
			notifySubagents: false,
		};
	},
	redactNtfyConfig(c: { authToken?: string }) {
		return { ...c, authToken: "", hasAuthToken: false };
	},
	NTFY_EVENT_TYPES: ["turn-completed", "turn-error", "permission-required", "agent-spawned"],
	async sendNtfy() {
		return { ok: true };
	},
}));

const { app } = await import("../src/app.js");

describe("GET /health", () => {
	it("returns 200 with ok: true", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});

describe("GET /status", () => {
	it("returns idle status initially", async () => {
		const res = await app.request("/status");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("idle");
		expect(typeof body.messageCount).toBe("number");
	});
});

describe("POST /chat", () => {
	it("returns 200 with valid message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-1", message: "hello world" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	it("returns 400 with empty message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-1", message: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with whitespace-only message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-1", message: "   " }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with missing message field", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-1" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with missing tabId", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(res.status).toBe(400);
	});

	it("queues message when agent is already running", async () => {
		// Start a message (non-blocking)
		await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-2", message: "first message" }),
		});

		// Small delay to let the async generator start and emit "running" status
		await new Promise<void>((r) => setTimeout(r, 20));

		// Send a second — agent should queue it
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-2", message: "second message" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("queued");
		expect(typeof body.messageId).toBe("string");
	});
});

describe("GET /tabs", () => {
	it("enriches each open tab with its persisted usageStats aggregate", async () => {
		fakeOpenTabs.length = 0;
		fakeUsageStats.clear();
		fakeOpenTabs.push({
			id: "tab-u",
			title: "Has usage",
			keyId: null,
			modelId: null,
			parentTabId: null,
			status: "idle",
			isOpen: true,
			position: 0,
			createdAt: 0,
			updatedAt: 0,
		});
		fakeOpenTabs.push({
			id: "tab-none",
			title: "No usage",
			keyId: null,
			modelId: null,
			parentTabId: null,
			status: "idle",
			isOpen: true,
			position: 1,
			createdAt: 0,
			updatedAt: 0,
		});
		fakeUsageStats.set("tab-u", {
			inputTokens: 2200,
			outputTokens: 100,
			cacheReadTokens: 1000,
			cacheWriteTokens: 1000,
			requests: 2,
			last: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 100 },
		});

		const res = await app.request("/tabs");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.tabs)).toBe(true);
		const tabU = body.tabs.find((t: { id: string }) => t.id === "tab-u");
		const tabNone = body.tabs.find((t: { id: string }) => t.id === "tab-none");
		expect(tabU.usageStats).toEqual({
			inputTokens: 2200,
			outputTokens: 100,
			cacheReadTokens: 1000,
			cacheWriteTokens: 1000,
			requests: 2,
			last: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 100 },
		});
		// A tab with no usage rows surfaces null (not undefined/missing).
		expect(tabNone.usageStats).toBeNull();

		fakeOpenTabs.length = 0;
		fakeUsageStats.clear();
	});
});

describe("GET /tabs/:id/chunks", () => {
	it("returns the raw chunk window shape { chunks, total, oldestSeq }", async () => {
		const res = await app.request("/tabs/tab-x/chunks?limit=50");
		expect(res.status).toBe(200);
		const body = await res.json();
		// Mocked getChunksForTab returns [] → empty window, null cursor.
		expect(Array.isArray(body.chunks)).toBe(true);
		expect(body.chunks).toEqual([]);
		expect(body.total).toBe(0);
		expect(body.oldestSeq).toBeNull();
	});
});

describe("POST /chat/stop", () => {
	it("returns 200 with success: true for valid tabId", async () => {
		const res = await app.request("/chat/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tabId: "tab-stop-1" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ success: true });
	});

	it("returns 400 when tabId is missing", async () => {
		const res = await app.request("/chat/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});
describe("Wake schedule routes", () => {
	async function getSchedule() {
		const res = await app.request("/models/wake-schedule");
		expect(res.status).toBe(200);
		return (await res.json()) as {
			schedule: Record<string, Record<string, number>>;
			resetOffsetHours: number;
			probeSlotMinutes: number[];
			lastWake: unknown;
			pendingRetry: unknown;
		};
	}

	/**
	 * Auto-derives `action` from `timestamps` presence:
	 *   - body has `timestamps` → action = "on"
	 *   - body has no `timestamps` → action = "off"
	 * Tests can override by passing `action` explicitly. This keeps the
	 * intent-vs-state contract enforced (every request carries an explicit
	 * action) while keeping the existing test bodies short.
	 */
	async function toggle(body: Record<string, unknown>) {
		const withAction: Record<string, unknown> =
			"action" in body ? body : { ...body, action: body.timestamps !== undefined ? "on" : "off" };
		return app.request("/models/wake-schedule/toggle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(withAction),
		});
	}

	/** Build a `timestamps` payload with all 4 probe slots set to absolute ms. */
	function buildTimestamps(base: number): Record<string, number> {
		return { "0": base, "15": base + 60_000, "30": base + 120_000, "45": base + 180_000 };
	}

	it("GET returns the full snapshot shape with probeSlotMinutes, resetOffsetHours, lastWake, pendingRetry", async () => {
		const snap = await getSchedule();
		expect(snap.schedule).toBeDefined();
		expect(Number.isInteger(snap.resetOffsetHours)).toBe(true);
		expect(snap.resetOffsetHours).toBeGreaterThan(0);
		expect(snap.probeSlotMinutes).toEqual([0, 15, 30, 45]);
		expect(snap.lastWake).toBeNull();
		expect(snap.pendingRetry).toBeNull();
	});

	it("POST toggle adds an hour as 4 probe slots and removes them all together", async () => {
		const base = Date.now() + 60 * 60 * 1000; // 1 h ahead
		const timestamps = buildTimestamps(base);

		const addRes = await toggle({ hour: 9, timestamps });
		expect(addRes.status).toBe(200);
		const addBody = (await addRes.json()) as {
			schedule: Record<string, Record<string, number>>;
		};
		expect(addBody.schedule["9"]).toEqual({
			"0": base,
			"15": base + 60_000,
			"30": base + 120_000,
			"45": base + 180_000,
		});

		const removeRes = await toggle({ hour: 9 });
		expect(removeRes.status).toBe(200);
		const removeBody = (await removeRes.json()) as {
			schedule: Record<string, Record<string, number>>;
		};
		expect(removeBody.schedule["9"]).toBeUndefined();
	});

	it("POST toggle rejects out-of-range hour", async () => {
		const res = await toggle({
			hour: 24,
			timestamps: buildTimestamps(Date.now() + 60_000),
		});
		expect(res.status).toBe(400);
	});

	it("POST toggle rejects negative hour", async () => {
		const res = await toggle({
			hour: -1,
			timestamps: buildTimestamps(Date.now() + 60_000),
		});
		expect(res.status).toBe(400);
	});

	it("POST toggle rejects non-integer hour", async () => {
		const res = await toggle({
			hour: 4.5,
			timestamps: buildTimestamps(Date.now() + 60_000),
		});
		expect(res.status).toBe(400);
	});

	it("POST toggle ACCEPTS a slightly-past timestamp (clock skew / latency)", async () => {
		// Regression guard for Gemini-review finding #1: the old code rejected
		// any slot timestamp <= server now, which broke legitimate toggles when
		// network latency made an imminent slot land "in the past". The HTTP
		// layer must accept it; the scheduler then either fires it immediately
		// (if within MISSED_WAKE_GRACE_MS) or rolls it forward by 24h × N. By
		// the time the response returns, the scheduler tick has already run
		// synchronously up to its first await — so the snapshot reflects the
		// post-advance ts (strictly > now), not the original past ts.
		await toggle({ hour: 22 }); // ensure clean
		const now = Date.now();
		const timestamps: Record<string, number> = {
			"0": now - 5_000, // 5s in the past — well within any plausible skew
			"15": now + 60_000,
			"30": now + 120_000,
			"45": now + 180_000,
		};
		const res = await toggle({ hour: 22, timestamps });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			schedule: Record<string, Record<string, number>>;
		};
		const slot0 = body.schedule["22"]?.["0"];
		expect(typeof slot0).toBe("number");
		expect((slot0 ?? 0) > now).toBe(true); // slot :00 was advanced by the tick
		expect(body.schedule["22"]?.["15"]).toBe(now + 60_000); // future slot kept
		await toggle({ hour: 22 }); // cleanup
	});

	it("POST toggle rejects NaN / Infinity / non-number slot values", async () => {
		// Use a dedicated hour and ALWAYS clean it up, even on assertion failure,
		// so we don't leak state into the next iteration (which would otherwise
		// interpret the next toggle as a DELETE and return 200).
		const hour = 23;
		await toggle({ hour }); // ensure clean
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "x", null]) {
			const now = Date.now();
			const timestamps: Record<string, unknown> = {
				"0": now + 60_000,
				"15": bad,
				"30": now + 180_000,
				"45": now + 240_000,
			};
			const res = await toggle({ hour, timestamps });
			try {
				expect(res.status, `bad value: ${String(bad)}`).toBe(400);
			} finally {
				await toggle({ hour }); // ensure clean for next iteration
			}
		}
	});

	it("POST toggle rejects action='on' with missing timestamps", async () => {
		// Under the explicit-action contract, the helper would otherwise
		// auto-derive { action: 'off' } for a body with no timestamps. Pass
		// action explicitly so we exercise the on-without-timestamps reject.
		const res = await toggle({ hour: 8, action: "on" });
		expect(res.status).toBe(400);
	});

	it("POST toggle rejects missing slot in timestamps object", async () => {
		const res = await toggle({
			hour: 8,
			timestamps: { "0": Date.now() + 60_000, "15": Date.now() + 120_000 },
		});
		expect(res.status).toBe(400);
	});

	it("POST toggle rejects non-object timestamps", async () => {
		const res = await toggle({ hour: 8, timestamps: 12345 });
		expect(res.status).toBe(400);
	});

	it("POST toggle: a delete does NOT require timestamps", async () => {
		const base = Date.now() + 60 * 60 * 1000;
		const addRes = await toggle({ hour: 11, timestamps: buildTimestamps(base) });
		expect(addRes.status).toBe(200);
		const delRes = await toggle({ hour: 11 });
		expect(delRes.status).toBe(200);
		const body = (await delRes.json()) as { schedule: Record<string, unknown> };
		expect(body.schedule["11"]).toBeUndefined();
	});

	it("snapshot reflects multiple marked hours independently with all 4 slots each", async () => {
		const base1 = Date.now() + 2 * 60 * 60 * 1000;
		const base2 = base1 + 60 * 60 * 1000;
		await toggle({ hour: 14, timestamps: buildTimestamps(base1) });
		await toggle({ hour: 19, timestamps: buildTimestamps(base2) });
		const snap = await getSchedule();
		expect(Object.keys(snap.schedule["14"] ?? {}).sort()).toEqual(["0", "15", "30", "45"]);
		expect(Object.keys(snap.schedule["19"] ?? {}).sort()).toEqual(["0", "15", "30", "45"]);
		expect(snap.schedule["14"]?.["0"]).toBe(base1);
		expect(snap.schedule["19"]?.["0"]).toBe(base2);
		// Cleanup so later tests start clean.
		await toggle({ hour: 14 });
		await toggle({ hour: 19 });
	});

	it("re-toggling the same hour replaces all 4 slot timestamps", async () => {
		const base1 = Date.now() + 60 * 60 * 1000;
		const base2 = base1 + 30 * 60 * 1000;
		await toggle({ hour: 5, timestamps: buildTimestamps(base1) });
		await toggle({ hour: 5 }); // remove
		const addRes = await toggle({ hour: 5, timestamps: buildTimestamps(base2) });
		const body = (await addRes.json()) as {
			schedule: Record<string, Record<string, number>>;
		};
		expect(body.schedule["5"]?.["0"]).toBe(base2);
		expect(body.schedule["5"]?.["45"]).toBe(base2 + 180_000);
		await toggle({ hour: 5 });
	});

	it("snapshot remains consistent across toggle round-trips (persistSchedule atomicity)", async () => {
		// Regression guard for Gemini-review finding #3: persistSchedule
		// originally did DELETE + N INSERTs without a transaction. A mid-loop
		// failure would commit the DELETE and lose the schedule. We can't
		// directly induce a SQLite mid-INSERT failure from here without
		// monkey-patching getDatabase, but we CAN assert that the steady-state
		// round-trip never drops rows — and a transactional impl must agree
		// with itself across GET/POST cycles.
		const base = Date.now() + 60 * 60 * 1000;
		await toggle({ hour: 1, timestamps: buildTimestamps(base) });
		await toggle({ hour: 2, timestamps: buildTimestamps(base + 60_000) });
		await toggle({ hour: 3, timestamps: buildTimestamps(base + 120_000) });
		const snap = await getSchedule();
		for (const h of ["1", "2", "3"]) {
			expect(Object.keys(snap.schedule[h] ?? {}).sort()).toEqual(["0", "15", "30", "45"]);
		}
		// Remove one; the others must be untouched.
		await toggle({ hour: 2 });
		const snap2 = await getSchedule();
		expect(snap2.schedule["1"]).toBeDefined();
		expect(snap2.schedule["2"]).toBeUndefined();
		expect(snap2.schedule["3"]).toBeDefined();
		// Cleanup.
		await toggle({ hour: 1 });
		await toggle({ hour: 3 });
	});

	it("POST toggle requires explicit action: 'on' | 'off' (Gemini round-2 #2)", async () => {
		// The server must reject a request that omits `action`. This is the
		// contract that closes the desync-causes-inverted-clicks failure mode:
		// the server is no longer allowed to guess the user's intent from its
		// own (possibly stale-relative-to-UI) in-memory state.
		const now = Date.now();
		const raw = await app.request("/models/wake-schedule/toggle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hour: 6, timestamps: buildTimestamps(now + 60_000) }),
		});
		expect(raw.status).toBe(400);

		for (const bad of ["toggle", "ON", "OFF", "", true, 1, null]) {
			const res = await app.request("/models/wake-schedule/toggle", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hour: 6, action: bad, timestamps: buildTimestamps(now + 60_000) }),
			});
			expect(res.status, `bad action: ${JSON.stringify(bad)}`).toBe(400);
		}
	});

	it("POST toggle action='off' is idempotent on an already-off hour (no error)", async () => {
		// Stale UI scenario: the UI thinks hour 4 is on and clicks to turn it
		// off, but server state had already deleted it. Must succeed quietly,
		// not 400 or change anything else.
		const before = await getSchedule();
		expect(before.schedule["4"]).toBeUndefined();
		const res = await toggle({ hour: 4 }); // helper auto-derives action='off'
		expect(res.status).toBe(200);
		const body = (await res.json()) as { schedule: Record<string, unknown> };
		expect(body.schedule["4"]).toBeUndefined();
	});

	it("POST toggle action='on' on an already-on hour REPLACES timestamps (recovery from desync)", async () => {
		// Stale UI scenario: the UI thinks hour 12 is off and clicks to turn
		// it on, but server state had it already on (from a snapshot the UI
		// missed). Old behavior would have INVERTED the click (turning it
		// off); new behavior replaces the timestamps with the user's freshly
		// computed wall-clock intent and keeps the hour on.
		const base1 = Date.now() + 60 * 60 * 1000;
		const base2 = base1 + 7 * 60 * 60 * 1000;
		const addRes = await toggle({ hour: 12, timestamps: buildTimestamps(base1) });
		expect(addRes.status).toBe(200);
		const reAddRes = await toggle({ hour: 12, timestamps: buildTimestamps(base2) });
		expect(reAddRes.status).toBe(200);
		const body = (await reAddRes.json()) as {
			schedule: Record<string, Record<string, number>>;
		};
		// Hour still present (NOT inverted to off), AND timestamps refreshed.
		expect(body.schedule["12"]?.["0"]).toBe(base2);
		expect(body.schedule["12"]?.["45"]).toBe(base2 + 180_000);
		await toggle({ hour: 12 }); // cleanup
	});

	it("POST toggle action='off' ignores timestamps payload (off doesn't need them)", async () => {
		// Accepting extra fields on an off request is fine; we only fail if
		// an action='on' lacks timestamps.
		const base = Date.now() + 60 * 60 * 1000;
		await toggle({ hour: 13, timestamps: buildTimestamps(base) });
		const res = await app.request("/models/wake-schedule/toggle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hour: 13, action: "off", timestamps: buildTimestamps(base) }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { schedule: Record<string, unknown> };
		expect(body.schedule["13"]).toBeUndefined();
	});
});

describe("GET /models/context-limit", () => {
	it("returns the resolved context limit for a known model", async () => {
		const res = await app.request(
			"/models/context-limit?provider=anthropic&modelId=claude-sonnet-4-5",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { contextLimit: number | null };
		expect(body.contextLimit).toBe(200000);
	});

	it("returns null contextLimit for an unknown model", async () => {
		const res = await app.request("/models/context-limit?provider=anthropic&modelId=mystery");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { contextLimit: number | null };
		expect(body.contextLimit).toBeNull();
	});

	it("400s when provider or modelId is missing", async () => {
		const res1 = await app.request("/models/context-limit?provider=anthropic");
		expect(res1.status).toBe(400);
		const res2 = await app.request("/models/context-limit?modelId=claude-sonnet-4-5");
		expect(res2.status).toBe(400);
	});
});
