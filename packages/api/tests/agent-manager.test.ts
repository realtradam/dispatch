import type { AgentEvent, ToolDefinition } from "@dispatch/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on appendEventToChunks so we can assert persistence calls
const appendEventToChunksSpy = vi.fn((_chunks: unknown[], _event: unknown) => {
	// no-op; we inspect calls in tests
});

// Configurable stub for `getMessagesForTab`. Tests can push rows
// before invoking `processMessage` to simulate prior conversation
// history persisted in the DB (model-switch / history-replay path).
interface FakeMessageRow {
	id: string;
	tabId: string;
	seq: number;
	role: "user" | "assistant" | "system";
	chunks: unknown[];
	createdAt: number;
}
const fakeMessagesByTab = new Map<string, FakeMessageRow[]>();
function resetFakeMessages(): void {
	fakeMessagesByTab.clear();
}
function setFakeMessages(tabId: string, rows: FakeMessageRow[]): void {
	fakeMessagesByTab.set(tabId, rows);
}
function makeRow(
	tabId: string,
	seq: number,
	role: "user" | "assistant" | "system",
	chunks: unknown[],
): FakeMessageRow {
	return { id: `msg-${tabId}-${seq}`, tabId, seq, role, chunks, createdAt: seq };
}

// Hook into Agent construction so tests can assert what
// `messages` was pre-populated with at the moment `run()` was
// called (after the post-construction pre-populate step in
// `getOrCreateAgentForTab` has had a chance to assign).
//
// We snapshot at `run()` invocation rather than at construction
// because the production code reassigns `agent.messages =
// rows.slice(...)` AFTER `new Agent()` returns — capturing a
// reference at construction would yield a stale empty array.
const constructedAgents: Array<{ initialMessages: unknown[] }> = [];
function resetConstructedAgents(): void {
	constructedAgents.length = 0;
}

// Allow tests to swap in a custom `run` generator (e.g. to simulate
// a fallback failure mid-stream). Returning to undefined restores
// the default.
type RunGen = (msg: string) => AsyncGenerator<unknown>;
let runImpl: RunGen | null = null;
function setRunImpl(impl: RunGen | null): void {
	runImpl = impl;
}
async function* defaultRun(_message: string): AsyncGenerator<unknown> {
	yield { type: "status", status: "running" } as const;
	await new Promise<void>((r) => setTimeout(r, 10));
	yield { type: "reasoning-delta", delta: "thinking about it" } as const;
	yield {
		type: "reasoning-end",
		metadata: { anthropic: { signature: "mock-sig" } },
	} as const;
	yield { type: "text-delta", delta: "Hello " } as const;
	yield { type: "text-delta", delta: "world" } as const;
	yield {
		type: "done",
		message: {
			role: "assistant",
			chunks: [
				{
					type: "thinking",
					text: "thinking about it",
					metadata: { anthropic: { signature: "mock-sig" } },
				},
				{ type: "text", text: "Hello world" },
			],
		},
	} as const;
	yield { type: "status", status: "idle" } as const;
}

// Mock @dispatch/core's Agent to avoid real LLM calls
vi.mock("@dispatch/core", () => ({
	Agent: class MockAgent {
		status = "idle";
		messages: unknown[] = [];
		async *run(message: string): AsyncGenerator<unknown> {
			// Snapshot the post-construction pre-populated message list
			// the first thing `run()` does, before the real `Agent.run`
			// would push the current user message at line 546. Tests
			// inspect this to verify history was loaded correctly.
			constructedAgents.push({ initialMessages: [...this.messages] });
			if (runImpl) {
				for await (const ev of runImpl(message)) yield ev;
				return;
			}
			for await (const ev of defaultRun(message)) yield ev;
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
	getMessagesForTab(tabId: string) {
		return fakeMessagesByTab.get(tabId) ?? [];
	},
	appendEventToChunks: appendEventToChunksSpy,
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

// Import after mock is defined (Vitest hoists vi.mock automatically)
const { AgentManager } = await import("../src/agent-manager.js");

describe("AgentManager", () => {
	beforeEach(() => {
		resetFakeMessages();
		resetConstructedAgents();
		setRunImpl(null);
		appendEventToChunksSpy.mockClear();
	});

	it("initial status is idle", () => {
		const manager = new AgentManager();
		expect(manager.getStatus()).toBe("idle");
	});

	it("initial messageCount is 0", () => {
		const manager = new AgentManager();
		expect(manager.getMessageCount()).toBe(0);
	});

	it("event listeners receive events during processMessage", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-1", "test");

		expect(events.length).toBeGreaterThan(0);
		// A turn now opens with `turn-start`, immediately followed by the
		// agent's `status: running`.
		expect(events[0]).toMatchObject({ type: "turn-start" });
		expect(events[1]).toMatchObject({ type: "status", status: "running" });

		// A turn now closes with `turn-sealed` (emitted after the DB write, which
		// is after the agent's final `status: idle`).
		const lastEvent = events[events.length - 1];
		expect(lastEvent).toMatchObject({ type: "turn-sealed" });
		expect(events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
	});

	it("emits a turn-start with a turnId before any content event", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-turnstart", "go");

		const turnStartIdx = events.findIndex((e) => e.type === "turn-start");
		expect(turnStartIdx).toBeGreaterThanOrEqual(0);
		const turnStart = events[turnStartIdx] as Extract<AgentEvent, { type: "turn-start" }>;
		expect(typeof turnStart.turnId).toBe("string");
		expect(turnStart.turnId.length).toBeGreaterThan(0);

		// Must precede the first content delta.
		const firstContentIdx = events.findIndex(
			(e) => e.type === "text-delta" || e.type === "reasoning-delta",
		);
		expect(firstContentIdx).toBeGreaterThan(turnStartIdx);
	});

	it("emits text-delta events during processMessage", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-1", "hello");

		const textDeltas = events.filter((e) => e.type === "text-delta");
		expect(textDeltas.length).toBeGreaterThan(0);
	});

	it("messageCount increments after processMessage", async () => {
		const manager = new AgentManager();
		await manager.processMessage("tab-1", "hello");
		expect(manager.getMessageCount()).toBe(1);
		await manager.processMessage("tab-1", "world");
		expect(manager.getMessageCount()).toBe(2);
	});

	it("status returns to idle after processMessage completes", async () => {
		const manager = new AgentManager();
		await manager.processMessage("tab-1", "test");
		expect(manager.getStatus()).toBe("idle");
	});

	it("unsubscribe removes listener", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		const unsubscribe = manager.onEvent((event) => {
			events.push(event);
		});

		unsubscribe();
		await manager.processMessage("tab-1", "test");

		expect(events.length).toBe(0);
	});

	it("multiple listeners all receive events", async () => {
		const manager = new AgentManager();
		const listener1 = vi.fn();
		const listener2 = vi.fn();

		manager.onEvent(listener1);
		manager.onEvent(listener2);

		await manager.processMessage("tab-1", "test");

		expect(listener1).toHaveBeenCalled();
		expect(listener2).toHaveBeenCalled();
	});

	// ─── v6 reasoning-end tests ───────────────────────────────────────

	it("reasoning-end event is broadcast to WS listeners", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-reasoning", "think please");

		const reasoningEndEvents = events.filter((e) => e.type === "reasoning-end");
		expect(reasoningEndEvents.length).toBeGreaterThan(0);
		expect(reasoningEndEvents[0]).toMatchObject({
			type: "reasoning-end",
			metadata: { anthropic: { signature: "mock-sig" } },
		});
	});

	it("reasoning-end is passed to appendEventToChunks for persistence", async () => {
		appendEventToChunksSpy.mockClear();
		const manager = new AgentManager();

		await manager.processMessage("tab-persist", "think and persist");

		// Find all calls to appendEventToChunks that received a reasoning-end event
		const reasoningEndCalls = appendEventToChunksSpy.mock.calls.filter(
			([_chunks, event]) => (event as AgentEvent).type === "reasoning-end",
		);
		expect(reasoningEndCalls.length).toBeGreaterThan(0);

		// The event should carry the metadata blob
		const [, reasoningEndEvent] = reasoningEndCalls[0] as [unknown[], AgentEvent];
		expect(reasoningEndEvent).toMatchObject({
			type: "reasoning-end",
			metadata: { anthropic: { signature: "mock-sig" } },
		});
	});

	it("reasoning-end follows reasoning-delta in broadcast order (chunk accumulator ordering)", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-ordering", "think in order");

		const types = events.map((e) => e.type);
		const deltaIdx = types.indexOf("reasoning-delta");
		const endIdx = types.indexOf("reasoning-end");

		// Both must be present
		expect(deltaIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThanOrEqual(0);

		// reasoning-end must come AFTER reasoning-delta
		expect(endIdx).toBeGreaterThan(deltaIdx);

		// reasoning-end must come BEFORE any text-delta (reasoning precedes text)
		const textDeltaIdx = types.indexOf("text-delta");
		if (textDeltaIdx >= 0) {
			expect(endIdx).toBeLessThan(textDeltaIdx);
		}
	});

	it("done event includes a thinking chunk with metadata in its message", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-done-chunks", "think and respond");

		const doneEvent = events.find((e) => e.type === "done") as
			| Extract<AgentEvent, { type: "done" }>
			| undefined;
		expect(doneEvent).toBeDefined();

		const thinkingChunk = doneEvent?.message.chunks.find((c) => c.type === "thinking");
		expect(thinkingChunk).toBeDefined();
		expect(thinkingChunk).toMatchObject({
			type: "thinking",
			text: "thinking about it",
			metadata: { anthropic: { signature: "mock-sig" } },
		});
	});

	// ─── History pre-population on Agent (re)construction ────────────
	//
	// These tests guard the fix that prior conversation turns survive
	// switching models mid-conversation via the sidebar slider. Without
	// it, a fresh `Agent` is constructed with `messages: []` and the
	// next LLM call sees zero prior context.

	it("pre-populates Agent.messages from DB history when constructing a fresh Agent", async () => {
		const manager = new AgentManager();
		const tabId = "tab-history";

		// Simulate prior conversation in the DB:
		//   u1, a1, u_current
		// (the current turn's user message has already been appended
		//  by `processMessage` before `getOrCreateAgentForTab` runs)
		setFakeMessages(tabId, [
			makeRow(tabId, 0, "user", [{ type: "text", text: "first question" }]),
			makeRow(tabId, 1, "assistant", [{ type: "text", text: "first answer" }]),
			makeRow(tabId, 2, "user", [{ type: "text", text: "follow-up" }]),
		]);

		await manager.processMessage(tabId, "follow-up");

		// Exactly one Agent should have been constructed for this tab,
		// and its messages must be the prior two rows (excluding the
		// current user message — `Agent.run()` pushes that itself).
		expect(constructedAgents.length).toBe(1);
		const inst = constructedAgents[0];
		expect(inst).toBeDefined();
		if (!inst) return;
		const init = inst.initialMessages as Array<{ role: string; chunks: unknown[] }>;
		expect(init.length).toBe(2);
		expect(init[0]).toMatchObject({
			role: "user",
			chunks: [{ type: "text", text: "first question" }],
		});
		expect(init[1]).toMatchObject({
			role: "assistant",
			chunks: [{ type: "text", text: "first answer" }],
		});
	});

	it("leaves messages empty when the DB has only the current turn's user message (first turn)", async () => {
		const manager = new AgentManager();
		const tabId = "tab-first-turn";

		// First-ever turn: DB has only the just-appended user message.
		setFakeMessages(tabId, [makeRow(tabId, 0, "user", [{ type: "text", text: "hello" }])]);

		await manager.processMessage(tabId, "hello");

		expect(constructedAgents.length).toBe(1);
		const inst = constructedAgents[0];
		expect(inst).toBeDefined();
		if (!inst) return;
		// The user message at idx 0 is the current turn — must be excluded.
		expect((inst.initialMessages as unknown[]).length).toBe(0);
	});

	it("excludes a partial assistant trail from a prior fallback attempt", async () => {
		const manager = new AgentManager();
		const tabId = "tab-fallback-partial";

		// Scenario: the agent-mode fallback path. Attempt 1 (Opus) errored
		// mid-stream after flushing some chunks; attempt 2 (DeepSeek) is
		// about to start. DB looks like:
		//   u1, a1, u_current, partial_a_attempt1
		// The fresh Agent for attempt 2 must see [u1, a1] — not the
		// current user message and not the failed attempt's partial.
		setFakeMessages(tabId, [
			makeRow(tabId, 0, "user", [{ type: "text", text: "q1" }]),
			makeRow(tabId, 1, "assistant", [{ type: "text", text: "a1" }]),
			makeRow(tabId, 2, "user", [{ type: "text", text: "q2" }]),
			makeRow(tabId, 3, "assistant", [{ type: "text", text: "half-baked..." }]),
		]);

		await manager.processMessage(tabId, "q2");

		expect(constructedAgents.length).toBe(1);
		const inst = constructedAgents[0];
		expect(inst).toBeDefined();
		if (!inst) return;
		const init = inst.initialMessages as Array<{ role: string; chunks: unknown[] }>;
		expect(init.length).toBe(2);
		expect(init[0]).toMatchObject({ role: "user", chunks: [{ type: "text", text: "q1" }] });
		expect(init[1]).toMatchObject({ role: "assistant", chunks: [{ type: "text", text: "a1" }] });
	});

	it("preserves system-role rows in pre-populated history (toModelMessages filters them later)", async () => {
		const manager = new AgentManager();
		const tabId = "tab-with-system-rows";

		setFakeMessages(tabId, [
			makeRow(tabId, 0, "user", [{ type: "text", text: "q1" }]),
			makeRow(tabId, 1, "assistant", [{ type: "text", text: "a1" }]),
			makeRow(tabId, 2, "system", [
				{ type: "system", kind: "config-reload", text: "Configuration reloaded" },
			]),
			makeRow(tabId, 3, "user", [{ type: "text", text: "q2" }]),
		]);

		await manager.processMessage(tabId, "q2");

		expect(constructedAgents.length).toBe(1);
		const inst = constructedAgents[0];
		expect(inst).toBeDefined();
		if (!inst) return;
		const init = inst.initialMessages as Array<{ role: string; chunks: unknown[] }>;
		// All three prior rows (user/assistant/system) preserved; the
		// LLM-facing `toModelMessages` strips the system row later.
		expect(init.length).toBe(3);
		expect(init[2]).toMatchObject({ role: "system" });
	});

	it("survives a getMessagesForTab failure without crashing (messages stays empty)", async () => {
		const manager = new AgentManager();
		const tabId = "tab-db-error";

		// Simulate DB error by stubbing the fake-store getter to throw
		// for this specific tab. We use a Proxy on the Map's get method
		// for the duration of one call.
		const realGet = fakeMessagesByTab.get.bind(fakeMessagesByTab);
		fakeMessagesByTab.get = ((key: string) => {
			if (key === tabId) throw new Error("simulated DB error");
			return realGet(key);
		}) as typeof fakeMessagesByTab.get;

		try {
			await expect(manager.processMessage(tabId, "anything")).resolves.toBeUndefined();
		} finally {
			fakeMessagesByTab.get = realGet;
		}

		// Agent still constructed, just with empty messages.
		expect(constructedAgents.length).toBe(1);
		const inst = constructedAgents[0];
		expect(inst).toBeDefined();
		if (!inst) return;
		expect((inst.initialMessages as unknown[]).length).toBe(0);
	});

	it("reloads history on every Agent reconstruction (simulated model switch)", async () => {
		const manager = new AgentManager();
		const tabId = "tab-model-switch";

		// Turn 1: empty DB → just the first user message.
		setFakeMessages(tabId, [makeRow(tabId, 0, "user", [{ type: "text", text: "q1" }])]);
		await manager.processMessage(tabId, "q1", "key-opus", "claude-opus-4-7");

		// Turn 2: DB now has the full prior turn + new user message.
		// User has switched models via the sidebar slider — different
		// (keyId, modelId) triggers Agent invalidation and reconstruction.
		setFakeMessages(tabId, [
			makeRow(tabId, 0, "user", [{ type: "text", text: "q1" }]),
			makeRow(tabId, 1, "assistant", [{ type: "text", text: "a1" }]),
			makeRow(tabId, 2, "user", [{ type: "text", text: "q2" }]),
		]);
		await manager.processMessage(tabId, "q2", "key-deepseek", "deepseek-v3");

		// Exactly two Agents constructed across the two turns (the
		// invalidation gate fires when keyId/modelId change).
		expect(constructedAgents.length).toBe(2);

		// Second Agent (the DeepSeek one) was pre-populated with the
		// completed first turn — not empty, not duplicating q2.
		const second = constructedAgents[1];
		expect(second).toBeDefined();
		if (!second) return;
		const init = second.initialMessages as Array<{ role: string; chunks: unknown[] }>;
		expect(init.length).toBe(2);
		expect(init[0]).toMatchObject({ role: "user", chunks: [{ type: "text", text: "q1" }] });
		expect(init[1]).toMatchObject({ role: "assistant", chunks: [{ type: "text", text: "a1" }] });
	});

	// ─── getAllStatuses snapshot shape (for browser-reopen restore) ────
	//
	// The snapshot enriches the legacy `Record<string, AgentStatus>` shape
	// with per-tab in-flight context so a fresh frontend can render the
	// streaming assistant message correctly after a reload.

	it("getAllStatuses returns an empty record when no tabs are tracked", () => {
		const manager = new AgentManager();
		expect(manager.getAllStatuses()).toEqual({});
	});

	it("getAllStatuses returns { status } for an idle tab (no currentChunks/currentAssistantId)", async () => {
		const manager = new AgentManager();
		// Drive a full turn so the tab gets registered; default mock run
		// settles back to idle by the time `await` resolves.
		await manager.processMessage("tab-idle", "hi");
		const snap = manager.getAllStatuses();
		expect(snap["tab-idle"]).toBeDefined();
		expect(snap["tab-idle"]?.status).toBe("idle");
		expect(snap["tab-idle"]).not.toHaveProperty("currentChunks");
		expect(snap["tab-idle"]).not.toHaveProperty("currentAssistantId");
	});

	it("getAllStatuses includes currentChunks and currentAssistantId for a running tab", () => {
		const manager = new AgentManager();
		// Reach into the private map to set up a synthetic running state.
		// Justification: there is no public API to enter a sustained
		// "running" state without actually streaming, and we want to
		// assert the snapshot shape — not the streaming pipeline.
		const inner = manager as unknown as {
			tabAgents: Map<
				string,
				{
					agent: null;
					status: "running" | "idle" | "error";
					keyId: null;
					modelId: null;
					taskList: { onChange: (cb: unknown) => void };
					messageQueue: unknown[];
					queueListeners: unknown[];
					shellStore: unknown;
					transcriptStore: unknown;
					currentChunks: Array<{ type: string; text?: string }> | null;
					currentAssistantId: string | null;
				}
			>;
		};
		inner.tabAgents.set("tab-running", {
			agent: null,
			status: "running",
			keyId: null,
			modelId: null,
			taskList: { onChange: () => {} },
			messageQueue: [],
			queueListeners: [],
			shellStore: {},
			transcriptStore: {},
			currentChunks: [
				{ type: "thinking", text: "let me think" },
				{ type: "text", text: "partial answer" },
			],
			currentAssistantId: "assistant-msg-id-7",
		});

		const snap = manager.getAllStatuses();
		expect(snap["tab-running"]).toBeDefined();
		expect(snap["tab-running"]?.status).toBe("running");
		expect(snap["tab-running"]?.currentAssistantId).toBe("assistant-msg-id-7");
		expect(snap["tab-running"]?.currentChunks).toEqual([
			{ type: "thinking", text: "let me think" },
			{ type: "text", text: "partial answer" },
		]);
	});

	it("getAllStatuses defensively copies currentChunks (mutating the snapshot doesn't affect the live array)", () => {
		const manager = new AgentManager();
		const inner = manager as unknown as {
			tabAgents: Map<
				string,
				{
					agent: null;
					status: "running";
					keyId: null;
					modelId: null;
					taskList: { onChange: (cb: unknown) => void };
					messageQueue: unknown[];
					queueListeners: unknown[];
					shellStore: unknown;
					transcriptStore: unknown;
					currentChunks: Array<{ type: string; text?: string }>;
					currentAssistantId: string;
				}
			>;
		};
		const liveChunks = [{ type: "text", text: "live" }];
		inner.tabAgents.set("tab-copy", {
			agent: null,
			status: "running",
			keyId: null,
			modelId: null,
			taskList: { onChange: () => {} },
			messageQueue: [],
			queueListeners: [],
			shellStore: {},
			transcriptStore: {},
			currentChunks: liveChunks,
			currentAssistantId: "msg-x",
		});

		const snap = manager.getAllStatuses();
		// Mutate the snapshot's array
		snap["tab-copy"]?.currentChunks?.push({ type: "text", text: "polluted" });
		// Live array must be untouched
		expect(liveChunks).toEqual([{ type: "text", text: "live" }]);
	});

	it("getAllStatuses omits currentChunks when a running tab has none yet", () => {
		const manager = new AgentManager();
		const inner = manager as unknown as {
			tabAgents: Map<
				string,
				{
					agent: null;
					status: "running";
					keyId: null;
					modelId: null;
					taskList: { onChange: (cb: unknown) => void };
					messageQueue: unknown[];
					queueListeners: unknown[];
					shellStore: unknown;
					transcriptStore: unknown;
					currentChunks: null;
					currentAssistantId: null;
				}
			>;
		};
		inner.tabAgents.set("tab-early", {
			agent: null,
			status: "running",
			keyId: null,
			modelId: null,
			taskList: { onChange: () => {} },
			messageQueue: [],
			queueListeners: [],
			shellStore: {},
			transcriptStore: {},
			currentChunks: null,
			currentAssistantId: null,
		});

		const snap = manager.getAllStatuses();
		expect(snap["tab-early"]?.status).toBe("running");
		expect(snap["tab-early"]).not.toHaveProperty("currentChunks");
		expect(snap["tab-early"]).not.toHaveProperty("currentAssistantId");
	});
});
