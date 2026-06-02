import {
	Agent,
	type AgentEvent,
	type AgentModelEntry,
	type AgentSkillMapping,
	type AgentStatus,
	appendChunks,
	appendEventToChunks,
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
	createReadTabTool,
	createRetrieveTool,
	createRunShellTool,
	createSearchCodeTool,
	createSendToTabTool,
	createSkillsWatcher,
	createSummonTool,
	createTaskListTool,
	createWebSearchTool,
	createWriteFileTool,
	createYoutubeTranscribeTool,
	type DispatchConfig,
	expandAgentToolNames,
	explodeTurn,
	explodeUserText,
	GLOBAL_AGENTS_DIR,
	getAgentDirPaths,
	getClaudeAccountsFromDB,
	getMessagesForTab,
	getSetting,
	getTab,
	getUsageStatsForTab,
	listOpenTabs,
	loadAgent,
	loadAgents,
	loadConfig,
	loadSkills,
	ModelRegistry,
	type QueuedMessage,
	type ReasoningEffort,
	refreshAccountCredentials,
	refreshAccountCredentialsAsync,
	resolveApiKey,
	resolveTabPrefix,
	type SkillDefinition,
	type SystemChunkKind,
	shortestUniquePrefix,
	type TabResolution,
	type TabStatusSnapshot,
	TaskList,
	toAvailableSubagents,
	toAvailableUserAgents,
	type UsageData,
	type UsageStats,
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
	search_code:
		"Search the codebase by query using the 'cs' code search engine (relevance-ranked, structure-aware). Returns the most relevant files first with matching snippets and line numbers. Better than grep/find for exploratory 'where is X / how does Y work' searches; use run_shell with rg for exhaustive exact-match lists.",
	todo: "Create/maintain a todo list to plan and track work. Declarative whole-list write: send the entire list in `todos` each call (it replaces the previous list). Statuses: pending, in_progress, completed, cancelled.",
	summon:
		"Spawn a child agent to work on a task independently. By default blocks until the child finishes. Set background=true to return immediately with an agent_id for later retrieval.",
	retrieve:
		"Wait for a background task to finish and get its result (blocking). Pass the job_id or agent_id.",
	web_search: "Search the web and optionally scrape full page content from results.",
	youtube_transcribe:
		"Fetch the transcript/subtitles for a YouTube video. Set background=true to start in the background and get a job_id for later retrieval.",
};

/**
 * Maximum number of CONSECUTIVE agent-to-agent auto-wakes a tab will accept
 * before it stops auto-responding and waits for a human. Each `send_to_tab`
 * that would wake an idle tab consumes one unit; any human-originated message
 * (e.g. via `POST /chat`) refills the budget to full. This bounds runaway
 * agent ping-pong loops (A wakes B wakes A ...) that would otherwise spend
 * tokens unbounded with no human in the loop. See notes/plan-tab-comm.md.
 */
const MAX_AGENT_AUTO_WAKES = 6;

const DEFAULT_SYSTEM_PROMPT =
	"You are Dispatch, an agent designed to help with any task that the user asks for. Be helpful and concise.";

const TASK_MANAGEMENT_GUIDANCE = `
## Task Management

You have access to the \`todo\` tool to plan and track tasks. Use it VERY frequently so the user can see your plan and progress in real time. It is also a powerful planning aid: breaking larger work into smaller steps keeps you from forgetting important tasks — that is unacceptable.

The \`todo\` tool is DECLARATIVE: every call sends the ENTIRE list in the \`todos\` parameter and replaces the previous list. There are no ids and no per-item actions — to change one item, resend the whole list with that item updated. To clear the list, send an empty array.

### When to use
- A task needs 3+ distinct steps, or benefits from planning
- The user gives multiple tasks (numbered or comma-separated) or asks for a todo list
- New instructions arrive — capture them as todos
- You start a task — mark it in_progress (only one at a time) before working
- You finish a task — mark it completed and add any follow-ups discovered

### When NOT to use
- A single, straightforward task (or fewer than 3 trivial steps)
- Purely informational or conversational requests
- When tracking adds no organizational value

### States
- pending — not started
- in_progress — actively working (exactly ONE at a time)
- completed — finished successfully
- cancelled — no longer needed

### Rules
- Send the full desired list every time; the tool replaces the stored list
- Update status in real time; do NOT batch completions
- Mark completed only after the work is actually done (including any required verification), never on intent
- Keep exactly one in_progress while work remains; if blocked, keep it in_progress and add a follow-up todo describing the blocker

### Examples

User: "Run the build and fix any type errors"
Write the list, then work it: send [{content:"Run the build", status:"in_progress"}, {content:"Fix any type errors", status:"pending"}]. Run the build. If it surfaces 10 errors, resend the whole list — the build item completed, plus one item per error — then drive each to completed one at a time.

User: "How do I print Hello World in Python?"
No todo needed — this is a single informational question.

User: "Rename getUser to fetchUser across the project"
Send [{content:"Search for all occurrences of getUser", status:"in_progress"}, ...]. After the grep reveals the files, resend the whole list with one item per file, then work through them, resending the list as each flips to completed.
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
	const hasSummon = toolNames.includes("summon");
	let prompt = `${base}\n\nYou have access to the following tools:\n\n${toolList}\n\nWhen asked to work with files, use these tools. Always confirm what you did after completing an action.`;
	if (hasTodo) {
		prompt += `\n\n${TASK_MANAGEMENT_GUIDANCE}`;
	}
	if (hasSummon) {
		prompt +=
			'\n\nYou have pre-configured subagent types. Use summon(agent="slug", task="...") to delegate specialized work to a subagent. Use list_files and read_file to inspect available agent definitions.';
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
	agentModels?: AgentModelEntry[];
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
	 * In-flight assistant chunks for the active turn. `null` when no turn is
	 * running. Out-of-band system events (config-reload, cancel, etc.) push
	 * onto this list when present; it is exploded into chunk rows when the
	 * turn flushes.
	 */
	currentChunks: Chunk[] | null;
	/**
	 * Opaque id of the in-flight assistant turn, used as the `currentAssistantId`
	 * in the WS status snapshot so a reconnecting frontend can align its local
	 * streaming message. (No longer a DB row id — the turn is many chunk rows.)
	 */
	currentAssistantId: string | null;
	/**
	 * `turn_id` shared by the current turn's user message and assistant chunk
	 * rows. Set at the start of `processMessage`, cleared when the turn ends.
	 */
	currentTurnId: string | null;
	/**
	 * Remaining consecutive agent-to-agent auto-wakes this tab will accept
	 * before requiring human intervention (see `MAX_AGENT_AUTO_WAKES`).
	 * Refilled to the max by any human-originated `deliverMessage`; decremented
	 * each time an agent-originated `send_to_tab` wakes this tab from idle. When
	 * it hits 0, further agent messages are queued but do NOT start a turn.
	 */
	autoWakeBudget: number;
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
			// Re-discover Claude accounts: a config reload may accompany freshly
			// imported credentials, and (critically) lets a process that failed
			// account discovery at boot recover without a full restart.
			this._refreshClaudeAccounts();
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
				currentTurnId: null,
				autoWakeBudget: MAX_AGENT_AUTO_WAKES,
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
		const permUserAgent = getSetting("perm_user_agent") === "allow";
		const permSendToTab = getSetting("perm_send_to_tab") === "allow";
		const permReadTab = getSetting("perm_read_tab") === "allow";
		const permWebSearch = getSetting("perm_web_search") === "allow";
		const permSearchCode = getSetting("perm_search_code") === "allow";
		const permYoutubeTranscribe = getSetting("perm_youtube_transcribe") === "allow";
		const sysPrompt = getSetting("system_prompt") ?? "";
		const permKey = `${permRead}:${permEdit}:${permBash}:${permSummon}:${permUserAgent}:${permSendToTab}:${permReadTab}:${permWebSearch}:${permYoutubeTranscribe}:${permSearchCode}:${sysPrompt}`;

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
				if (allowed.has("search_code")) {
					toolEntries.push({
						name: "search_code",
						tool: createSearchCodeTool(workingDirectory),
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
					const allAgentDefs = loadAgents(workingDirectory);
					const availableSubagents = toAvailableSubagents(
						allAgentDefs,
						GLOBAL_AGENTS_DIR,
						workingDirectory,
					);
					const availableUserAgents = toAvailableUserAgents(
						allAgentDefs,
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
							availableSubagents,
							availableUserAgents,
							agentDirPaths,
							permUserAgent,
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
				// Tab-to-tab communication — gated on the child whitelist.
				if (allowed.has("send_to_tab") || allowed.has("read_tab")) {
					for (const entry of this.buildTabCommToolEntries(tabId)) {
						if (allowed.has(entry.name)) toolEntries.push(entry);
					}
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
				if (permSearchCode) {
					toolEntries.push({
						name: "search_code",
						tool: createSearchCodeTool(workingDirectory),
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
					const allAgentDefs = loadAgents(workingDirectory);
					const availableSubagents = toAvailableSubagents(
						allAgentDefs,
						GLOBAL_AGENTS_DIR,
						workingDirectory,
					);
					const availableUserAgents = toAvailableUserAgents(
						allAgentDefs,
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
							availableSubagents,
							availableUserAgents,
							agentDirPaths,
							permUserAgent,
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
				if (permSendToTab || permReadTab) {
					const tabCommAllowed = new Set<string>();
					if (permSendToTab) tabCommAllowed.add("send_to_tab");
					if (permReadTab) tabCommAllowed.add("read_tab");
					for (const entry of this.buildTabCommToolEntries(tabId)) {
						if (tabCommAllowed.has(entry.name)) toolEntries.push(entry);
					}
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
						const findAccount = () =>
							this.claudeAccounts.find((a) => a.id === effectiveKeyId) ??
							(credFile
								? this.claudeAccounts.find((a) => a.source === credFile)
								: this.claudeAccounts[0]);
						let account = findAccount();
						// Self-heal: account discovery runs once at construction and can
						// fail at boot (e.g. the data dir isn't mounted yet and
						// getDatabase() throws EACCES), leaving claudeAccounts empty for
						// the process lifetime. If the lookup fails, re-run discovery now
						// that the DB is reachable and retry before giving up.
						if (!account) {
							this._refreshClaudeAccounts();
							account = findAccount();
						}
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
			// Boundary semantics: `processMessage` appends the current turn's
			// user message (as a chunk row) BEFORE calling this function, so the
			// grouped history ends in `[..., u_current]`. In the fallback retry
			// path the previous attempt may also have flushed a partial assistant
			// turn, so it can end `[..., u_current, partial_a]`. Either way, we
			// walk backwards to the most recent user-role message and load only
			// strictly-prior messages: `agent.run()` pushes the current user
			// message itself, so including it here would duplicate it.
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
	 * Every tab additionally carries its `tasks` (the current todo list) when
	 * non-empty, so a reloaded frontend rehydrates the Tasks panel from the
	 * backend rather than blanking it.
	 *
	 * For idle/error tabs, only `status` (plus any `tasks`) is present. Tabs not in
	 * `this.tabAgents` (e.g. tabs in the DB that have never been touched
	 * since server start) are absent from the returned record — the
	 * caller infers their status from the DB row (always "idle" at rest).
	 */
	getAllStatuses(): Record<string, TabStatusSnapshot> {
		const result: Record<string, TabStatusSnapshot> = {};
		for (const [tabId, tabAgent] of this.tabAgents.entries()) {
			const snap: TabStatusSnapshot = { status: tabAgent.status };
			// Include the tab's todo list (for ALL tabs, not just running ones)
			// so a reloaded frontend rehydrates the Tasks panel from the backend
			// instead of blanking it. Omit when empty to keep the payload lean.
			const tasks = tabAgent.taskList.getTasks();
			if (tasks.length > 0) {
				snap.tasks = tasks;
			}
			if (tabAgent.status === "running") {
				if (tabAgent.currentChunks) {
					// Defensive shallow copy: callers may serialize/mutate.
					snap.currentChunks = [...tabAgent.currentChunks];
				}
				if (tabAgent.currentAssistantId) {
					snap.currentAssistantId = tabAgent.currentAssistantId;
				}
				if (tabAgent.currentTurnId) {
					snap.currentTurnId = tabAgent.currentTurnId;
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
	 * Persist a system chunk (notice / model-changed / config-reload /
	 * cancelled) to a tab's history.
	 *
	 * If an assistant turn is in flight (`currentChunks` is non-null), the
	 * chunk is folded into the in-flight chunk list; it is exploded into a
	 * `system` chunk row when the turn flushes.
	 *
	 * Otherwise we append a standalone `system` chunk row immediately. Adjacent
	 * system rows are coalesced back into one system message at group time
	 * (`groupRowsToMessages`).
	 */
	private routeSystemEventToTab(tabId: string, kind: SystemChunkKind, text: string): void {
		const tabAgent = this.tabAgents.get(tabId);

		// Turn in flight → fold into the in-flight chunk list; it is exploded
		// into chunk rows (including this system chunk) when the turn flushes.
		if (tabAgent?.currentChunks) {
			tabAgent.currentChunks.push({ type: "system", kind, text });
			return;
		}

		// No turn in flight → persist a standalone system chunk row immediately.
		try {
			const turnId = tabAgent?.currentTurnId ?? crypto.randomUUID();
			appendChunks(tabId, explodeTurn(turnId, [{ type: "system", kind, text }]));
		} catch {
			// DB not available (e.g. tab not yet created) — drop silently.
		}
	}

	stopTab(tabId: string): void {
		const tabAgent = this.tabAgents.get(tabId);
		if (tabAgent) {
			// If a turn is in flight, drop a `cancelled` system chunk into the
			// in-flight chunk list so the user sees an explicit "Generation
			// cancelled by user" marker at the cancellation point. It is
			// persisted (as a chunk row) when `processMessage` flushes the
			// aborted turn.
			if (tabAgent.currentChunks) {
				tabAgent.currentChunks.push({
					type: "system",
					kind: "cancelled",
					text: "Generation cancelled by user",
				});
			}
			tabAgent.abortController?.abort();
			tabAgent.status = "idle";
			this.emit({ type: "status", status: "idle" }, tabId);
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
		/**
		 * When true, spawn as an independent top-level "user agent" tab
		 * instead of a subagent child tab. User agents have no parent,
		 * are persistent, and cannot be retrieved (fire-and-forget).
		 */
		topLevel?: boolean;
	}): Promise<string> {
		const tabId = crypto.randomUUID();
		const title = options.task.length > 50 ? `${options.task.slice(0, 47)}...` : options.task;

		// Validate working directory is within the parent agent's effective CWD
		const defaultWorkDir = process.env.DISPATCH_WORKING_DIR ?? process.cwd();
		let parentEffectiveDir = options.topLevel
			? defaultWorkDir
			: options.parentTabId
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
				const allDefs = loadAgents(parentEffectiveDir);
				if (options.topLevel) {
					const userAgents = allDefs
						.filter((d) => !d.is_subagent)
						.map((d) => `${d.slug} (${d.name})`);
					const hint =
						userAgents.length > 0
							? ` Available user agents: ${userAgents.join(", ")}.`
							: " No user agent definitions exist yet.";
					throw new Error(`Agent definition not found: "${options.agentSlug}".${hint}`);
				} else {
					const subagents = allDefs
						.filter((d) => d.is_subagent)
						.map((d) => `${d.slug} (${d.name})`);
					const hint =
						subagents.length > 0
							? ` Available subagents: ${subagents.join(", ")}.`
							: " No subagent definitions exist yet.";
					throw new Error(`Agent definition not found: "${options.agentSlug}".${hint}`);
				}
			}

			// Validate that the definition type matches the spawn mode:
			// subagent slugs can't be used with top_level=true, and
			// user-agent slugs can't be used without top_level=true.
			if (options.topLevel && agentDef.is_subagent) {
				throw new Error(
					`Cannot spawn user agent: "${options.agentSlug}" is a subagent definition. Use a non-subagent definition for top_level=true.`,
				);
			}
			if (!options.topLevel && !agentDef.is_subagent) {
				throw new Error(
					`Cannot spawn subagent: "${options.agentSlug}" is a user agent definition. Set top_level=true to spawn it as an independent tab, or use a subagent definition.`,
				);
			}
		}

		// Resolve child working directory.
		// Subagents are validated to stay within the parent's effective dir.
		// User agents (topLevel) are free to use any directory.
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
			if (options.topLevel) {
				// User agents: resolve freely, no containment check
				resolvedWorkingDirectory = resolve(defaultWorkDir, childDir);
			} else {
				// Subagents: validate within parent's directory
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

		const primary = agentDef?.models[0];
		if (agentDef && primary) {
			// The agent definition specifies its own model fallback chain.
			// Set keyId/modelId to the primary (first) model in the chain so
			// the frontend can display the concrete key/model this subagent
			// was configured with, while `agentModels` drives the fallback
			// sequence (matches how a top-level tab using this definition
			// would be configured).
			tabAgent.keyId = primary.key_id;
			tabAgent.modelId = primary.model_id;
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

		// Set up completion tracking — user agents are fire-and-forget,
		// so only subagents get completion promises.
		if (!options.topLevel) {
			tabAgent.completionPromise = new Promise((resolve) => {
				tabAgent.completionResolve = resolve;
			});
		}

		// Create tab in DB
		try {
			const { createTab } = await import("@dispatch/core");
			createTab(tabId, title, {
				keyId: tabAgent.keyId,
				modelId: tabAgent.modelId,
				parentTabId: options.topLevel ? undefined : options.parentTabId,
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
				parentTabId: options.topLevel ? null : (options.parentTabId ?? null),
				agentSlug: options.agentSlug ?? null,
				workingDirectory: resolvedWorkingDirectory ?? null,
				agentModels: tabAgent.agentModels ?? null,
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
			if (tabAgent.status === "running") {
				return {
					status: "error",
					error:
						"This is a user agent (top-level tab) and cannot be retrieved. User agents are fire-and-forget.",
				};
			}
			return {
				status: "error",
				error: "Agent has no completion tracking. It may not have been spawned via summon.",
			};
		}

		return tabAgent.completionPromise;
	}

	// ─── Tab-to-tab communication ───────────────────────────────────
	//
	// `send_to_tab` / `read_tab` let an agent message a peer tab by its short
	// handle (a git-style prefix of the tab UUID). Delivery reuses the exact
	// running→queue / idle→new-turn routing that `POST /chat` uses (see
	// `deliverMessage`), so an agent message behaves identically to a user one.

	/**
	 * Build the `send_to_tab` + `read_tab` tool entries for `tabId`. Shared by
	 * both tool-construction paths (child whitelist + permission-gated parent).
	 * `selfHandle` is computed once so the calling tab can stamp provenance and
	 * reject self-sends.
	 */
	private buildTabCommToolEntries(
		tabId: string,
	): Array<{ name: string; tool: ReturnType<typeof createSendToTabTool> }> {
		const selfHandle = shortestUniquePrefix(tabId);
		return [
			{
				name: "send_to_tab",
				tool: createSendToTabTool({
					resolveShortId: (prefix) => this.resolveTabHandle(prefix),
					// origin: "agent" subjects this to the receiver's auto-wake
					// budget so agent↔agent loops are bounded (see deliverMessage).
					deliver: (targetId, message) =>
						this.deliverMessage(targetId, message, { origin: "agent" }),
					listOpenHandles: () => this.listOpenHandles(tabId),
					self: { id: tabId, handle: selfHandle },
				}),
			},
			{
				name: "read_tab",
				tool: createReadTabTool({
					resolveShortId: (prefix) => this.resolveTabHandle(prefix),
					getLastResponse: (targetId) => this.getLastTabResponse(targetId),
					listOpenHandles: () => this.listOpenHandles(tabId),
				}),
			},
		];
	}

	/**
	 * Project a core `ResolveTabPrefixResult` down to the tool-facing
	 * `TabResolution` (minimal `{ id, title, handle }` refs). Each match's
	 * `handle` is recomputed via `shortestUniquePrefix` so the value the tool
	 * echoes back always matches what the UI currently shows.
	 */
	private resolveTabHandle(prefix: string): TabResolution {
		const res = resolveTabPrefix(prefix);
		if (res.status === "none") return { status: "none" };
		if (res.status === "ok") {
			return {
				status: "ok",
				tab: {
					id: res.tab.id,
					title: res.tab.title,
					handle: shortestUniquePrefix(res.tab.id),
				},
			};
		}
		return {
			status: "ambiguous",
			matches: res.matches.map((t) => ({
				id: t.id,
				title: t.title,
				handle: shortestUniquePrefix(t.id),
			})),
		};
	}

	/** Snapshot of open tabs as `{ handle, title }`, excluding `exceptId`
	 *  (typically the caller's own tab). Drives the "available tabs" hints. */
	private listOpenHandles(exceptId?: string): Array<{ handle: string; title: string }> {
		return listOpenTabs()
			.filter((t) => t.id !== exceptId)
			.map((t) => ({ handle: shortestUniquePrefix(t.id), title: t.title }));
	}

	/**
	 * Return a tab's most recent COMPLETED assistant turn as flat text, plus
	 * its current status. Reads the persisted chunk log (source of truth) and
	 * grabs the last `role === "assistant"` group's text chunks. `text` is null
	 * when no completed assistant turn exists yet.
	 */
	getLastTabResponse(tabId: string): { text: string | null; status: AgentStatus } {
		const status = this.getTabStatus(tabId);
		try {
			const messages = getMessagesForTab(tabId);
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (!msg || msg.role !== "assistant") continue;
				const text = msg.chunks
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
				if (text.length > 0) return { text, status };
			}
		} catch {
			// DB unavailable / tab unknown — fall through to null.
		}
		return { text: null, status };
	}

	/**
	 * Deliver `message` to `tabId`, choosing the SAME routing as `POST /chat`:
	 *   - target running → queue it (consumed like a user interrupt).
	 *   - target idle/errored → wake it and start a new turn.
	 *
	 * Returns quickly; does NOT block on the turn. Both the HTTP `/chat` path
	 * and the `send_to_tab` tool call through here so the running/idle decision
	 * lives in exactly one place.
	 *
	 * `opts` carries the per-request knobs `/chat` forwards (key/model, agent
	 * fallback chain, reasoning effort, working dir, an explicit queue id). The
	 * `send_to_tab` tool passes none of these — for a cold wake (a tab not in
	 * `tabAgents`, e.g. after a server restart) the key/model are hydrated from
	 * the live `TabAgent` if present, else from the persisted tab row. (A cold
	 * tab keeps its stored key/model but not its full agent-definition fallback
	 * chain — see plan notes.)
	 */
	deliverMessage(
		tabId: string,
		message: string,
		opts: {
			keyId?: string;
			modelId?: string;
			agentModels?: AgentModelEntry[];
			reasoningEffort?: ReasoningEffort;
			workingDirectory?: string;
			queueId?: string;
			/**
			 * Who is sending this message. `"human"` (default) is unrestricted
			 * and REFILLS the target's agent-to-agent auto-wake budget. `"agent"`
			 * (from the `send_to_tab` tool) is governed by that budget: an
			 * agent-originated wake of an idle tab consumes one unit, and once the
			 * budget is exhausted the message is queued WITHOUT starting a turn
			 * (returned as `suppressed`) so a runaway A↔B loop can't spend tokens
			 * forever with no human in the loop.
			 */
			origin?: "human" | "agent";
		} = {},
	): { status: "queued"; messageId: string } | { status: "started" } | { status: "suppressed" } {
		const origin = opts.origin ?? "human";

		// A human touching the tab clears any accumulated agent-wake throttle:
		// the conversation is back under human supervision, so peers get a fresh
		// budget of auto-wakes again.
		if (origin === "human") {
			this._getOrCreateTabAgent(tabId).autoWakeBudget = MAX_AGENT_AUTO_WAKES;
		}

		if (this.getTabStatus(tabId) === "running") {
			// Busy target → always queue (consumed like a user interrupt),
			// regardless of origin. Queuing does not itself start a turn, so it
			// can't drive a runaway loop; we don't spend budget here.
			const { messageId } = this.queueMessage(tabId, message, opts.queueId);
			return { status: "queued", messageId };
		}

		// Idle/errored target → this delivery would WAKE the tab (start a turn).
		// For agent-originated wakes, enforce the auto-wake budget first.
		if (origin === "agent") {
			const target = this._getOrCreateTabAgent(tabId);
			if (target.autoWakeBudget <= 0) {
				// Budget exhausted: preserve the message (queue it, never drop)
				// but do NOT wake the tab. A human message will refill the budget
				// and the queued message will be seen on the next human turn.
				this.queueMessage(tabId, message, opts.queueId);
				const notice =
					`Automatic agent-to-agent message limit reached for this tab ` +
					`(${MAX_AGENT_AUTO_WAKES} consecutive). Further messages from other tabs ` +
					`are held until you send a message here.`;
				this.emit({ type: "notice", message: notice }, tabId);
				this.routeSystemEventToTab(tabId, "notice", notice);
				return { status: "suppressed" };
			}
			target.autoWakeBudget -= 1;
		}

		// Resolve key/model: explicit opts win, then the live tab agent's, then
		// the persisted row's.
		const tabAgent = this.tabAgents.get(tabId);
		let keyId = opts.keyId ?? tabAgent?.keyId ?? undefined;
		let modelId = opts.modelId ?? tabAgent?.modelId ?? undefined;
		const agentModels = opts.agentModels ?? tabAgent?.agentModels;
		if (!keyId || !modelId) {
			const row = getTab(tabId);
			if (row) {
				keyId = keyId ?? row.keyId ?? undefined;
				modelId = modelId ?? row.modelId ?? undefined;
			}
		}

		this.processMessage(
			tabId,
			message,
			keyId,
			modelId,
			opts.reasoningEffort,
			opts.workingDirectory,
			agentModels,
		).catch((err) => {
			console.error(`[dispatch] deliverMessage processMessage error for tab ${tabId}:`, err);
		});
		return { status: "started" };
	}

	async processMessage(
		tabId: string,
		message: string,
		keyId?: string,
		modelId?: string,
		reasoningEffort?: ReasoningEffort,
		workingDirectory?: string,
		agentModels?: AgentModelEntry[],
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

		// Persist the user message as a chunk row (once, before any fallback
		// retry). The whole turn — this user message plus the assistant's
		// chunk rows — shares one `turn_id`.
		const turnId = crypto.randomUUID();
		tabAgent.currentTurnId = turnId;
		// Announce the turn so the frontend can tag its live chunks with this
		// turn_id (stable render keys → flicker-free reconcile when the turn
		// seals). Emitted before any content delta.
		this.emit({ type: "turn-start", turnId }, tabId);
		appendChunks(tabId, explodeUserText(turnId, message));

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
			// Effort precedence: per-model (agent definition) → per-tab selector
			// (the `reasoningEffort` arg) → the Agent's own DEFAULT_REASONING_EFFORT
			// floor (applied inside `agent.run`).
			const effortForEntry = entry.effort ?? reasoningEffort;
			allOutput = "";

			// Single ordered chunk list accumulating this attempt's assistant
			// turn (text / thinking / tool-batch / error / system), folded from
			// the stream via the shared `appendEventToChunks` helper.
			const chunks: Chunk[] = [];
			// Per-attempt usage accumulator. Reset each fallback attempt so a
			// superseded (rate-limited) attempt's usage is discarded alongside its
			// `chunks`. One `usage` event → one UsageData row.
			const usageRows: UsageData[] = [];
			const assistantId = crypto.randomUUID();
			let assistantPersisted = false;
			tabAgent.currentChunks = chunks;
			tabAgent.currentAssistantId = assistantId;

			// Write-on-seal: explode the accumulated turn into flat chunk rows
			// ONCE, when the turn settles. `explodeTurn` splits each step's
			// `tool-batch` into separate `tool_call` + `tool_result` rows and
			// tags every row with `turn_id` + derived `step`.
			const flushAssistant = (): void => {
				if (assistantPersisted) return;
				// Append usage as extra drafts in the SAME appendChunks call as the
				// turn's content rows: one atomic write, one fsync, contiguous seqs.
				// Usage rows are an invisible side channel (excluded from
				// getChunksForTab); `step` is cosmetic for usage (never grouped).
				const drafts = explodeTurn(turnId, chunks);
				for (const u of usageRows) {
					drafts.push({ turnId, step: 0, role: "assistant", type: "usage", data: u });
				}
				if (drafts.length === 0) return;
				appendChunks(tabId, drafts);
				assistantPersisted = true;
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
					// Best-effort — if this fails, chunk persistence will throw and we'll catch it below
				}

				for await (const event of agent.run(message, {
					...(effortForEntry ? { reasoningEffort: effortForEntry } : {}),
					abortSignal: tabAgent.abortController?.signal,
				})) {
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

					// Capture per-step usage as a side-channel row to persist with the
					// turn (one row per `usage` event). The live `this.emit(event)`
					// above still drives in-session accumulation; this is the reload-
					// persistence path. `appendEventToChunks` intentionally ignores
					// `usage`, so it never becomes message content.
					if (event.type === "usage") {
						usageRows.push({ ...event.usage });
					}

					// Route every content-bearing event through the shared helper.
					// `appendEventToChunks` ignores lifecycle events (status / done
					// / task-list-update / tab-created / message-* / etc), so it's
					// safe to call unconditionally. Persistence happens once, after
					// the loop, so we never write a partial turn that a fallback
					// retry would then duplicate.
					appendEventToChunks(chunks, event);
				}
			} catch (err) {
				console.error(`[dispatch] processMessage error for tab ${tabId}:`, err);
				attemptError = err instanceof Error ? err.message : String(err);
			}

			// Decide whether a fallback retry will supersede this attempt.
			const isRetryable =
				attemptError !== null &&
				(attemptError.includes("status=429") ||
					attemptError.toLowerCase().includes("rate limit") ||
					attemptError.toLowerCase().includes("rate_limit") ||
					attemptError.toLowerCase().includes("usage limit") ||
					attemptError.toLowerCase().includes("exhausted"));
			const nextEntry = fallbackSequence[fallbackIdx + 1];
			const willRetry = Boolean(isRetryable && this.modelRegistry && tabAgent.keyId && nextEntry);

			// Persist this attempt's turn — unless a retry will replace it, in
			// which case the partial (and its error chunk) is discarded so the
			// next attempt's chunks don't merge with a failed one. On success,
			// abort, or a final error, the turn is flushed exactly once.
			if (!willRetry) {
				flushAssistant();
			}
			tabAgent.currentChunks = null;
			tabAgent.currentAssistantId = null;

			// No error — success
			if (!attemptError) {
				processError = null;
				break;
			}

			if (willRetry && nextEntry && tabAgent.keyId) {
				this.modelRegistry?.markKeyExhausted(tabAgent.keyId, attemptError);
				const fallbackMsg =
					`Key "${tabAgent.keyId}" rate limited. ` +
					`Falling back to "${nextEntry.key_id}" (model: ${nextEntry.model_id})...`;
				console.warn(`[dispatch] ${fallbackMsg}`);
				// Persist the notice + model-change as standalone system chunk
				// rows (no turn in flight now — currentChunks was just cleared).
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

			// All fallbacks exhausted or non-retryable error
			processError = attemptError;
			tabAgent.status = "error";
			this.emit({ type: "error", error: attemptError }, tabId);
			this.emit({ type: "status", status: "error" }, tabId);
			break;
		}
		// Turn fully settled and its chunks are now persisted (flushAssistant ran
		// above). Signal the frontend that the turn's rows — with real seqs — are
		// durable so it can fold its live representation into the sealed log.
		// Emitted AFTER status:idle/error (which fire before the DB write).
		// Carry the authoritative usage aggregate (read AFTER the usage rows were
		// persisted) so the frontend reconciles its live cacheStats to the DB truth
		// — self-healing the live overshoot from a discarded rate-limited attempt.
		let usageStats: UsageStats | null = null;
		try {
			usageStats = getUsageStatsForTab(tabId);
		} catch {
			// DB read failed — omit reconciliation rather than crash the turn.
		}
		this.emit({ type: "turn-sealed", turnId, usageStats }, tabId);

		// Turn fully settled — clear the shared turn id.
		tabAgent.currentTurnId = null;

		// Resolve completion promise for child agents
		if (processError === null) {
			tabAgent.finalOutput = allOutput;
			tabAgent.completionResolve?.({ status: "done", result: allOutput || "(no output)" });
		} else {
			tabAgent.completionResolve?.({ status: "error", error: processError });
		}

		// The turn has fully settled. If messages piled up on the queue during it
		// and were NOT injected as a mid-turn interrupt (they arrived after the
		// last tool call, or this turn had no tool calls), kick off a fresh turn
		// to answer them instead of letting them sit unanswered — the queue is
		// consumed, not just appended. Only on a clean finish: a turn the user
		// explicitly stopped, or one that errored out, leaves its queue intact
		// for the next deliberate send (see continueFromQueue).
		if (processError === null) {
			this.continueFromQueue(tabId);
		}
	}

	/**
	 * Start a new turn for any messages that accumulated on `tabId`'s queue
	 * during the turn that just finished. This is what makes a queued message
	 * (from a user OR another agent via send_to_tab) actually get a response
	 * after the agent's current turn ends, rather than waiting forever.
	 *
	 * Loop safety: a queued-then-continued turn draws from the SAME
	 * `autoWakeBudget` that bounds agent-to-agent wakes. Every human-originated
	 * message refills that budget when it is delivered (see deliverMessage), so
	 * human conversations are never throttled; only a runaway agent<->agent
	 * chain (A queues B, B queues A, ...) is capped. When the budget is spent
	 * the messages stay queued and a notice is emitted; the next human message
	 * refills the budget and starts their turn.
	 */
	private continueFromQueue(tabId: string): void {
		const tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) return;
		if (tabAgent.messageQueue.length === 0) return;
		// Never auto-continue a turn the user stopped or one that errored.
		if (tabAgent.status === "error") return;
		if (tabAgent.abortController?.signal.aborted) return;

		if (tabAgent.autoWakeBudget <= 0) {
			// Budget spent — hold the queued messages (don't drop them) until a
			// human message refills the budget. Prevents unbounded agent loops.
			const notice =
				`Automatic continuation limit reached for this tab ` +
				`(${MAX_AGENT_AUTO_WAKES} consecutive turns). Queued messages are held ` +
				`until you send a message here.`;
			this.emit({ type: "notice", message: notice }, tabId);
			this.routeSystemEventToTab(tabId, "notice", notice);
			return;
		}
		tabAgent.autoWakeBudget -= 1;

		// Drain the queue as a "continuation" so the frontend folds the pending
		// queued bubbles into this NEW turn's initiating user row (rather than
		// into a running turn's tool result, which is the "interrupt" case).
		const drained = this.dequeueMessages(tabId, "continuation");
		if (drained.length === 0) return;
		const message = drained.map((m) => m.message).join("\n---\n");

		// Reuse the tab's resolved key/model/fallback chain — the continuation is
		// the same conversation, just a new turn. Fire-and-forget: if more
		// messages arrive during it, its own tail will continue the chain.
		this.processMessage(
			tabId,
			message,
			tabAgent.keyId ?? undefined,
			tabAgent.modelId ?? undefined,
			undefined,
			undefined,
			tabAgent.agentModels,
		).catch((err) => {
			console.error(`[dispatch] continueFromQueue processMessage error for tab ${tabId}:`, err);
		});
	}

	private buildFallbackSequence(
		tabAgent: TabAgent,
		keyId?: string,
		modelId?: string,
	): AgentModelEntry[] {
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

	dequeueMessages(
		tabId: string,
		reason: "interrupt" | "continuation" = "interrupt",
	): QueuedMessage[] {
		const tabAgent = this.tabAgents.get(tabId);
		if (!tabAgent) return [];
		const messages = [...tabAgent.messageQueue];
		tabAgent.messageQueue = [];
		if (messages.length > 0) {
			this.emit(
				{ type: "message-consumed", tabId, messageIds: messages.map((m) => m.id), reason },
				tabId,
			);
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
