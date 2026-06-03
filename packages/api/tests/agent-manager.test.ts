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

// Configurable stub for the tabs DB (getTab / listOpenTabs). Tests can seed
// rows to exercise deliverMessage cold-hydration and handle resolution.
interface FakeTabRow {
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
const fakeTabs = new Map<string, FakeTabRow>();
function resetFakeTabs(): void {
	fakeTabs.clear();
}
function setFakeTab(row: Partial<FakeTabRow> & { id: string }): void {
	fakeTabs.set(row.id, {
		title: "Tab",
		keyId: null,
		modelId: null,
		parentTabId: null,
		status: "idle",
		isOpen: true,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...row,
	});
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
const constructedAgents: Array<{
	initialMessages: unknown[];
	toolNames: string[];
	systemPrompt: string;
}> = [];
function resetConstructedAgents(): void {
	constructedAgents.length = 0;
}

// Capture the per-call `run()` options (notably reasoningEffort) so tests can
// assert the per-model → per-tab → default effort resolution.
const capturedRunOptions: Array<{ reasoningEffort?: string } | undefined> = [];
function resetCapturedRunOptions(): void {
	capturedRunOptions.length = 0;
}

// Capture every warmCache(history) call so tests can assert the warming replay
// receives the genuine (FULL) history and returns its usage unmodified.
const capturedWarmHistories: unknown[][] = [];
function resetCapturedWarmHistories(): void {
	capturedWarmHistories.length = 0;
}

// Configurable settings store so tests can toggle tool permissions
// (perm_send_to_tab / perm_read_tab / ...) and assert which tools the
// constructed Agent receives. Defaults to empty (getSetting → null).
const fakeSettings = new Map<string, string>();
function resetFakeSettings(): void {
	fakeSettings.clear();
}
function setFakeSetting(key: string, value: string): void {
	fakeSettings.set(key, value);
}

// Capture every appendChunks(tabId, drafts) call so tests can assert what got
// persisted (e.g. usage side-channel rows). The real explodeTurn is mocked to
// return [], so content drafts are empty here; usage rows are pushed directly
// by processMessage's flushAssistant, making them the visible drafts.
interface AppendChunksCall {
	tabId: string;
	drafts: Array<{ turnId: string; step: number; role: string; type: string; data: unknown }>;
}
const appendChunksCalls: AppendChunksCall[] = [];
function resetAppendChunksCalls(): void {
	appendChunksCalls.length = 0;
}

// ── Compaction test scaffolding ────────────────────────────────────
// Fake chunk store (per tab) feeding getChunksForTab / rekeyChunks.
const fakeChunksByTab = new Map<string, Array<{ tabId: string }>>();
// Records of createTab(id, title, opts) and rekeyChunks(from, to) calls.
const createTabCalls: Array<{ id: string; title: string }> = [];
const rekeyCalls: Array<{ from: string; to: string }> = [];
// Configurable buildCompactionRequest result per source tab. Default: a
// compactable conversation (non-empty prompt + a one-message tail).
const fakeCompactionByTab = new Map<
	string,
	{ prompt?: string; tail: Array<{ turnId: string; role: string; chunks: unknown[] }> }
>();
// Configurable registry keys + env-key resolution so resolveConnection can
// succeed in compaction tests. Default empty (preserves existing behaviour).
const fakeRegistryKeys: Array<{
	id: string;
	provider: string;
	base_url: string;
	env?: string;
}> = [];
const fakeApiKeys = new Map<string, string>();
const fakeConfigKeys: Array<{ id: string; provider: string; base_url: string; env?: string }> = [];
function resetCompactionScaffolding(): void {
	fakeRegistryKeys.length = 0;
	fakeApiKeys.clear();
	fakeConfigKeys.length = 0;
	fakeChunksByTab.clear();
	createTabCalls.length = 0;
	rekeyCalls.length = 0;
	fakeCompactionByTab.clear();
}

// Seedable return value for the mocked getUsageStatsForTab — what the backend
// reads (post-write) to attach to the `turn-sealed` event.
const fakeUsageStatsByTab = new Map<string, unknown>();
function resetFakeUsageStats(): void {
	fakeUsageStatsByTab.clear();
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
		toolNames: string[] = [];
		systemPrompt = "";
		constructor(config: { tools?: Array<{ name: string }>; systemPrompt?: string }) {
			this.toolNames = (config?.tools ?? []).map((t) => t.name);
			this.systemPrompt = config?.systemPrompt ?? "";
		}
		async *run(message: string, options?: { reasoningEffort?: string }): AsyncGenerator<unknown> {
			// Snapshot the post-construction pre-populated message list
			// the first thing `run()` does, before the real `Agent.run`
			// would push the current user message at line 546. Tests
			// inspect this to verify history was loaded correctly.
			constructedAgents.push({
				initialMessages: [...this.messages],
				toolNames: [...this.toolNames],
				systemPrompt: this.systemPrompt,
			});
			capturedRunOptions.push(options);
			if (runImpl) {
				for await (const ev of runImpl(message)) yield ev;
				return;
			}
			for await (const ev of defaultRun(message)) yield ev;
		}
		async warmCache(history: unknown[]) {
			capturedWarmHistories.push([...history]);
			return {
				inputTokens: 1200,
				outputTokens: 1,
				cacheReadTokens: 1100,
				cacheWriteTokens: 0,
			};
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
	createLspTool(_getContext: unknown): ToolDefinition {
		return {
			name: "lsp",
			description: "query the language server",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => "mock lsp",
		};
	},
	LspManager: class MockLspManager {
		hasServerForFile() {
			return false;
		}
		async getClients() {
			return [];
		}
		async touchFile() {}
		getDiagnostics() {
			return {};
		}
		async request() {
			return [];
		}
		async shutdownAll() {}
	},
	resolveServersFromConfig(_lsp: unknown) {
		return [];
	},
	reportDiagnostics(_file: string, _issues: unknown) {
		return "";
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
		return fakeConfigKeys.length > 0
			? { permissions: {}, keys: [...fakeConfigKeys] }
			: { permissions: {} };
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
			return fakeRegistryKeys.map((k) => ({ definition: k, status: "active" }));
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
		private tasks: Array<{ id: string; content: string; status: string }> = [];
		getTasks() {
			return this.tasks.map((t) => ({ ...t }));
		}
		setTasks(items: Array<{ content: string; status?: string }>) {
			this.tasks = items.map((item, i) => ({
				id: `task-${i + 1}`,
				content: item.content,
				status: item.status ?? "pending",
			}));
			return this.getTasks();
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
	// Summon parent-path dependencies. The real implementations load agent
	// definitions from disk; tests only need the summon/retrieve tool entries
	// to appear, so these return empty projections.
	loadAgents() {
		return [];
	},
	toAvailableSubagents() {
		return [];
	},
	toAvailableUserAgents() {
		return [];
	},
	getAgentDirPaths() {
		return [];
	},
	GLOBAL_AGENTS_DIR: "/tmp/global-agents",
	createTab(id: string, title: string) {
		createTabCalls.push({ id, title });
		return { id, title };
	},
	getTab(id: string) {
		return fakeTabs.get(id) ?? null;
	},
	listOpenTabs() {
		return [...fakeTabs.values()].filter((t) => t.isOpen);
	},
	resolveTabPrefix(prefix: string) {
		const sanitized = (prefix ?? "").toLowerCase().replace(/[^0-9a-f-]/g, "");
		if (sanitized.length < 4) return { status: "none" };
		const matches = [...fakeTabs.values()].filter(
			(t) => t.isOpen && t.id.toLowerCase().startsWith(sanitized),
		);
		if (matches.length === 0) return { status: "none" };
		if (matches.length === 1) return { status: "ok", tab: matches[0] };
		return { status: "ambiguous", matches };
	},
	shortestUniquePrefix(id: string) {
		return (id ?? "").slice(0, 4);
	},
	createSendToTabTool(_callbacks: unknown): ToolDefinition {
		return {
			name: "send_to_tab",
			description: "send to tab",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => "mock",
		};
	},
	createReadTabTool(_callbacks: unknown): ToolDefinition {
		return {
			name: "read_tab",
			description: "read tab",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
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
	resolveApiKey(keyId: string) {
		return fakeApiKeys.get(keyId) ?? null;
	},
	getSetting(key: string) {
		return fakeSettings.get(key) ?? null;
	},
	isReasoningEffort(value: unknown) {
		return (
			typeof value === "string" && ["none", "low", "medium", "high", "xhigh", "max"].includes(value)
		);
	},
	appendChunks(tabId: string, drafts: AppendChunksCall["drafts"]) {
		appendChunksCalls.push({ tabId, drafts: [...drafts] });
		return [];
	},
	explodeUserText() {
		return [];
	},
	explodeTurn() {
		return [{ turnId: "t", step: 0, role: "assistant", type: "text", data: { text: "" } }];
	},
	getChunksForTab(tabId: string) {
		return fakeChunksByTab.get(tabId) ?? [];
	},
	groupRowsToMessages(rows: Array<{ tabId: string }>) {
		return rows;
	},
	rekeyChunks(from: string, to: string) {
		rekeyCalls.push({ from, to });
		const rows = fakeChunksByTab.get(from) ?? [];
		fakeChunksByTab.set(to, rows);
		fakeChunksByTab.delete(from);
		return rows.length;
	},
	buildCompactionRequest(input: { messages: unknown[] }) {
		// Resolve the seeded result by matching the first row's tabId.
		const first = (input.messages as Array<{ tabId?: string }>)[0];
		const tabId = first?.tabId ?? "";
		const seeded = fakeCompactionByTab.get(tabId);
		if (seeded) return { head: [], tail: seeded.tail, prompt: seeded.prompt };
		return {
			head: [],
			tail: [{ turnId: "tail-turn", role: "user", chunks: [{ type: "text", text: "recent" }] }],
			prompt: "SUMMARY PROMPT",
		};
	},
	buildSummaryTurnText(summary: string) {
		return `[CONVERSATION SUMMARY]\n\n${summary}`;
	},
	getMessagesForTab(tabId: string) {
		return fakeMessagesByTab.get(tabId) ?? [];
	},
	getUsageStatsForTab(tabId: string) {
		return fakeUsageStatsByTab.get(tabId) ?? null;
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
	createKeyUsageTool(_callbacks: unknown) {
		return {
			name: "key_usage",
			description: "key usage",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createSearchCodeTool(_wd: string) {
		return {
			name: "search_code",
			description: "search code",
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
		resetCapturedRunOptions();
		resetFakeTabs();
		resetFakeSettings();
		setRunImpl(null);
		appendEventToChunksSpy.mockClear();
		resetAppendChunksCalls();
		resetFakeUsageStats();
		resetCapturedWarmHistories();
		resetCompactionScaffolding();
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

	// ─── per-model reasoning effort precedence ───────────────────────

	describe("reasoning effort precedence (per-model → per-tab → default)", () => {
		it("uses the per-model effort over the per-tab selector for that fallback entry", async () => {
			const manager = new AgentManager();
			// Agent definition supplies a fallback chain where each entry has its
			// own configured effort; the per-tab selector ("low") must NOT win.
			await manager.processMessage(
				"tab-effort-permodel",
				"go",
				"key-a",
				"model-a",
				"low",
				undefined,
				[{ key_id: "key-a", model_id: "model-a", effort: "xhigh" }],
			);
			expect(capturedRunOptions.at(-1)?.reasoningEffort).toBe("xhigh");
		});

		it("falls back to the per-tab selector when the model entry has no effort", async () => {
			const manager = new AgentManager();
			await manager.processMessage(
				"tab-effort-tab",
				"go",
				"key-a",
				"model-a",
				"medium",
				undefined,
				[{ key_id: "key-a", model_id: "model-a" }],
			);
			expect(capturedRunOptions.at(-1)?.reasoningEffort).toBe("medium");
		});

		it("passes no effort (Agent applies its default) when neither is set", async () => {
			const manager = new AgentManager();
			await manager.processMessage(
				"tab-effort-default",
				"go",
				"key-a",
				"model-a",
				undefined,
				undefined,
				[{ key_id: "key-a", model_id: "model-a" }],
			);
			expect(capturedRunOptions.at(-1)?.reasoningEffort).toBeUndefined();
		});
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
					taskList: { onChange: (cb: unknown) => void; getTasks: () => unknown[] };
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
			taskList: { onChange: () => {}, getTasks: () => [] },
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
					taskList: { onChange: (cb: unknown) => void; getTasks: () => unknown[] };
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
			taskList: { onChange: () => {}, getTasks: () => [] },
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
					taskList: { onChange: (cb: unknown) => void; getTasks: () => unknown[] };
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
			taskList: { onChange: () => {}, getTasks: () => [] },
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

	it("getAllStatuses includes a tab's todo list (for reload rehydration)", () => {
		const manager = new AgentManager();
		// Public API: getTaskList creates+returns the tab's list. setTasks is
		// the declarative whole-list write.
		const list = manager.getTaskList("tab-todos");
		list.setTasks([
			{ content: "plan", status: "completed" },
			{ content: "build", status: "in_progress" },
		]);
		const snap = manager.getAllStatuses();
		expect(snap["tab-todos"]?.tasks).toEqual([
			{ id: "task-1", content: "plan", status: "completed" },
			{ id: "task-2", content: "build", status: "in_progress" },
		]);
	});

	it("getAllStatuses omits tasks for a tab with an empty todo list", () => {
		const manager = new AgentManager();
		manager.getTaskList("tab-empty");
		const snap = manager.getAllStatuses();
		expect(snap["tab-empty"]).toBeDefined();
		expect(snap["tab-empty"]).not.toHaveProperty("tasks");
	});

	// ─── Tab-to-tab communication ─────────────────────────────────

	describe("deliverMessage", () => {
		it("starts a new turn when the target tab is idle", async () => {
			const manager = new AgentManager();
			const events: AgentEvent[] = [];
			manager.onEvent((e) => events.push(e));

			const outcome = manager.deliverMessage("tab-idle", "wake up");
			expect(outcome.status).toBe("started");

			// Let the background turn run to completion.
			await new Promise<void>((r) => setTimeout(r, 60));
			expect(events.some((e) => e.type === "text-delta")).toBe(true);
			expect(manager.getTabStatus("tab-idle")).toBe("idle");
		});

		it("queues the message when the target tab is running", () => {
			const manager = new AgentManager();
			const inner = manager as unknown as {
				tabAgents: Map<string, Record<string, unknown>>;
			};
			// Seed a running tab agent directly.
			inner.tabAgents.set("tab-busy", {
				agent: null,
				status: "running",
				keyId: null,
				modelId: null,
				taskList: { onChange: () => {}, getTasks: () => [] },
				messageQueue: [],
				queueListeners: [],
				shellStore: {},
				transcriptStore: {},
				currentChunks: null,
				currentAssistantId: null,
				currentTurnId: null,
			});

			const outcome = manager.deliverMessage("tab-busy", "queued msg");
			expect(outcome.status).toBe("queued");
			if (outcome.status === "queued") {
				expect(typeof outcome.messageId).toBe("string");
			}
			// The message landed on the running tab's queue.
			const agent = inner.tabAgents.get("tab-busy") as { messageQueue: unknown[] };
			expect(agent.messageQueue).toHaveLength(1);
		});

		it("hydrates key/model from the persisted tab row for a cold wake", () => {
			const manager = new AgentManager();
			setFakeTab({ id: "tab-cold", keyId: "persisted-key", modelId: "persisted-model" });

			// Spy on processMessage to capture the key/model deliverMessage
			// forwarded — asserting the hydration decision directly rather than
			// downstream tabAgent state (which the mocked ModelRegistry rewrites).
			const spy = vi.spyOn(manager, "processMessage").mockResolvedValue(undefined);

			const outcome = manager.deliverMessage("tab-cold", "hello");
			expect(outcome.status).toBe("started");

			expect(spy).toHaveBeenCalledTimes(1);
			const args = spy.mock.calls[0] ?? [];
			expect(args[0]).toBe("tab-cold"); // tabId
			expect(args[1]).toBe("hello"); // message
			expect(args[2]).toBe("persisted-key"); // keyId hydrated from row
			expect(args[3]).toBe("persisted-model"); // modelId hydrated from row
		});

		it("prefers explicit opts over the persisted row on a cold wake", () => {
			const manager = new AgentManager();
			setFakeTab({ id: "tab-cold2", keyId: "row-key", modelId: "row-model" });
			const spy = vi.spyOn(manager, "processMessage").mockResolvedValue(undefined);

			manager.deliverMessage("tab-cold2", "hello", {
				keyId: "explicit-key",
				modelId: "explicit-model",
			});

			const args = spy.mock.calls[0] ?? [];
			expect(args[2]).toBe("explicit-key");
			expect(args[3]).toBe("explicit-model");
		});
	});

	describe("deliverMessage — agent auto-wake budget", () => {
		it("allows up to 6 consecutive agent wakes, then suppresses further ones", () => {
			const manager = new AgentManager();
			const spy = vi.spyOn(manager, "processMessage").mockResolvedValue(undefined);

			// 6 agent-originated wakes of an idle tab should all start turns.
			for (let i = 0; i < 6; i++) {
				const outcome = manager.deliverMessage("tab-pp", `msg ${i}`, { origin: "agent" });
				expect(outcome.status).toBe("started");
			}
			expect(spy).toHaveBeenCalledTimes(6);

			// The 7th is suppressed: no new turn, message preserved on the queue.
			const seventh = manager.deliverMessage("tab-pp", "msg 7", { origin: "agent" });
			expect(seventh.status).toBe("suppressed");
			expect(spy).toHaveBeenCalledTimes(6); // unchanged — no wake

			const inner = manager as unknown as {
				tabAgents: Map<string, { messageQueue: unknown[]; autoWakeBudget: number }>;
			};
			const agent = inner.tabAgents.get("tab-pp");
			expect(agent?.autoWakeBudget).toBe(0);
			// Suppressed message is queued, not dropped.
			expect(agent?.messageQueue).toHaveLength(1);
		});

		it("a human message refills the budget and re-enables agent wakes", () => {
			const manager = new AgentManager();
			vi.spyOn(manager, "processMessage").mockResolvedValue(undefined);

			// Exhaust the budget with agent wakes.
			for (let i = 0; i < 6; i++) {
				manager.deliverMessage("tab-refill", `a${i}`, { origin: "agent" });
			}
			expect(manager.deliverMessage("tab-refill", "blocked", { origin: "agent" }).status).toBe(
				"suppressed",
			);

			// A human message refills the budget...
			const humanOutcome = manager.deliverMessage("tab-refill", "human here", {
				origin: "human",
			});
			expect(humanOutcome.status).toBe("started");

			const inner = manager as unknown as {
				tabAgents: Map<string, { autoWakeBudget: number }>;
			};
			expect(inner.tabAgents.get("tab-refill")?.autoWakeBudget).toBe(6);

			// ...so an agent can wake it again.
			expect(manager.deliverMessage("tab-refill", "again", { origin: "agent" }).status).toBe(
				"started",
			);
		});

		it("does not consume budget when the message is merely queued (busy target)", () => {
			const manager = new AgentManager();
			const inner = manager as unknown as {
				tabAgents: Map<string, Record<string, unknown>>;
			};
			inner.tabAgents.set("tab-busy-budget", {
				agent: null,
				status: "running",
				keyId: null,
				modelId: null,
				taskList: { onChange: () => {}, getTasks: () => [] },
				messageQueue: [],
				queueListeners: [],
				shellStore: {},
				transcriptStore: {},
				currentChunks: null,
				currentAssistantId: null,
				currentTurnId: null,
				autoWakeBudget: 6,
			});

			const outcome = manager.deliverMessage("tab-busy-budget", "queued one", {
				origin: "agent",
			});
			expect(outcome.status).toBe("queued");
			// Budget untouched — queuing can't drive a runaway loop.
			const agent = inner.tabAgents.get("tab-busy-budget") as { autoWakeBudget: number };
			expect(agent.autoWakeBudget).toBe(6);
		});

		it("human-originated wakes are never throttled", () => {
			const manager = new AgentManager();
			const spy = vi.spyOn(manager, "processMessage").mockResolvedValue(undefined);

			// Far more than the budget, all human-originated → all start turns.
			for (let i = 0; i < 10; i++) {
				const outcome = manager.deliverMessage("tab-human", `h${i}`, { origin: "human" });
				expect(outcome.status).toBe("started");
			}
			expect(spy).toHaveBeenCalledTimes(10);
		});

		it("defaults origin to human when unspecified (POST /chat path)", () => {
			const manager = new AgentManager();
			const spy = vi.spyOn(manager, "processMessage").mockResolvedValue(undefined);
			for (let i = 0; i < 8; i++) {
				expect(manager.deliverMessage("tab-default", `d${i}`).status).toBe("started");
			}
			expect(spy).toHaveBeenCalledTimes(8);
		});
	});

	describe("queue continuation after a turn ends", () => {
		// A run generator that enqueues `msg` (as if a user/agent sent it mid-turn)
		// exactly once, then streams a normal short reply. Used to simulate a
		// message landing on the queue while the agent is busy.
		function runThatEnqueues(manager: AgentManager, tabId: string, msg: string): RunGen {
			let enqueued = false;
			return async function* () {
				yield { type: "status", status: "running" } as const;
				if (!enqueued) {
					enqueued = true;
					manager.queueMessage(tabId, msg);
				}
				yield { type: "text-delta", delta: "reply" } as const;
				yield {
					type: "done",
					message: { role: "assistant", chunks: [{ type: "text", text: "reply" }] },
				} as const;
				yield { type: "status", status: "idle" } as const;
			};
		}

		it("starts a NEW turn for a message queued during the turn (the bug fix)", async () => {
			const manager = new AgentManager();
			const processSpy = vi.spyOn(manager, "processMessage");
			setRunImpl(runThatEnqueues(manager, "tab-cont", "follow-up question"));

			await manager.processMessage("tab-cont", "first");
			// Let the fire-and-forget continuation turn run to completion.
			await new Promise<void>((r) => setTimeout(r, 50));

			// processMessage called twice: the original turn + the continuation.
			expect(processSpy).toHaveBeenCalledTimes(2);
			expect(processSpy.mock.calls[1]?.[0]).toBe("tab-cont");
			expect(processSpy.mock.calls[1]?.[1]).toBe("follow-up question");

			// Queue is drained and the tab is idle again.
			const inner = manager as unknown as {
				tabAgents: Map<string, { messageQueue: unknown[] }>;
			};
			expect(inner.tabAgents.get("tab-cont")?.messageQueue).toHaveLength(0);
			expect(manager.getTabStatus("tab-cont")).toBe("idle");
		});

		it('emits message-consumed with reason "continuation" when draining between turns', async () => {
			const manager = new AgentManager();
			const events: AgentEvent[] = [];
			manager.onEvent((e) => events.push(e));
			setRunImpl(runThatEnqueues(manager, "tab-evt", "next"));

			await manager.processMessage("tab-evt", "first");
			await new Promise<void>((r) => setTimeout(r, 50));

			const consumed = events.find((e) => e.type === "message-consumed") as
				| (AgentEvent & { reason?: string })
				| undefined;
			expect(consumed).toBeDefined();
			expect(consumed?.reason).toBe("continuation");
		});

		it("does NOT continue when the queue is empty after a clean turn", async () => {
			const manager = new AgentManager();
			const processSpy = vi.spyOn(manager, "processMessage");

			await manager.processMessage("tab-noqueue", "only message");
			await new Promise<void>((r) => setTimeout(r, 30));

			expect(processSpy).toHaveBeenCalledTimes(1); // no continuation
		});

		it("does NOT continue a turn the user stopped (queue is preserved)", async () => {
			const manager = new AgentManager();
			const processSpy = vi.spyOn(manager, "processMessage");
			// Run that enqueues then aborts itself via stopTab to mimic a user stop.
			setRunImpl(async function* () {
				yield { type: "status", status: "running" } as const;
				manager.queueMessage("tab-stop", "should wait");
				manager.stopTab("tab-stop");
				yield {
					type: "done",
					message: { role: "assistant", chunks: [] },
				} as const;
			});

			await manager.processMessage("tab-stop", "go");
			await new Promise<void>((r) => setTimeout(r, 30));

			// Only the original turn ran; the queued message is preserved, unanswered.
			expect(processSpy).toHaveBeenCalledTimes(1);
			const inner = manager as unknown as {
				tabAgents: Map<string, { messageQueue: unknown[] }>;
			};
			expect(inner.tabAgents.get("tab-stop")?.messageQueue).toHaveLength(1);
		});

		it("bounds runaway agent<->agent continuation via the auto-wake budget", async () => {
			const manager = new AgentManager();
			// A run that ALWAYS enqueues another message → would loop forever
			// without the budget cap.
			setRunImpl(async function* () {
				yield { type: "status", status: "running" } as const;
				manager.queueMessage("tab-loop", "again and again");
				yield {
					type: "done",
					message: { role: "assistant", chunks: [{ type: "text", text: "r" }] },
				} as const;
				yield { type: "status", status: "idle" } as const;
			});
			const processSpy = vi.spyOn(manager, "processMessage");

			await manager.processMessage("tab-loop", "kick off");
			await new Promise<void>((r) => setTimeout(r, 120));

			// 1 original + at most MAX_AGENT_AUTO_WAKES (6) continuations = 7.
			// Crucially BOUNDED, not infinite.
			expect(processSpy.mock.calls.length).toBeLessThanOrEqual(7);
			expect(processSpy.mock.calls.length).toBeGreaterThan(1);
			// Budget spent; the last queued message is held, not answered.
			const inner = manager as unknown as {
				tabAgents: Map<string, { autoWakeBudget: number; messageQueue: unknown[] }>;
			};
			expect(inner.tabAgents.get("tab-loop")?.autoWakeBudget).toBe(0);
			expect(inner.tabAgents.get("tab-loop")?.messageQueue.length).toBeGreaterThan(0);
		});
	});

	describe("getLastTabResponse", () => {
		it("returns the most recent assistant turn's text and current status", () => {
			const manager = new AgentManager();
			setFakeMessages("tab-hist", [
				makeRow("tab-hist", 1, "user", [{ type: "text", text: "hi" }]),
				makeRow("tab-hist", 2, "assistant", [{ type: "text", text: "first answer" }]),
				makeRow("tab-hist", 3, "user", [{ type: "text", text: "again" }]),
				makeRow("tab-hist", 4, "assistant", [
					{ type: "text", text: "second " },
					{ type: "text", text: "answer" },
				]),
			]);

			const res = manager.getLastTabResponse("tab-hist");
			expect(res.text).toBe("second answer");
			expect(res.status).toBe("idle");
		});

		it("returns null text when the tab has no assistant turn yet", () => {
			const manager = new AgentManager();
			setFakeMessages("tab-empty", [
				makeRow("tab-empty", 1, "user", [{ type: "text", text: "hi" }]),
			]);
			const res = manager.getLastTabResponse("tab-empty");
			expect(res.text).toBeNull();
		});

		it("skips assistant turns that contain no text chunks", () => {
			const manager = new AgentManager();
			setFakeMessages("tab-toolonly", [
				makeRow("tab-toolonly", 1, "assistant", [{ type: "text", text: "real answer" }]),
				// A later assistant turn with only non-text chunks should be skipped.
				makeRow("tab-toolonly", 2, "assistant", [{ type: "thinking", text: "hmm" }]),
			]);
			const res = manager.getLastTabResponse("tab-toolonly");
			expect(res.text).toBe("real answer");
		});
	});

	describe("send_to_tab / read_tab permission split", () => {
		// Drives the real parent-path tool construction in getOrCreateAgentForTab
		// by toggling the new split permissions and inspecting which tools the
		// constructed Agent received.
		async function toolsForPerms(tabId: string, perms: Record<string, string>): Promise<string[]> {
			for (const [k, v] of Object.entries(perms)) setFakeSetting(k, v);
			const manager = new AgentManager();
			await manager.processMessage(tabId, "go");
			return constructedAgents.at(-1)?.toolNames ?? [];
		}

		it("grants only send_to_tab when only perm_send_to_tab is allowed", async () => {
			const tools = await toolsForPerms("tab-send-only", { perm_send_to_tab: "allow" });
			expect(tools).toContain("send_to_tab");
			expect(tools).not.toContain("read_tab");
		});

		it("grants only read_tab when only perm_read_tab is allowed", async () => {
			const tools = await toolsForPerms("tab-read-only", { perm_read_tab: "allow" });
			expect(tools).toContain("read_tab");
			expect(tools).not.toContain("send_to_tab");
		});

		it("grants both when both permissions are allowed", async () => {
			const tools = await toolsForPerms("tab-both", {
				perm_send_to_tab: "allow",
				perm_read_tab: "allow",
			});
			expect(tools).toContain("send_to_tab");
			expect(tools).toContain("read_tab");
		});

		it("grants neither when both permissions are off", async () => {
			const tools = await toolsForPerms("tab-neither", {});
			expect(tools).not.toContain("send_to_tab");
			expect(tools).not.toContain("read_tab");
		});
	});

	describe("search_code permission gating", () => {
		// Reuses the parent-path tool construction to confirm the perm flag wires
		// the search_code tool on/off correctly.
		async function toolsForPerms(tabId: string, perms: Record<string, string>): Promise<string[]> {
			for (const [k, v] of Object.entries(perms)) setFakeSetting(k, v);
			const manager = new AgentManager();
			await manager.processMessage(tabId, "go");
			return constructedAgents.at(-1)?.toolNames ?? [];
		}

		it("grants search_code when perm_search_code is allowed", async () => {
			const tools = await toolsForPerms("tab-cs-on", { perm_search_code: "allow" });
			expect(tools).toContain("search_code");
		});

		it("omits search_code when perm_search_code is not allowed", async () => {
			const tools = await toolsForPerms("tab-cs-off", {});
			expect(tools).not.toContain("search_code");
		});
	});

	describe("summon / user_agent permission split", () => {
		// Drives the real parent-path tool construction in
		// getOrCreateAgentForTab by toggling perm_summon and perm_user_agent
		// independently, then inspecting which tools the constructed Agent
		// received. The summon tool must be registered when EITHER permission
		// is granted; `retrieve` rides with the subagent permission only
		// (user agents are fire-and-forget).
		async function toolsForPerms(tabId: string, perms: Record<string, string>): Promise<string[]> {
			for (const [k, v] of Object.entries(perms)) setFakeSetting(k, v);
			const manager = new AgentManager();
			await manager.processMessage(tabId, "go");
			return constructedAgents.at(-1)?.toolNames ?? [];
		}

		it("grants summon + retrieve when only perm_summon is allowed", async () => {
			const tools = await toolsForPerms("tab-summon-only", { perm_summon: "allow" });
			expect(tools).toContain("summon");
			expect(tools).toContain("retrieve");
		});

		it("grants summon WITHOUT retrieve when only perm_user_agent is allowed", async () => {
			// Regression: granting only the user-agent permission used to leave
			// the agent unable to summon user agents because the whole summon
			// tool was gated behind perm_summon.
			const tools = await toolsForPerms("tab-user-agent-only", { perm_user_agent: "allow" });
			expect(tools).toContain("summon");
			expect(tools).not.toContain("retrieve");
		});

		it("grants summon + retrieve when both permissions are allowed", async () => {
			const tools = await toolsForPerms("tab-summon-both", {
				perm_summon: "allow",
				perm_user_agent: "allow",
			});
			expect(tools).toContain("summon");
			expect(tools).toContain("retrieve");
		});

		it("grants neither summon nor retrieve when both permissions are off", async () => {
			const tools = await toolsForPerms("tab-summon-neither", {});
			expect(tools).not.toContain("summon");
			expect(tools).not.toContain("retrieve");
		});
	});

	describe("key_usage permission gate", () => {
		// The key_usage tool is conditionally useful, so it must be COMPLETELY
		// absent from the toolset (and thus the model's context) unless
		// perm_key_usage is explicitly allowed.
		async function toolsForPerms(tabId: string, perms: Record<string, string>): Promise<string[]> {
			for (const [k, v] of Object.entries(perms)) setFakeSetting(k, v);
			const manager = new AgentManager();
			await manager.processMessage(tabId, "go");
			return constructedAgents.at(-1)?.toolNames ?? [];
		}

		it("registers key_usage when perm_key_usage is allowed", async () => {
			const tools = await toolsForPerms("tab-key-usage-on", { perm_key_usage: "allow" });
			expect(tools).toContain("key_usage");
		});

		it("omits key_usage when perm_key_usage is not allowed", async () => {
			const tools = await toolsForPerms("tab-key-usage-off", {});
			expect(tools).not.toContain("key_usage");
		});
	});

	// Regression: granted tab-messaging tools must also be ADVERTISED in the
	// agent's system prompt. The tools were registered in the API tool payload
	// but `buildSystemPrompt` filtered its "You have access to the following
	// tools" list through TOOL_DESCRIPTIONS, which lacked send_to_tab/read_tab
	// — so the model was told it didn't have them and refused to use them. This
	// locks the prompt's capability list to the granted toolset.
	describe("send_to_tab / read_tab system-prompt advertisement", () => {
		async function promptForPerms(tabId: string, perms: Record<string, string>): Promise<string> {
			for (const [k, v] of Object.entries(perms)) setFakeSetting(k, v);
			const manager = new AgentManager();
			await manager.processMessage(tabId, "go");
			return constructedAgents.at(-1)?.systemPrompt ?? "";
		}

		it("lists send_to_tab in the system prompt when granted", async () => {
			const prompt = await promptForPerms("tab-prompt-send", { perm_send_to_tab: "allow" });
			expect(prompt).toContain("- send_to_tab:");
			expect(prompt).not.toContain("- read_tab:");
		});

		it("lists read_tab in the system prompt when granted", async () => {
			const prompt = await promptForPerms("tab-prompt-read", { perm_read_tab: "allow" });
			expect(prompt).toContain("- read_tab:");
			expect(prompt).not.toContain("- send_to_tab:");
		});

		it("lists both tab-messaging tools when both are granted", async () => {
			const prompt = await promptForPerms("tab-prompt-both", {
				perm_send_to_tab: "allow",
				perm_read_tab: "allow",
			});
			expect(prompt).toContain("- send_to_tab:");
			expect(prompt).toContain("- read_tab:");
		});

		it("omits both from the system prompt when neither is granted", async () => {
			const prompt = await promptForPerms("tab-prompt-neither", {});
			expect(prompt).not.toContain("- send_to_tab:");
			expect(prompt).not.toContain("- read_tab:");
		});

		it("advertises exactly the granted tab tools (prompt list matches schema)", async () => {
			for (const [k, v] of Object.entries({
				perm_send_to_tab: "allow",
				perm_read_tab: "allow",
			})) {
				setFakeSetting(k, v);
			}
			const manager = new AgentManager();
			await manager.processMessage("tab-prompt-match", "go");
			const inst = constructedAgents.at(-1);
			// Every granted tab-messaging tool surfaced in the schema must also be
			// advertised in the prompt, so the model never believes it lacks one.
			for (const name of ["send_to_tab", "read_tab"]) {
				expect(inst?.toolNames).toContain(name);
				expect(inst?.systemPrompt).toContain(`- ${name}:`);
			}
		});
	});

	// ─── Usage side-channel persistence ──────────────────────────────
	//
	// `usage` AgentEvents (one per LLM round-trip) are persisted as invisible
	// `type:"usage"` chunk rows so per-tab token/cache telemetry survives a
	// reload. They ride the SAME atomic appendChunks call as the turn's content
	// rows (one fsync, contiguous seqs). A superseded fallback attempt's usage is
	// discarded with its `chunks` (per-attempt accumulator).
	describe("usage persistence", () => {
		it("writes one usage row per usage event emitted during a turn", async () => {
			const manager = new AgentManager();
			setRunImpl(async function* () {
				yield { type: "status", status: "running" } as const;
				yield {
					type: "usage",
					usage: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
				} as const;
				yield { type: "text-delta", delta: "step two" } as const;
				yield {
					type: "usage",
					usage: {
						inputTokens: 1200,
						outputTokens: 60,
						cacheReadTokens: 1000,
						cacheWriteTokens: 100,
					},
				} as const;
				yield {
					type: "done",
					message: { role: "assistant", chunks: [{ type: "text", text: "step two" }] },
				} as const;
				yield { type: "status", status: "idle" } as const;
			});

			await manager.processMessage("tab-usage-rows", "go");

			const usageDrafts = appendChunksCalls
				.flatMap((c) => c.drafts)
				.filter((d) => d.type === "usage");
			expect(usageDrafts).toHaveLength(2);
			// One row per event, role=assistant, step cosmetic (0).
			expect(usageDrafts.every((d) => d.role === "assistant" && d.step === 0)).toBe(true);
			expect(usageDrafts[0]?.data).toEqual({
				inputTokens: 1000,
				outputTokens: 40,
				cacheReadTokens: 0,
				cacheWriteTokens: 900,
			});
			expect(usageDrafts[1]?.data).toEqual({
				inputTokens: 1200,
				outputTokens: 60,
				cacheReadTokens: 1000,
				cacheWriteTokens: 100,
			});
		});

		it("attaches the DB usage aggregate to the turn-sealed event for live reconciliation", async () => {
			const manager = new AgentManager();
			const aggregate = {
				inputTokens: 222,
				outputTokens: 22,
				cacheReadTokens: 100,
				cacheWriteTokens: 5,
				requests: 1,
				last: { inputTokens: 222, outputTokens: 22, cacheReadTokens: 100, cacheWriteTokens: 5 },
			};
			fakeUsageStatsByTab.set("tab-sealed-usage", aggregate);

			const events: AgentEvent[] = [];
			manager.onEvent((event) => {
				events.push(event);
			});

			await manager.processMessage("tab-sealed-usage", "go");

			const sealed = events.find((e) => e.type === "turn-sealed") as
				| Extract<AgentEvent, { type: "turn-sealed" }>
				| undefined;
			expect(sealed).toBeDefined();
			// The aggregate read AFTER the write is carried on the event so the
			// frontend can REPLACE its live cacheStats with the DB truth.
			expect(sealed?.usageStats).toEqual(aggregate);
		});

		it("emits usage rows in the SAME appendChunks call as the turn's content (one atomic write)", async () => {
			const manager = new AgentManager();
			setRunImpl(async function* () {
				yield { type: "status", status: "running" } as const;
				yield { type: "text-delta", delta: "hi" } as const;
				yield {
					type: "usage",
					usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 },
				} as const;
				yield {
					type: "done",
					message: { role: "assistant", chunks: [{ type: "text", text: "hi" }] },
				} as const;
				yield { type: "status", status: "idle" } as const;
			});

			await manager.processMessage("tab-usage-atomic", "go");

			// Exactly one appendChunks call carries the usage draft (the flush). The
			// user-message append and any system-row appends carry no usage rows.
			const callsWithUsage = appendChunksCalls.filter((c) =>
				c.drafts.some((d) => d.type === "usage"),
			);
			expect(callsWithUsage).toHaveLength(1);
			expect(callsWithUsage[0]?.tabId).toBe("tab-usage-atomic");
		});

		it("discards a superseded (rate-limited) attempt's usage on fallback", async () => {
			const manager = new AgentManager();
			// Inject a minimal model registry so the rate-limit fallback path is
			// taken (real `processMessage` requires modelRegistry + a resolved
			// keyId + a next fallback entry to retry).
			const markKeyExhausted = vi.fn();
			(
				manager as unknown as {
					modelRegistry: {
						getKeys(): Array<{ definition: Record<string, unknown> }>;
						markKeyExhausted(): void;
					};
				}
			).modelRegistry = {
				getKeys: () => [
					{
						definition: {
							id: "k1",
							provider: "openai-compatible",
							env: "ENV1",
							base_url: "http://x",
						},
					},
					{
						definition: {
							id: "k2",
							provider: "openai-compatible",
							env: "ENV2",
							base_url: "http://y",
						},
					},
				],
				markKeyExhausted,
			};

			let attempt = 0;
			setRunImpl(async function* () {
				attempt++;
				yield { type: "status", status: "running" } as const;
				if (attempt === 1) {
					// Attempt 1 emits usage then rate-limits — its usage must be dropped.
					yield {
						type: "usage",
						usage: { inputTokens: 999, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
					} as const;
					yield { type: "error", error: "rate limit exceeded (status=429)" } as const;
					return;
				}
				// Attempt 2 succeeds — only its usage should persist.
				yield {
					type: "usage",
					usage: { inputTokens: 222, outputTokens: 22, cacheReadTokens: 100, cacheWriteTokens: 5 },
				} as const;
				yield {
					type: "done",
					message: { role: "assistant", chunks: [{ type: "text", text: "recovered" }] },
				} as const;
				yield { type: "status", status: "idle" } as const;
			});

			const agentModels = [
				{ key_id: "k1", model_id: "m1" },
				{ key_id: "k2", model_id: "m2" },
			];
			await manager.processMessage(
				"tab-usage-fallback",
				"go",
				undefined,
				undefined,
				undefined,
				undefined,
				agentModels,
			);

			expect(attempt).toBe(2); // confirm the fallback retry actually happened
			expect(markKeyExhausted).toHaveBeenCalled();

			const usageDrafts = appendChunksCalls
				.flatMap((c) => c.drafts)
				.filter((d) => d.type === "usage");
			// Only attempt 2's usage survives.
			expect(usageDrafts).toHaveLength(1);
			expect(usageDrafts[0]?.data).toEqual({
				inputTokens: 222,
				outputTokens: 22,
				cacheReadTokens: 100,
				cacheWriteTokens: 5,
			});
		});
	});

	describe("warmCacheForTab (prompt-cache warming)", () => {
		it("returns the warm request usage and forwards the FULL genuine history", async () => {
			const manager = new AgentManager();
			setFakeMessages("tab-warm", [
				makeRow("tab-warm", 1, "user", [{ type: "text", text: "hello" }]),
				makeRow("tab-warm", 2, "assistant", [{ type: "text", text: "hi" }]),
			]);

			const result = await manager.warmCacheForTab("tab-warm");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.usage).toEqual({
					inputTokens: 1200,
					outputTokens: 1,
					cacheReadTokens: 1100,
					cacheWriteTokens: 0,
				});
			}
			// The genuine history is forwarded UNTRIMMED (both turns), so the
			// replayed prefix matches the next real turn exactly.
			expect(capturedWarmHistories).toHaveLength(1);
			expect(capturedWarmHistories[0]).toHaveLength(2);
		});

		it("does NOT persist anything (no appendChunks for the warm request)", async () => {
			const manager = new AgentManager();
			setFakeMessages("tab-warm-2", [
				makeRow("tab-warm-2", 1, "user", [{ type: "text", text: "hello" }]),
			]);
			await manager.warmCacheForTab("tab-warm-2");
			// Warming must never write chunk rows (history / usage / anything).
			expect(appendChunksCalls).toHaveLength(0);
		});

		it("refuses to warm while the tab is generating", async () => {
			const manager = new AgentManager();
			// Start a turn (status flips to running) but don't await it.
			const running = manager.processMessage("tab-warm-busy", "go");
			// Let the mock run() yield its first running status.
			await new Promise<void>((r) => setTimeout(r, 1));
			const result = await manager.warmCacheForTab("tab-warm-busy");
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBe("tab is generating");
			await running;
		});
	});
});

describe("AgentManager.compactTab", () => {
	beforeEach(() => {
		resetFakeMessages();
		resetConstructedAgents();
		resetCapturedRunOptions();
		resetFakeTabs();
		resetFakeSettings();
		setRunImpl(null);
		appendEventToChunksSpy.mockClear();
		resetAppendChunksCalls();
		resetFakeUsageStats();
		resetCompactionScaffolding();
	});

	/** Seed a usable compaction model (config key + registry key + env key). */
	function seedCompactorModel(keyId = "k1", modelId = "m1"): void {
		fakeConfigKeys.push({ id: keyId, provider: "opencode-go", base_url: "https://x", env: "K1" });
		fakeRegistryKeys.push({ id: keyId, provider: "opencode-go", base_url: "https://x", env: "K1" });
		fakeApiKeys.set(keyId, "secret");
		setFakeSetting("compaction_model_key_id", keyId);
		setFakeSetting("compaction_model_id", modelId);
	}

	it("errors when the conversation is too short to compact (empty prompt)", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((e) => events.push(e));

		setFakeTab({ id: "src", title: "Chat" });
		fakeChunksByTab.set("src", [{ tabId: "src" }]);
		// No prompt → nothing to compact.
		fakeCompactionByTab.set("src", { tail: [], prompt: undefined });

		await manager.compactTab("temp", "src");

		const err = events.find((e) => e.type === "compaction-error");
		expect(err).toMatchObject({ type: "compaction-error", tempTabId: "temp", sourceTabId: "src" });
		// No backup tab created, no rekey.
		expect(createTabCalls).toHaveLength(0);
		expect(rekeyCalls).toHaveLength(0);
	});

	it("errors when no compaction model can be resolved", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((e) => events.push(e));

		setFakeTab({ id: "src", title: "Chat", keyId: null, modelId: null });
		fakeChunksByTab.set("src", [{ tabId: "src" }]);
		// Compactable, but no configured model and the tab has no key/model.
		// (no seedCompactorModel call)

		await manager.compactTab("temp", "src");

		expect(events.some((e) => e.type === "compaction-error")).toBe(true);
		expect(rekeyCalls).toHaveLength(0);
	});

	it("refuses to compact while the source tab is running", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((e) => events.push(e));

		setFakeTab({ id: "src", title: "Chat" });
		fakeChunksByTab.set("src", [{ tabId: "src" }]);
		// Start a (never-finishing) turn so the tab is "running".
		setRunImpl(async function* () {
			yield { type: "status", status: "running" } as const;
			await new Promise<void>((r) => setTimeout(r, 50));
			yield { type: "status", status: "idle" } as const;
		});
		void manager.processMessage("src", "hi");
		// Give processMessage a tick to flip status to running.
		await new Promise<void>((r) => setTimeout(r, 5));

		await manager.compactTab("temp", "src");
		const err = events.find((e) => e.type === "compaction-error");
		expect(err).toBeDefined();
		expect(rekeyCalls).toHaveLength(0);
	});

	it("happy path: summarizes, relocates history to a backup, re-seeds the source", async () => {
		seedCompactorModel();
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((e) => events.push(e));

		setFakeTab({ id: "src", title: "My Chat", keyId: "k1", modelId: "m1" });
		fakeChunksByTab.set("src", [{ tabId: "src" }, { tabId: "src" }]);
		fakeCompactionByTab.set("src", {
			prompt: "SUMMARY PROMPT",
			tail: [
				{ turnId: "tail-u", role: "user", chunks: [{ type: "text", text: "recent q" }] },
				{ turnId: "tail-a", role: "assistant", chunks: [{ type: "text", text: "recent a" }] },
			],
		});

		await manager.compactTab("temp", "src");

		// started + complete emitted; no error.
		expect(events.some((e) => e.type === "compaction-started")).toBe(true);
		const complete = events.find((e) => e.type === "compaction-complete") as
			| (AgentEvent & { backupTabId: string; backupTitle: string })
			| undefined;
		expect(complete).toBeDefined();
		expect(events.some((e) => e.type === "compaction-error")).toBe(false);

		// A backup tab was created and history was relocated onto it.
		expect(createTabCalls).toHaveLength(1);
		expect(rekeyCalls).toHaveLength(1);
		expect(rekeyCalls[0]).toMatchObject({ from: "src", to: createTabCalls[0]?.id });
		expect(complete?.backupTabId).toBe(createTabCalls[0]?.id);
		expect(complete?.backupTitle).toContain("pre-compaction");

		// The source was re-seeded: appendChunks was called for "src" after rekey
		// (summary turn + preserved tail).
		const srcAppends = appendChunksCalls.filter((c) => c.tabId === "src");
		expect(srcAppends.length).toBeGreaterThanOrEqual(1);
	});

	it("queues messages sent to the source while compaction is in flight", async () => {
		seedCompactorModel();
		const manager = new AgentManager();
		setFakeTab({ id: "src", title: "Chat", keyId: "k1", modelId: "m1" });
		fakeChunksByTab.set("src", [{ tabId: "src" }]);
		fakeCompactionByTab.set("src", {
			prompt: "SUMMARY PROMPT",
			tail: [{ turnId: "t", role: "user", chunks: [{ type: "text", text: "recent" }] }],
		});

		// Make the summary generation slow so we can deliver mid-compaction.
		setRunImpl(async function* () {
			yield { type: "status", status: "running" } as const;
			await new Promise<void>((r) => setTimeout(r, 40));
			yield { type: "text-delta", delta: "summary text" } as const;
			yield { type: "status", status: "idle" } as const;
		});

		const compaction = manager.compactTab("temp", "src");
		await new Promise<void>((r) => setTimeout(r, 10));
		// While compacting, a human message should be QUEUED, not started.
		const result = manager.deliverMessage("src", "hello during compaction");
		expect(result.status).toBe("queued");

		await compaction;
	});
});
