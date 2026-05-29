import {
	Agent,
	type AgentEvent,
	type AgentSkillMapping,
	type AgentStatus,
	appendEventToChunks,
	appendMessage,
	applySystemEvent,
	BackgroundShellStore,
	BackgroundTranscriptStore,
	type Chunk,
	type ClaudeAccount,
	clearSpillForTab,
	configToRuleset,
	createConfigWatcher,
	createListFilesTool,
	createReadFileSliceTool,
	createReadFileTool,
	createRetrieveTool,
	createRunShellTool,
	createSkillsWatcher,
	createSummonTool,
	createTaskListTool,
	createWebSearchTool,
	createWriteFileTool,
	createYoutubeTranscribeTool,
	type DispatchConfig,
	expandAgentToolNames,
	GLOBAL_AGENTS_DIR,
	getAgentDirPaths,
	getClaudeAccountsFromDB,
	getMessagesForTab,
	getSetting,
	loadAgent,
	loadAgents,
	loadConfig,
	loadSkills,
	ModelRegistry,
	type QueuedMessage,
	refreshAccountCredentials,
	refreshAccountCredentialsAsync,
	resolveApiKey,
	type SkillDefinition,
	type SystemChunkKind,
	type TabStatusSnapshot,
	TaskList,
	toAvailableAgents,
	updateMessage,
	validateConfig,
} from "@dispatch/core";
import type { PermissionManager } from "./permission-manager.js";
import { setConfigGetter } from "./routes/config.js";
import { setAccountsGetter, setModelsGetter } from "./routes/models.js";
import { setSkillsGetter } from "./routes/skills.js";
import { setTabsAgentManager } from "./routes/tabs.js";

const TOOL_DESCRIPTIONS: Record<string, string> = {
	read_file: "Read the contents of a file",
	read_file_slice:
		"Read a character-range slice of a single line in a file (for inspecting long lines that read_file truncated)",
	list_files: "List files and directories",
	write_file: "Write content to a file (creates parent directories if needed)",
	run_shell:
		"Execute shell commands in the working directory (bash). Returns stdout, stderr, and exit code. Set background=true to run in the background and get a job_id for later retrieval. Do NOT run destructive or irreversible commands unless the user explicitly requests them.",
	todo: "Manage a todo list for planning and tracking work. Actions: add, update, list, get, remove. Statuses: pending, in_progress, done.",
	summon:
		"Spawn a child agent to work on a task independently. By default blocks until the child finishes. Set background=true to return immediately with an agent_id for later retrieval.",
	retrieve:
		"Wait for a background task to finish and get its result (blocking). Pass the job_id or agent_id.",
	web_search: "Search the web and optionally scrape full page content from results.",
	youtube_transcribe:
		"Fetch the transcript/subtitles for a YouTube video. Set background=true to start in the background and get a job_id for later retrieval.",
};

const DEFAULT_SYSTEM_PROMPT =
	"You are Dispatch, an agent designed to help with any task that the user asks for. Be helpful and concise.";

const TODO_GUIDANCE = `
## Todo List

The user can see your todo list in real-time. Use it to communicate your plan and progress.

### When to use
- Tasks that require 3 or more steps
- When the user provides multiple things to do
- Complex work that benefits from planning before starting
- After receiving new instructions, capture them as todos immediately

### When NOT to use
- Single, straightforward tasks that need no tracking
- Purely conversational or informational responses
- Anything completable in under 3 trivial steps

### State management
- Only ONE item should be "in_progress" at a time. Finish current work before starting the next item.
- Mark items "done" IMMEDIATELY after completing them. Do not batch completions.
- When starting work on an item, mark it "in_progress" first.
- Add new items as you discover sub-tasks during execution.

### Examples

User: "Run the build and fix any type errors"
Good approach:
1. Add todo: "Run the build" -> mark in_progress -> run build -> mark done
2. If 5 errors found, add 5 todos for each error
3. Work through each one sequentially, marking in_progress then done

User: "What does the git status command do?"
No todo needed — this is a simple informational question.

User: "Rename the function getUser to fetchUser across the project"
Good approach:
1. Add todo: "Search for all occurrences of getUser"
2. After searching, add a todo per file that needs changes
3. Work through each file sequentially
`.trim();

/**
 * Returns true for OpenCode Go models served via the Anthropic-format
 * `/messages` endpoint (MiniMax M2.x, Qwen3.x Plus). See
 * https://opencode.ai/docs/go/#endpoints for the per-model endpoint table.
 */
function isOpencodeGoAnthropicModel(modelId: string): boolean {
	return modelId.startsWith("minimax-") || modelId.startsWith("qwen");
}

function buildSystemPrompt(toolNames: string[], basePrompt?: string): string {
	const base = basePrompt || DEFAULT_SYSTEM_PROMPT;
	const toolList = toolNames
		.filter((name) => TOOL_DESCRIPTIONS[name])
		.map((name) => `- ${name}: ${TOOL_DESCRIPTIONS[name]}`)
		.join("\n");

	if (!toolList) return base;

	const hasTodo = toolNames.includes("todo");
	let prompt = `${base}\n\nYou have access to the following tools:\n\n${toolList}\n\nWhen asked to work with files, use these tools. Always confirm what you did after completing an action.`;
	if (hasTodo) {
		prompt += `\n\n${TODO_GUIDANCE}`;
	}
	return prompt;
}

interface TabAgent {
	agent: Agent | null;
	status: AgentStatus;
	keyId: string | null;
	modelId: string | null;
	taskList: TaskList;
	_lastPermKey?: string;
	/** Ordered key+model fallback hierarchy from the agent definition. */
	agentModels?: Array<{ key_id: string; model_id: string }>;
	/** Abort controller for cancelling a running agent. */
	abortController?: AbortController;
	/** For child agents: resolves when the agent finishes its task. */
	completionResolve?: (
		result: { status: "done"; result: string } | { status: "error"; error: string },
	) => void;
	completionPromise?: Promise<
		{ status: "done"; result: string } | { status: "error"; error: string }
	>;
	/** Accumulated final text output from the child agent. */
	finalOutput?: string;
	/** Tools whitelist for child agents (set by summon). */
	toolsOverride?: string[];
	/** Working directory override for child agents. */
	workingDirectoryOverride?: string;
	/** Queue of messages sent while the agent is running. */
	messageQueue: QueuedMessage[];
	/** Callbacks to wake up blocking tools waiting for queued messages. */
	queueListeners: Array<() => void>;
	/** Store for shell commands backgrounded due to user interrupt. */
	shellStore: BackgroundShellStore;
	/** Store for transcript requests backgrounded due to user interrupt. */
	transcriptStore: BackgroundTranscriptStore;
	/**
	 * In-flight assistant message chunks for the active turn. `null` when
	 * no turn is running. Out-of-band system events (config-reload,
	 * cancel, etc.) target this list when present.
	 */
	currentChunks: Chunk[] | null;
	/** DB id of the in-flight assistant message (if persisted yet). */
	currentAssistantId: string | null;
}

export class AgentManager {
	private tabAgents: Map<string, TabAgent> = new Map();
	private messageCount = 0;
	private eventListeners: Set<(event: AgentEvent & { tabId: string }) => void> = new Set();
	private permissionManager: PermissionManager | undefined;

	private config: DispatchConfig;
	private skillsData: { skills: SkillDefinition[]; mappings: AgentSkillMapping[] };
	private modelRegistry: ModelRegistry | null = null;

	private configWatcher: { close(): void } | null = null;
	private skillsWatcher: { close(): void } | null = null;

	private claudeAccounts: ClaudeAccount[] = [];

	constructor(permissionManager?: PermissionManager) {
		this.permissionManager = permissionManager;

		const workingDirectory = process.env.DISPATCH_WORKING_DIR ?? process.cwd();

		// Load initial config
		this.config = loadConfig(workingDirectory);
		const { errors } = validateConfig(this.config);
		if (errors.length > 0) {
			for (const err of errors) {
				console.warn(`dispatch: config validation warning [${err.path}]: ${err.message}`);
			}
		}

		// Initialize model registry + resolver if config has models and keys
		this._initModelRegistry(this.config);

		// Load initial skills
		this.skillsData = loadSkills(workingDirectory);

		// Discover Claude accounts
		this._refreshClaudeAccounts();

		// Wire route getters
		setConfigGetter(() => this.config);
		setSkillsGetter(() => this.skillsData);
		setModelsGetter(() => this.modelRegistry);
		setAccountsGetter(() => this.claudeAccounts);
		setTabsAgentManager(() => this);

		// Set up hot-reload watchers
		this.configWatcher = createConfigWatcher(workingDirectory, (newConfig) => {
			this.config = newConfig;
			const { errors: newErrors } = validateConfig(newConfig);
			if (newErrors.length > 0) {
				for (const err of newErrors) {
					console.warn(`dispatch: config validation warning [${err.path}]: ${err.message}`);
				}
			}
			// Update model registry with new config
			this._initModelRegistry(newConfig);
			// Invalidate cached agents so next message uses updated config
			for (const tabAgent of this.tabAgents.values()) {
				tabAgent.agent = null;
			}
			// Emit config-reload to all tabs (and persist as a system chunk)
			for (const tabId of this.tabAgents.keys()) {
				this.emit({ type: "config-reload" }, tabId);
				this.routeSystemEventToTab(tabId, "config-reload", "Configuration reloaded");
			}
		});

		this.skillsWatcher = createSkillsWatcher(workingDirectory, (result) => {
			this.skillsData = result;
			// Invalidate cached agents so next message uses updated skills
			for (const tabAgent of this.tabAgents.values()) {
				tabAgent.agent = null;
			}
			// Emit config-reload to all tabs (and persist as a system chunk)
			for (const tabId of this.tabAgents.keys()) {
				this.emit({ type: "config-reload" }, tabId);
				this.routeSystemEventToTab(tabId, "config-reload", "Skills reloaded");
			}
		});
	}

	private _refreshClaudeAccounts(): void {
		try {
			this.claudeAccounts = getClaudeAccountsFromDB();
			if (this.claudeAccounts.length > 0) {
				console.log(`dispatch: discovered ${this.claudeAccounts.length} Claude account(s)`);
			}
		} catch (err) {
			console.warn(
				`dispatch: failed to discover Claude accounts: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private _initModelRegistry(config: DispatchConfig): void {
		if (config.keys) {
			if (this.modelRegistry) {
				this.modelRegistry.updateConfig(config.keys);
			} else {
				this.modelRegistry = new ModelRegistry(config.keys);
			}
		} else {
			this.modelRegistry = null;
		}
	}

	getPermissionManager(): PermissionManager | undefined {
		return this.permissionManager;
	}

	/** Get the TaskList for a specific tab (creates the tab entry if missing). */
	getTaskList(tabId: string): TaskList {
		return this._getOrCreateTabAgent(tabId).taskList;
	}

	getClaudeAccounts(): ClaudeAccount[] {
		return this.claudeAccounts;
	}

	/** Get or create the TabAgent entry for a tab (without creating an Agent). */
	private _getOrCreateTabAgent(tabId: string): TabAgent {
		let tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) {
			const taskList = new TaskList();
			taskList.onChange((tasks) => {
				this.emit({ type: "task-list-update", tasks }, tabId);
			});
			tabAgent = {
				agent: null,
				status: "idle",
				keyId: null,
				modelId: null,
				taskList,
				messageQueue: [],
				queueListeners: [],
				shellStore: new BackgroundShellStore(),
				transcriptStore: new BackgroundTranscriptStore(),
				currentChunks: null,
				currentAssistantId: null,
			};
			this.tabAgents.set(tabId, tabAgent);
		}
		return tabAgent;
	}

	private async getOrCreateAgentForTab(
		tabId: string,
		keyId?: string,
		modelId?: string,
	): Promise<Agent> {
		const tabAgent = this._getOrCreateTabAgent(tabId);

		// Determine effective override: use provided values, or fall back to stored per-tab values
		const effectiveKeyId = keyId ?? tabAgent.keyId;
		const effectiveModelId = modelId ?? tabAgent.modelId;

		// Read tool permission settings from DB (default: read=allow, edit=ask, bash=ask, summon=ask, web=ask, youtube=ask)
		const permRead = getSetting("perm_read") !== "ask";
		const permEdit = getSetting("perm_edit") === "allow";
		const permBash = getSetting("perm_bash") === "allow";
		const permSummon = getSetting("perm_summon") === "allow";
		const permWebSearch = getSetting("perm_web_search") === "allow";
		const permYoutubeTranscribe = getSetting("perm_youtube_transcribe") === "allow";
		const sysPrompt = getSetting("system_prompt") ?? "";
		const permKey = `${permRead}:${permEdit}:${permBash}:${permSummon}:${permWebSearch}:${permYoutubeTranscribe}:${sysPrompt}`;

		// If the override differs or permissions changed, invalidate the cached agent
		if (
			tabAgent.agent &&
			(effectiveKeyId !== tabAgent.keyId ||
				effectiveModelId !== tabAgent.modelId ||
				permKey !== tabAgent._lastPermKey)
		) {
			tabAgent.agent = null;
		}

		if (!tabAgent.agent) {
			const defaultWorkDir = process.env.DISPATCH_WORKING_DIR ?? process.cwd();
			let workingDirectory = tabAgent.workingDirectoryOverride ?? defaultWorkDir;

			// Expand ~ to home directory
			if (workingDirectory === "~" || workingDirectory.startsWith("~/")) {
				const { homedir } = await import("node:os");
				const { join } = await import("node:path");
				workingDirectory = join(homedir(), workingDirectory.slice(1));
			}

			// Resolve relative paths against the default working directory
			// (e.g. subagent cwd "./subtask" resolves relative to the parent's effective dir)
			{
				const { isAbsolute, resolve } = await import("node:path");
				if (!isAbsolute(workingDirectory)) {
					workingDirectory = resolve(defaultWorkDir, workingDirectory);
				}
			}

			// Auto-create the working directory if it doesn't exist
			try {
				const { mkdirSync, existsSync } = await import("node:fs");
				if (!existsSync(workingDirectory)) {
					mkdirSync(workingDirectory, { recursive: true });
				}
			} catch {
				// Ignore — tool execution will surface the error naturally
			}

			// Build tools list — child agents use their toolsOverride whitelist,
			// parent agents use permission settings from DB
			const toolEntries: Array<{ name: string; tool: ReturnType<typeof createReadFileTool> }> = [];

			if (tabAgent.toolsOverride) {
				// Child agent: use explicit tool whitelist
				const allowed = new Set(tabAgent.toolsOverride);
				if (allowed.has("read_file")) {
					toolEntries.push({ name: "read_file", tool: createReadFileTool(workingDirectory) });
					// read_file_slice is a companion to read_file — only useful for
					// inspecting long lines that read_file truncated. Ship them together.
					toolEntries.push({
						name: "read_file_slice",
						tool: createReadFileSliceTool(workingDirectory),
					});
					// list_files is bundled with read access
					if (allowed.has("list_files")) {
						toolEntries.push({ name: "list_files", tool: createListFilesTool(workingDirectory) });
					}
				}
				if (allowed.has("list_files") && !allowed.has("read_file")) {
					toolEntries.push({ name: "list_files", tool: createListFilesTool(workingDirectory) });
				}
				if (allowed.has("write_file")) {
					toolEntries.push({ name: "write_file", tool: createWriteFileTool(workingDirectory) });
				}
				if (allowed.has("run_shell")) {
					toolEntries.push({
						name: "run_shell",
						tool: createRunShellTool(workingDirectory, tabAgent.shellStore),
					});
				}
				if (allowed.has("web_search")) {
					toolEntries.push({ name: "web_search", tool: createWebSearchTool() });
				}
				if (allowed.has("youtube_transcribe")) {
					toolEntries.push({
						name: "youtube_transcribe",
						tool: createYoutubeTranscribeTool(tabAgent.transcriptStore),
					});
				}
				if (allowed.has("todo")) {
					toolEntries.push({ name: "todo", tool: createTaskListTool(tabAgent.taskList) });
				}
				if (allowed.has("summon")) {
					const childParentAllowedTools = new Set(toolEntries.map((e) => e.name));
					const availableAgents = toAvailableAgents(
						loadAgents(workingDirectory),
						GLOBAL_AGENTS_DIR,
						workingDirectory,
					);
					const agentDirPaths = getAgentDirPaths(workingDirectory);
					toolEntries.push({
						name: "summon",
						tool: createSummonTool(
							workingDirectory,
							{
								spawn: (opts) =>
									this.spawnChildAgent({
										...opts,
										parentKeyId: tabAgent.keyId,
										parentModelId: tabAgent.modelId,
										parentAllowedTools: childParentAllowedTools,
										parentTabId: tabId,
									}),
								getResult: (id) => this.getChildResult(id),
							},
							availableAgents,
							agentDirPaths,
						),
					});
				}
				if (allowed.has("retrieve")) {
					toolEntries.push({
						name: "retrieve",
						tool: createRetrieveTool({
							getResult: (id) =>
								tabAgent.shellStore.has(id)
									? tabAgent.shellStore.getResult(id)
									: tabAgent.transcriptStore.has(id)
										? tabAgent.transcriptStore.getResult(id)
										: this.getChildResult(id),
						}),
					});
				}
			} else {
				// Parent agent: use permission settings from DB
				if (permRead) {
					toolEntries.push({ name: "read_file", tool: createReadFileTool(workingDirectory) });
					toolEntries.push({
						name: "read_file_slice",
						tool: createReadFileSliceTool(workingDirectory),
					});
					toolEntries.push({ name: "list_files", tool: createListFilesTool(workingDirectory) });
				}
				if (permEdit) {
					toolEntries.push({ name: "write_file", tool: createWriteFileTool(workingDirectory) });
				}
				if (permBash) {
					toolEntries.push({
						name: "run_shell",
						tool: createRunShellTool(workingDirectory, tabAgent.shellStore),
					});
				}
				if (permWebSearch) {
					toolEntries.push({ name: "web_search", tool: createWebSearchTool() });
				}
				if (permYoutubeTranscribe) {
					toolEntries.push({
						name: "youtube_transcribe",
						tool: createYoutubeTranscribeTool(tabAgent.transcriptStore),
					});
				}
				toolEntries.push({ name: "todo", tool: createTaskListTool(tabAgent.taskList) });
				if (permSummon) {
					// Capture parent's allowed tool names for child permission enforcement
					const parentAllowedTools = new Set(toolEntries.map((e) => e.name));
					const availableAgents = toAvailableAgents(
						loadAgents(workingDirectory),
						GLOBAL_AGENTS_DIR,
						workingDirectory,
					);
					const agentDirPaths = getAgentDirPaths(workingDirectory);
					toolEntries.push({
						name: "summon",
						tool: createSummonTool(
							workingDirectory,
							{
								spawn: (opts) =>
									this.spawnChildAgent({
										...opts,
										parentKeyId: tabAgent.keyId,
										parentModelId: tabAgent.modelId,
										parentAllowedTools,
										parentTabId: tabId,
									}),
								getResult: (id) => this.getChildResult(id),
							},
							availableAgents,
							agentDirPaths,
						),
					});
					toolEntries.push({
						name: "retrieve",
						tool: createRetrieveTool({
							getResult: (id) =>
								tabAgent.shellStore.has(id)
									? tabAgent.shellStore.getResult(id)
									: tabAgent.transcriptStore.has(id)
										? tabAgent.transcriptStore.getResult(id)
										: this.getChildResult(id),
						}),
					});
				}
			}

			const tools = toolEntries.map((e) => e.tool);
			const toolNames = toolEntries.map((e) => e.name);
			tabAgent._lastPermKey = permKey;

			const ruleset = configToRuleset(this.config);

			// Try to resolve model from registry, fall back to env vars
			let apiKey = "";
			let model = "deepseek-v4-flash";
			let baseURL = "https://opencode.ai/zen/go/v1";
			let provider: string | undefined;
			let claudeCredentials: { accessToken: string } | undefined;

			let useOverride = false;

			if (effectiveKeyId && effectiveModelId && this.modelRegistry) {
				// Direct override: look up the key by id in the registry
				const keyState = this.modelRegistry
					.getKeys()
					.find((k) => k.definition.id === effectiveKeyId);
				if (keyState) {
					const key = keyState.definition;
					if (key.provider === "anthropic") {
						// Anthropic provider: resolve credentials from Claude accounts
						const credFile = key.credentials_file;
						const account =
							this.claudeAccounts.find((a) => a.id === effectiveKeyId) ??
							(credFile
								? this.claudeAccounts.find((a) => a.source === credFile)
								: this.claudeAccounts[0]);
						if (account) {
							const creds = refreshAccountCredentials(account);
							if (creds && creds.expiresAt > Date.now() + 60_000) {
								claudeCredentials = { accessToken: creds.accessToken };
								apiKey = creds.accessToken;
								baseURL = key.base_url;
								model = effectiveModelId;
								provider = "anthropic";
								tabAgent.keyId = effectiveKeyId;
								tabAgent.modelId = effectiveModelId;
								useOverride = true;
							} else {
								// Token expired — await the async refresh
								const fresh = await refreshAccountCredentialsAsync(account);
								if (fresh && fresh.expiresAt > Date.now() + 60_000) {
									account.credentials = fresh;
									claudeCredentials = { accessToken: fresh.accessToken };
									apiKey = fresh.accessToken;
									baseURL = key.base_url;
									model = effectiveModelId;
									provider = "anthropic";
									tabAgent.keyId = effectiveKeyId;
									tabAgent.modelId = effectiveModelId;
									useOverride = true;
								} else {
									console.warn(
										`dispatch: unable to refresh Claude credentials for "${account.label}" — using stale token`,
									);
									claudeCredentials = { accessToken: account.credentials.accessToken };
									apiKey = account.credentials.accessToken;
									baseURL = key.base_url;
									model = effectiveModelId;
									provider = "anthropic";
									tabAgent.keyId = effectiveKeyId;
									tabAgent.modelId = effectiveModelId;
									useOverride = true;
								}
							}
						} else {
							console.warn(`dispatch: no Claude credentials found for key "${key.id}"`);
						}
					} else {
						// Standard key: resolve from env var
						const envKey = resolveApiKey(key.id, key.env);
						if (envKey) {
							apiKey = envKey;
							baseURL = key.base_url;
							model = effectiveModelId;
							// OpenCode Go splits its catalog across two endpoints:
							//   `/chat/completions` — GLM, Kimi, DeepSeek, MiMo (OpenAI-compatible)
							//   `/messages`        — MiniMax, Qwen (Anthropic-format)
							// The configured key has provider="opencode-go" which defaults to
							// the OpenAI-compatible path. When the selected model lives on the
							// `/messages` route, route through the API-key Anthropic provider
							// instead so the SDK targets the correct endpoint and protocol.
							if (key.provider === "opencode-go" && isOpencodeGoAnthropicModel(model)) {
								provider = "opencode-anthropic";
							}
							tabAgent.keyId = effectiveKeyId;
							tabAgent.modelId = effectiveModelId;
							useOverride = true;
						} else {
							console.warn(
								`dispatch: env var "${key.env}" not set for key "${key.id}", falling back to env vars`,
							);
							// Apply the correct model + baseURL even when the key
							// is unavailable so the request at least targets the
							// right endpoint and produces a diagnosable auth error
							// instead of silently routing to the default OpenCode Go
							// endpoint (which may serve a different model).
							baseURL = key.base_url;
							model = effectiveModelId;
							tabAgent.keyId = effectiveKeyId;
							tabAgent.modelId = effectiveModelId;
							useOverride = true;
						}
					}
				} else {
					console.warn(`dispatch: key "${effectiveKeyId}" not found in model registry`);
				}
			}

			if (!useOverride) {
				// Clear any previous override when falling back to default resolution
				tabAgent.keyId = null;
				tabAgent.modelId = null;
			}

			const customSystemPrompt = getSetting("system_prompt") || undefined;
			tabAgent.agent = new Agent(
				{
					model,
					apiKey,
					baseURL,
					systemPrompt: buildSystemPrompt(toolNames, customSystemPrompt),
					tools,
					workingDirectory,
					permissionChecker: this.permissionManager ?? undefined,
					ruleset,
					provider,
					tabId,
					...(claudeCredentials ? { claudeCredentials } : {}),
				},
				{
					dequeueMessages: () => this.dequeueMessages(tabId),
					waitForQueuedMessage: () => this.waitForQueuedMessage(tabId),
				},
			);

			// Pre-populate the Agent's in-memory message history from the DB
			// so prior turns survive Agent recreation. The Agent is
			// constructed fresh here in three scenarios that ALL discard
			// the previous in-memory `messages` array:
			//   1. First call for this tab (no prior Agent existed)
			//   2. Model/key/permission/working-directory change — the
			//      invalidation gate above set `tabAgent.agent = null`.
			//      This is the model-switcher-slider case: without this
			//      pre-population, DeepSeek would see zero context after
			//      switching from Opus mid-conversation.
			//   3. Config or skills reload (configWatcher / skillsWatcher
			//      also null out `tabAgent.agent`).
			//
			// Boundary semantics: `processMessage` calls `appendMessage`
			// for the current turn's user message BEFORE calling this
			// function, so the DB ends in `[..., u_current]`. In the
			// fallback retry path (agent-mode automatic model fallback),
			// the previous attempt may also have flushed a partial
			// assistant response, so the DB ends in
			// `[..., u_current, partial_a]`. Either way, we walk
			// backwards to the most recent user-role row and load only
			// strictly-prior rows: `agent.run()` will push the current
			// user message itself at agent.ts:546, so including it here
			// would duplicate it.
			//
			// `toModelMessages` already filters out `role === "system"`
			// rows and strips `error` / `system` chunks, so it's safe to
			// load system messages verbatim.
			try {
				const rows = getMessagesForTab(tabId);
				let cutIdx = rows.length;
				for (let i = rows.length - 1; i >= 0; i--) {
					const row = rows[i];
					if (row && row.role === "user") {
						cutIdx = i;
						break;
					}
				}
				if (cutIdx > 0) {
					tabAgent.agent.messages = rows
						.slice(0, cutIdx)
						.map((r) => ({ role: r.role, chunks: r.chunks }));
				}
			} catch {
				// DB read failed — leave `messages: []`. The agent still
				// works, just without prior history (matches pre-fix
				// behaviour, so this is no worse than what we had before).
			}
		}
		return tabAgent.agent;
	}

	getTabStatus(tabId: string): AgentStatus {
		return this.tabAgents.get(tabId)?.status ?? "idle";
	}

	/**
	 * Snapshot of every tab the manager is currently tracking. Sent on WS
	 * connect and via GET /status so a freshly-loaded frontend can
	 * reconstruct any in-flight assistant turn without missing the chunks
	 * that arrived before its WS handshake completed.
	 *
	 * For each running tab, the snapshot includes:
	 *   - status: "running"
	 *   - currentChunks: a defensive shallow copy of `tabAgent.currentChunks`
	 *     (the live chunk array the streaming loop appends to). The
	 *     consumer owns this copy and may mutate it freely.
	 *   - currentAssistantId: the DB id of the in-flight assistant message
	 *     row. The frontend aligns its local assistant message id with
	 *     this so the next `done` event lands on the right message.
	 *
	 * For idle/error tabs, only `status` is present. Tabs not in
	 * `this.tabAgents` (e.g. tabs in the DB that have never been touched
	 * since server start) are absent from the returned record — the
	 * caller infers their status from the DB row (always "idle" at rest).
	 */
	getAllStatuses(): Record<string, TabStatusSnapshot> {
		const result: Record<string, TabStatusSnapshot> = {};
		for (const [tabId, tabAgent] of this.tabAgents.entries()) {
			const snap: TabStatusSnapshot = { status: tabAgent.status };
			if (tabAgent.status === "running") {
				if (tabAgent.currentChunks) {
					// Defensive shallow copy: callers may serialize/mutate.
					snap.currentChunks = [...tabAgent.currentChunks];
				}
				if (tabAgent.currentAssistantId) {
					snap.currentAssistantId = tabAgent.currentAssistantId;
				}
			}
			result[tabId] = snap;
		}
		return result;
	}

	/** @deprecated Use getTabStatus(tabId) instead */
	getStatus(): AgentStatus {
		// Return running if any tab is running, otherwise idle
		for (const tabAgent of this.tabAgents.values()) {
			if (tabAgent.status === "running") return "running";
		}
		return "idle";
	}

	getMessageCount(): number {
		return this.messageCount;
	}

	onEvent(listener: (event: AgentEvent & { tabId: string }) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	private emit(event: AgentEvent, tabId: string): void {
		for (const listener of this.eventListeners) {
			listener({ ...event, tabId } as AgentEvent & { tabId: string });
		}
	}

	/**
	 * Persist a system chunk to a tab's message history.
	 *
	 * If an assistant turn is in flight (`currentChunks` is non-null), the
	 * chunk is appended to the in-flight assistant message's chunk list —
	 * the final `appendMessage` / `updateMessage` call at end-of-turn picks
	 * it up automatically.
	 *
	 * Otherwise we load the tab's persisted messages, run them through
	 * `applySystemEvent` (which either appends to an existing trailing
	 * `role: "system"` message or creates a new one), then persist the
	 * delta via `appendMessage` / `updateMessage`.
	 */
	private routeSystemEventToTab(tabId: string, kind: SystemChunkKind, text: string): void {
		const tabAgent = this.tabAgents.get(tabId);

		// Turn in flight → append directly to the in-flight chunk list.
		// The chunk lands on the assistant message when it's persisted at
		// turn-end (or the assistant message is updated mid-turn elsewhere).
		if (tabAgent?.currentChunks) {
			tabAgent.currentChunks.push({ type: "system", kind, text });
			if (tabAgent.currentAssistantId) {
				try {
					updateMessage(tabAgent.currentAssistantId, JSON.stringify(tabAgent.currentChunks));
				} catch {
					// Best-effort — the final persistence in processMessage will
					// flush the same chunks again.
				}
			}
			return;
		}

		// No turn in flight → route via applySystemEvent against the
		// persisted message list. Either appends to a trailing system
		// message or creates a fresh one.
		try {
			const rows = getMessagesForTab(tabId);
			const messages = rows.map((r) => ({ id: r.id, role: r.role, chunks: r.chunks }));
			const before = messages[messages.length - 1];
			const { messageId } = applySystemEvent(messages, { kind, text });
			const target = messages.find((m) => m.id === messageId);
			if (!target) return;
			if (before && before.id === messageId) {
				// Appended to existing trailing system message.
				updateMessage(messageId, JSON.stringify(target.chunks));
			} else {
				// Newly created system message.
				appendMessage(tabId, messageId, "system", JSON.stringify(target.chunks));
			}
		} catch {
			// DB not available (e.g. tab not yet created) — drop silently.
		}
	}

	stopTab(tabId: string): void {
		const tabAgent = this.tabAgents.get(tabId);
		if (tabAgent) {
			// If a turn is in flight, drop a `cancelled` system chunk into
			// the in-flight assistant message so the user sees an explicit
			// "Generation cancelled by user" marker at the cancellation point.
			if (tabAgent.currentChunks) {
				tabAgent.currentChunks.push({
					type: "system",
					kind: "cancelled",
					text: "Generation cancelled by user",
				});
				if (tabAgent.currentAssistantId) {
					try {
						updateMessage(tabAgent.currentAssistantId, JSON.stringify(tabAgent.currentChunks));
					} catch {
						// best-effort
					}
				}
			}
			tabAgent.abortController?.abort();
			tabAgent.status = "idle";
			tabAgent.agent = null;
			// Resolve any pending completion promise so retrieve doesn't hang
			tabAgent.completionResolve?.({ status: "error", error: "Agent was stopped." });
		}
	}

	deleteTab(tabId: string): void {
		this.stopTab(tabId);
		this.tabAgents.delete(tabId);
		// Drop any spilled tool-output files this tab accumulated. Best-effort —
		// errors are swallowed inside the helper. See packages/core/src/tools/truncate.ts.
		clearSpillForTab(tabId);
	}

	/**
	 * Spawn a child agent in a new tab. Returns the tab ID (agent_id).
	 * The child runs asynchronously — use getChildResult to await completion.
	 */
	async spawnChildAgent(options: {
		task: string;
		tools: string[];
		workingDirectory?: string;
		/**
		 * Optional slug of an `AgentDefinition` to apply. When set, the
		 * definition's `tools`, `models`, and `cwd` take precedence over
		 * the `tools`/`workingDirectory` passed in `options`. Tools are
		 * still intersected with `parentAllowedTools` to prevent a
		 * subagent from gaining capabilities its parent doesn't have.
		 */
		agentSlug?: string;
		parentKeyId?: string | null;
		parentModelId?: string | null;
		parentAllowedTools?: Set<string>;
		parentTabId?: string;
	}): Promise<string> {
		const tabId = crypto.randomUUID();
		const title = options.task.length > 50 ? `${options.task.slice(0, 47)}...` : options.task;

		// Validate working directory is within the parent agent's effective CWD
		const defaultWorkDir = process.env.DISPATCH_WORKING_DIR ?? process.cwd();
		let parentEffectiveDir = options.parentTabId
			? (this.tabAgents.get(options.parentTabId)?.workingDirectoryOverride ?? defaultWorkDir)
			: defaultWorkDir;

		// Expand ~ in parent dir
		if (parentEffectiveDir === "~" || parentEffectiveDir.startsWith("~/")) {
			const { homedir } = await import("node:os");
			const { join } = await import("node:path");
			parentEffectiveDir = join(homedir(), parentEffectiveDir.slice(1));
		}

		// Resolve the agent definition (if a slug was supplied) BEFORE
		// computing the effective working directory and tool whitelist.
		// The definition's cwd/tools take precedence over the caller's
		// `workingDirectory`/`tools` parameters, mirroring how a top-level
		// tab picking the same definition would behave.
		let agentDef: ReturnType<typeof loadAgent> = null;
		if (options.agentSlug) {
			agentDef = loadAgent(options.agentSlug, parentEffectiveDir);
			if (!agentDef) {
				throw new Error(
					`Agent definition not found: "${options.agentSlug}". Inspect the agents directories to see available slugs.`,
				);
			}
		}

		// Resolve and validate child working directory against parent's effective dir
		const requestedDir = agentDef?.cwd ?? options.workingDirectory;
		let resolvedWorkingDirectory = requestedDir;
		if (requestedDir) {
			const { isAbsolute, relative, resolve, join } = await import("node:path");
			// Expand ~ in child working directory
			let childDir = requestedDir;
			if (childDir === "~" || childDir.startsWith("~/")) {
				const { homedir } = await import("node:os");
				childDir = join(homedir(), childDir.slice(1));
			}
			const parentDir = resolve(parentEffectiveDir);
			const resolved = resolve(parentDir, childDir);
			const rel = relative(parentDir, resolved);
			const isOutside = rel.startsWith("..") || isAbsolute(rel);
			if (isOutside) {
				throw new Error(
					`Working directory "${requestedDir}" is outside the parent's working directory "${parentDir}".`,
				);
			}
			// Store the resolved absolute path so downstream code doesn't
			// re-resolve against the wrong base directory
			resolvedWorkingDirectory = resolved;
		}

		// Determine the child's tool whitelist. When an agent definition
		// was supplied, expand its short permission-group names
		// (read/edit/bash) into concrete tool names. Otherwise use the
		// `tools` parameter verbatim. Either way, intersect with
		// parentAllowedTools so a subagent can't gain capabilities the
		// parent doesn't have — even an agent definition can't escalate.
		const baseTools = agentDef ? expandAgentToolNames(agentDef.tools) : options.tools;
		let childTools = baseTools;
		if (options.parentAllowedTools) {
			childTools = baseTools.filter((t) => options.parentAllowedTools?.has(t));
		}

		// Create the tab agent entry with overrides
		const tabAgent = this._getOrCreateTabAgent(tabId);
		tabAgent.toolsOverride = childTools;
		tabAgent.workingDirectoryOverride = resolvedWorkingDirectory;
		tabAgent.finalOutput = "";

		if (agentDef && agentDef.models.length > 0) {
			// The agent definition specifies its own model fallback chain.
			// Clear keyId/modelId so the fallback sequence uses the
			// definition's models (matches how a top-level tab using this
			// definition would be configured).
			tabAgent.keyId = null;
			tabAgent.modelId = null;
			tabAgent.agentModels = agentDef.models;
		} else {
			// No definition (or definition has no models) → inherit from
			// the parent like before.
			tabAgent.keyId = options.parentKeyId ?? null;
			tabAgent.modelId = options.parentModelId ?? null;
			if (options.parentTabId) {
				const parentAgent = this.tabAgents.get(options.parentTabId);
				if (parentAgent?.agentModels) {
					tabAgent.agentModels = parentAgent.agentModels;
				}
			}
		}

		// Set up completion tracking
		tabAgent.completionPromise = new Promise((resolve) => {
			tabAgent.completionResolve = resolve;
		});

		// Create tab in DB
		try {
			const { createTab } = await import("@dispatch/core");
			createTab(tabId, title, {
				keyId: tabAgent.keyId,
				modelId: tabAgent.modelId,
				parentTabId: options.parentTabId,
			});
		} catch {
			// Continue even if DB fails
		}

		// Notify the frontend about the new tab
		this.emit(
			{
				type: "tab-created",
				id: tabId,
				title,
				keyId: tabAgent.keyId,
				modelId: tabAgent.modelId,
				parentTabId: options.parentTabId ?? null,
				workingDirectory: resolvedWorkingDirectory ?? null,
			},
			tabId,
		);

		// Start the child agent in the background
		this.processMessage(
			tabId,
			options.task,
			options.parentKeyId ?? undefined,
			options.parentModelId ?? undefined,
		).catch((err) => {
			const errorMsg = err instanceof Error ? err.message : String(err);
			tabAgent.completionResolve?.({ status: "error", error: errorMsg });
		});

		return tabId;
	}

	/**
	 * Wait for a child agent to finish and return its result.
	 * Blocks until the child completes or errors.
	 */
	async getChildResult(
		agentId: string,
	): Promise<{ status: "done"; result: string } | { status: "error"; error: string }> {
		const tabAgent = this.tabAgents.get(agentId);
		if (!tabAgent) {
			return { status: "error", error: `No agent found with id '${agentId}'` };
		}

		if (!tabAgent.completionPromise) {
			// Not a child agent or already completed
			if (tabAgent.status === "idle") {
				return { status: "done", result: tabAgent.finalOutput ?? "(no output)" };
			}
			return {
				status: "error",
				error: "Agent has no completion tracking. It may not have been spawned via summon.",
			};
		}

		return tabAgent.completionPromise;
	}

	async processMessage(
		tabId: string,
		message: string,
		keyId?: string,
		modelId?: string,
		reasoningEffort?: "none" | "low" | "medium" | "high" | "max",
		workingDirectory?: string,
		agentModels?: Array<{ key_id: string; model_id: string }>,
	): Promise<void> {
		const tabAgent = this._getOrCreateTabAgent(tabId);

		// Apply working directory override from frontend if provided
		if (workingDirectory !== undefined) {
			const prevDir = tabAgent.workingDirectoryOverride;
			tabAgent.workingDirectoryOverride = workingDirectory || undefined;
			// Invalidate cached agent if working directory changed
			if (prevDir !== tabAgent.workingDirectoryOverride) {
				tabAgent.agent = null;
			}
		}
		tabAgent.abortController = new AbortController();
		tabAgent.status = "running";
		this.messageCount += 1;

		// Persist user message to DB (once, before any fallback retry)
		appendMessage(
			tabId,
			crypto.randomUUID(),
			"user",
			JSON.stringify([{ type: "text", text: message }]),
		);

		// Store agent models on the tab if provided (defines fallback order)
		if (agentModels) {
			tabAgent.agentModels = agentModels;
		}

		// Build the fallback sequence: the agent's models list in order, or a single manual entry
		const fallbackSequence = this.buildFallbackSequence(tabAgent, keyId, modelId);
		const maxFallbackAttempts = fallbackSequence.length;

		let processError: string | null = null;
		let allOutput = "";
		let currentKeyId: string | undefined;
		let currentModelId: string | undefined;

		for (let fallbackIdx = 0; fallbackIdx < maxFallbackAttempts; fallbackIdx++) {
			const entry = fallbackSequence[fallbackIdx];
			if (!entry) break; // unreachable: loop bound guarantees defined, satisfies TS
			// Convert empty strings (used when caller omitted keyId/modelId in
			// manual mode) to undefined so `getOrCreateAgentForTab` falls back
			// to the tabAgent's stored defaults via the `?? tabAgent.keyId` chain.
			currentKeyId = entry.key_id || undefined;
			currentModelId = entry.model_id || undefined;
			allOutput = "";

			// Single ordered chunk list for the assistant turn — replaces the
			// previous (text + toolCalls + thinking) tri-accumulator pattern.
			// Persisted progressively (insert on first chunk, update thereafter)
			// so out-of-band routes (config-reload, cancel) see real DB rows.
			const chunks: Chunk[] = [];
			const assistantId = crypto.randomUUID();
			let assistantPersisted = false;
			tabAgent.currentChunks = chunks;
			tabAgent.currentAssistantId = assistantId;

			const flushAssistant = (): void => {
				if (chunks.length === 0) return;
				const json = JSON.stringify(chunks);
				if (!assistantPersisted) {
					appendMessage(tabId, assistantId, "assistant", json);
					assistantPersisted = true;
				} else {
					updateMessage(assistantId, json);
				}
			};

			let attemptError: string | null = null;

			try {
				const agent = await this.getOrCreateAgentForTab(tabId, currentKeyId, currentModelId);

				// Ensure tab exists in DB (frontend may have failed to create it)
				try {
					const { getDatabase } = await import("@dispatch/core");
					const db = getDatabase();
					const exists = db.query("SELECT 1 FROM tabs WHERE id = $id").get({ $id: tabId });
					if (!exists) {
						const { createTab } = await import("@dispatch/core");
						createTab(tabId, "New Tab", {
							keyId: currentKeyId ?? null,
							modelId: currentModelId ?? null,
						});
					}
				} catch {
					// Best-effort — if this fails, appendMessage will throw and we'll catch it below
				}

				for await (const event of agent.run(
					message,
					reasoningEffort ? { reasoningEffort } : undefined,
				)) {
					// Stop processing if the tab was aborted (closed/stopped).
					// stopTab() already injected a `cancelled` system chunk into
					// `chunks` before flipping the abort flag, so we just need
					// to flush and exit.
					if (tabAgent.abortController?.signal.aborted) break;

					if (event.type === "error") {
						attemptError = event.error;
						// Record the error as a chunk so it's part of the
						// persisted turn history.
						appendEventToChunks(chunks, event);
						break;
					}

					if (event.type === "status") {
						tabAgent.status = event.status;
					}
					this.emit(event, tabId);

					// For diagnostics / child agent result harvesting, keep a
					// flat string copy of plain text output.
					if (event.type === "text-delta") {
						allOutput += event.delta;
					}

					if (event.type === "done") {
						// End of turn — flush the accumulated chunks. Reset the
						// in-flight pointers so out-of-band system events route
						// through `applySystemEvent` against the persisted list
						// instead of mutating a stale array.
						flushAssistant();
						chunks.length = 0;
						assistantPersisted = true; // suppress post-loop flush
						tabAgent.currentChunks = null;
						tabAgent.currentAssistantId = null;
						continue;
					}

					// Route every content-bearing event through the shared helper.
					// `appendEventToChunks` ignores lifecycle events (status / done
					// / task-list-update / tab-created / message-* / etc), so it's
					// safe to call unconditionally.
					appendEventToChunks(chunks, event);
				}
			} catch (err) {
				console.error(`[dispatch] processMessage error for tab ${tabId}:`, err);
				attemptError = err instanceof Error ? err.message : String(err);
			}

			// Flush any accumulated assistant content from this attempt (covers
			// the abort/error/exception paths where we never saw a `done`).
			flushAssistant();
			tabAgent.currentChunks = null;
			tabAgent.currentAssistantId = null;

			// No error — success
			if (!attemptError) {
				processError = null;
				break;
			}

			// Check if error is retryable (rate limit / exhausted key)
			const isRetryable =
				attemptError.includes("status=429") ||
				attemptError.toLowerCase().includes("rate limit") ||
				attemptError.toLowerCase().includes("rate_limit") ||
				attemptError.toLowerCase().includes("usage limit") ||
				attemptError.toLowerCase().includes("exhausted");

			if (isRetryable && this.modelRegistry && tabAgent.keyId) {
				this.modelRegistry.markKeyExhausted(tabAgent.keyId, attemptError);

				// Try the next entry in the agent's fallback sequence
				const nextIdx = fallbackIdx + 1;
				const nextEntry = fallbackSequence[nextIdx];
				if (nextIdx < maxFallbackAttempts && nextEntry) {
					const fallbackMsg =
						`Key "${tabAgent.keyId}" rate limited. ` +
						`Falling back to "${nextEntry.key_id}" (model: ${nextEntry.model_id})...`;
					console.warn(`[dispatch] ${fallbackMsg}`);
					// Persist the notice + model-change as system chunks. We're
					// between turns here (just flushed the previous assistant
					// message), so the helper routes them into a `role: "system"`
					// message via `applySystemEvent`.
					this.emit({ type: "notice", message: fallbackMsg }, tabId);
					this.routeSystemEventToTab(tabId, "notice", fallbackMsg);
					this.emit(
						{ type: "model-changed", keyId: nextEntry.key_id, modelId: nextEntry.model_id },
						tabId,
					);
					this.routeSystemEventToTab(
						tabId,
						"model-changed",
						`Switched to ${nextEntry.model_id} (${nextEntry.key_id})`,
					);
					tabAgent.agent = null;
					continue;
				}
			}

			// All fallbacks exhausted or non-retryable error
			processError = attemptError;
			tabAgent.status = "error";
			this.emit({ type: "error", error: attemptError }, tabId);
			this.emit({ type: "status", status: "error" }, tabId);
			break;
		}

		// Resolve completion promise for child agents
		if (processError === null) {
			tabAgent.finalOutput = allOutput;
			tabAgent.completionResolve?.({ status: "done", result: allOutput || "(no output)" });
		} else {
			tabAgent.completionResolve?.({ status: "error", error: processError });
		}
	}

	private buildFallbackSequence(
		tabAgent: TabAgent,
		keyId?: string,
		modelId?: string,
	): Array<{ key_id: string; model_id: string }> {
		// Agent mode: use the agent's configured fallback hierarchy in strict order
		const models = tabAgent.agentModels;
		if (models && models.length > 0) {
			const startIdx = models.findIndex((m) => m.key_id === keyId && m.model_id === modelId);
			return startIdx >= 0 ? models.slice(startIdx) : models;
		}
		// Manual mode: no fallback — just the selected key/model pair.
		// Always return at least one entry so `processMessage` runs the agent
		// once (empty strings let `getOrCreateAgentForTab` fall back to the
		// tabAgent's stored defaults or environment-driven config).
		return [{ key_id: keyId ?? "", model_id: modelId ?? "" }];
	}

	queueMessage(tabId: string, message: string, clientId?: string): { messageId: string } {
		const tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) throw new Error("Tab not found");
		const id = clientId || crypto.randomUUID();
		const queued: QueuedMessage = { id, message, timestamp: Date.now() };
		tabAgent.messageQueue.push(queued);
		// Wake up any blocking tools waiting for queue
		for (const listener of tabAgent.queueListeners) {
			listener();
		}
		tabAgent.queueListeners = [];
		this.emit({ type: "message-queued", tabId, messageId: id, message }, tabId);
		return { messageId: id };
	}

	cancelQueuedMessage(tabId: string, messageId: string): boolean {
		const tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) return false;
		const idx = tabAgent.messageQueue.findIndex((m) => m.id === messageId);
		if (idx === -1) return false;
		tabAgent.messageQueue.splice(idx, 1);
		this.emit({ type: "message-cancelled", tabId, messageId }, tabId);
		return true;
	}

	dequeueMessages(tabId: string): QueuedMessage[] {
		const tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) return [];
		const messages = [...tabAgent.messageQueue];
		tabAgent.messageQueue = [];
		if (messages.length > 0) {
			this.emit({ type: "message-consumed", tabId, messageIds: messages.map((m) => m.id) }, tabId);
		}
		return messages;
	}

	waitForQueuedMessage(tabId: string): { promise: Promise<void>; cancel: () => void } {
		const tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) return { promise: Promise.resolve(), cancel: () => {} };
		if (tabAgent.messageQueue.length > 0) return { promise: Promise.resolve(), cancel: () => {} };

		let listener: (() => void) | null = null;
		const promise = new Promise<void>((resolve) => {
			listener = resolve;
			tabAgent.queueListeners.push(resolve);
		});
		const cancel = () => {
			if (listener) {
				tabAgent.queueListeners = tabAgent.queueListeners.filter((l) => l !== listener);
				listener = null;
			}
		};
		return { promise, cancel };
	}

	destroy(): void {
		this.configWatcher?.close();
		this.skillsWatcher?.close();
	}
}
