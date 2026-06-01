import type { ToolDefinition } from "@dispatch/core";
import { describe, expect, it, vi } from "vitest";

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
		return [];
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

	async function toggle(body: Record<string, unknown>) {
		return app.request("/models/wake-schedule/toggle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
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

	it("POST toggle rejects past timestamp in any slot", async () => {
		const future = Date.now() + 60_000;
		const badTimestamps: Record<string, number> = {
			"0": future,
			"15": Date.now() - 1000, // past
			"30": future + 60_000,
			"45": future + 120_000,
		};
		const res = await toggle({ hour: 7, timestamps: badTimestamps });
		expect(res.status).toBe(400);
	});

	it("POST toggle rejects missing timestamps on add", async () => {
		const res = await toggle({ hour: 8 });
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
});
