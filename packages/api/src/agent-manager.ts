import {
	Agent,
	type AgentEvent,
	type AgentStatus,
	type DispatchConfig,
	type AgentSkillMapping,
	type SkillDefinition,
	createListFilesTool,
	createReadFileTool,
	createRunShellTool,
	createWriteFileTool,
	loadConfig,
	configToRuleset,
	validateConfig,
	createConfigWatcher,
	loadSkills,
	createSkillsWatcher,
	ModelRegistry,
	TaskList,
	createTaskListTool,
	type ClaudeAccount,
	appendMessage,
	getClaudeAccountsFromDB,
	refreshAccountCredentials,
	refreshAccountCredentialsAsync,
	resolveApiKey,
	getSetting,
} from "@dispatch/core";
import type { PermissionManager } from "./permission-manager.js";
import { setConfigGetter } from "./routes/config.js";
import { setSkillsGetter } from "./routes/skills.js";
import { setModelsGetter, setAccountsGetter } from "./routes/models.js";
import { setTabsAgentManager } from "./routes/tabs.js";

const TOOL_DESCRIPTIONS: Record<string, string> = {
	read_file: "Read the contents of a file",
	list_files: "List files and directories",
	write_file: "Write content to a file (creates parent directories if needed)",
	run_shell: "Execute shell commands in the working directory (bash). Returns stdout, stderr, and exit code. Use for running tests, builds, git operations, package management, and other development tasks. Do NOT run destructive or irreversible commands unless the user explicitly requests them.",
	task_list: "Manage a task list for tracking work items.",
};

const DEFAULT_SYSTEM_PROMPT = "You are Dispatch, a helpful AI coding assistant. Be concise and helpful.";

function buildSystemPrompt(toolNames: string[], basePrompt?: string): string {
	const base = basePrompt || DEFAULT_SYSTEM_PROMPT;
	const toolList = toolNames
		.filter((name) => TOOL_DESCRIPTIONS[name])
		.map((name) => `- ${name}: ${TOOL_DESCRIPTIONS[name]}`)
		.join("\n");

	if (!toolList) return base;
	return `${base}\n\nYou have access to the following tools:\n\n${toolList}\n\nWhen asked to work with files, use these tools. Always confirm what you did after completing an action.`;
}

interface TabAgent {
	agent: Agent | null;
	status: AgentStatus;
	keyId: string | null;
	modelId: string | null;
	taskList: TaskList;
	_lastPermKey?: string;
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
		setModelsGetter(
			() => this.modelRegistry,
		);
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
			// Emit config-reload to all tabs
			for (const tabId of this.tabAgents.keys()) {
				this.emit({ type: "config-reload" }, tabId);
			}
		});

		this.skillsWatcher = createSkillsWatcher(workingDirectory, (result) => {
			this.skillsData = result;
			// Invalidate cached agents so next message uses updated skills
			for (const tabAgent of this.tabAgents.values()) {
				tabAgent.agent = null;
			}
			// Emit config-reload to all tabs
			for (const tabId of this.tabAgents.keys()) {
				this.emit({ type: "config-reload" }, tabId);
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
			console.warn(`dispatch: failed to discover Claude accounts: ${err instanceof Error ? err.message : String(err)}`);
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
			};
			this.tabAgents.set(tabId, tabAgent);
		}
		return tabAgent;
	}

	private async getOrCreateAgentForTab(tabId: string, keyId?: string, modelId?: string): Promise<Agent> {
		const tabAgent = this._getOrCreateTabAgent(tabId);

		// Determine effective override: use provided values, or fall back to stored per-tab values
		const effectiveKeyId = keyId ?? tabAgent.keyId;
		const effectiveModelId = modelId ?? tabAgent.modelId;

		// Read tool permission settings from DB (default: read=allow, edit=ask, bash=ask)
		const permRead = getSetting("perm_read") !== "ask";
		const permEdit = getSetting("perm_edit") === "allow";
		const permBash = getSetting("perm_bash") === "allow";
		const sysPrompt = getSetting("system_prompt") ?? "";
		const permKey = `${permRead}:${permEdit}:${permBash}:${sysPrompt}`;

		// If the override differs or permissions changed, invalidate the cached agent
		if (
			tabAgent.agent &&
			(effectiveKeyId !== tabAgent.keyId || effectiveModelId !== tabAgent.modelId || permKey !== tabAgent._lastPermKey)
		) {
			tabAgent.agent = null;
		}

		if (!tabAgent.agent) {
			const workingDirectory = process.env.DISPATCH_WORKING_DIR ?? process.cwd();

			// Build tools list based on permission settings
			const toolEntries: Array<{ name: string; tool: ReturnType<typeof createReadFileTool> }> = [];
			if (permRead) {
				toolEntries.push({ name: "read_file", tool: createReadFileTool(workingDirectory) });
				toolEntries.push({ name: "list_files", tool: createListFilesTool(workingDirectory) });
			}
			if (permEdit) {
				toolEntries.push({ name: "write_file", tool: createWriteFileTool(workingDirectory) });
			}
			if (permBash) {
				toolEntries.push({ name: "run_shell", tool: createRunShellTool(workingDirectory) });
			}
			toolEntries.push({ name: "task_list", tool: createTaskListTool(tabAgent.taskList) });
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
				const keyState = this.modelRegistry.getKeys().find((k) => k.definition.id === effectiveKeyId);
				if (keyState) {
					const key = keyState.definition;
					if (key.provider === "anthropic") {
						// Anthropic provider: resolve credentials from Claude accounts
						const credFile = key.credentials_file;
						const account = this.claudeAccounts.find((a) => a.id === effectiveKeyId)
							?? (credFile ? this.claudeAccounts.find((a) => a.source === credFile) : this.claudeAccounts[0]);
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
									console.warn(`dispatch: unable to refresh Claude credentials for "${account.label}" — using stale token`);
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
						const envKey = resolveApiKey(key.id);
						if (envKey) {
							apiKey = envKey;
							baseURL = key.base_url;
							model = effectiveModelId;
							tabAgent.keyId = effectiveKeyId;
							tabAgent.modelId = effectiveModelId;
							useOverride = true;
						} else {
							console.warn(`dispatch: env var "${key.env}" not set for key "${key.id}", falling back to env vars`);
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
			tabAgent.agent = new Agent({
				model,
				apiKey,
				baseURL,
				systemPrompt: buildSystemPrompt(toolNames, customSystemPrompt),
				tools,
				workingDirectory,
				permissionChecker: this.permissionManager ?? undefined,
				ruleset,
				provider,
				...(claudeCredentials ? { claudeCredentials } : {}),
			});
		}
		return tabAgent.agent;
	}

	getTabStatus(tabId: string): AgentStatus {
		return this.tabAgents.get(tabId)?.status ?? "idle";
	}

	getAllStatuses(): Record<string, AgentStatus> {
		const result: Record<string, AgentStatus> = {};
		for (const [tabId, tabAgent] of this.tabAgents.entries()) {
			result[tabId] = tabAgent.status;
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

	stopTab(tabId: string): void {
		const tabAgent = this.tabAgents.get(tabId);
		if (tabAgent) {
			tabAgent.status = "idle";
			tabAgent.agent = null;
		}
	}

	deleteTab(tabId: string): void {
		this.stopTab(tabId);
		this.tabAgents.delete(tabId);
	}

	async processMessage(tabId: string, message: string, keyId?: string, modelId?: string, reasoningEffort?: "none" | "low" | "medium" | "high" | "max"): Promise<void> {
		const tabAgent = this._getOrCreateTabAgent(tabId);
		tabAgent.status = "running";
		this.messageCount += 1;

		try {
			const agent = await this.getOrCreateAgentForTab(tabId, keyId, modelId);

			// Persist user message to DB
			appendMessage(tabId, crypto.randomUUID(), "user", JSON.stringify([{ type: "text", text: message }]));

			let assistantText = "";
			let assistantThinking = "";
			const assistantToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; result?: string; isError?: boolean }> = [];

			for await (const event of agent.run(message, reasoningEffort ? { reasoningEffort } : undefined)) {
				if (event.type === "status") {
					tabAgent.status = event.status;
				}
				this.emit(event, tabId);

				// Accumulate content for DB persistence
				if (event.type === "text-delta") {
					assistantText += event.delta;
				} else if (event.type === "reasoning-delta") {
					assistantThinking += event.delta;
				} else if (event.type === "tool-call") {
					assistantToolCalls.push({ id: event.toolCall.id, name: event.toolCall.name, arguments: event.toolCall.arguments });
				} else if (event.type === "tool-result") {
					const tc = assistantToolCalls.find((t) => t.id === event.toolResult.toolCallId);
					if (tc) { tc.result = event.toolResult.result; tc.isError = event.toolResult.isError; }
				} else if (event.type === "done") {
					// Persist assistant message to DB
					const contentSegments: Array<Record<string, unknown>> = [];
					if (assistantText) contentSegments.push({ type: "text", text: assistantText });
					for (const tc of assistantToolCalls) {
						contentSegments.push({ type: "tool-call", ...tc });
					}
					if (contentSegments.length > 0) {
						appendMessage(tabId, crypto.randomUUID(), "assistant", JSON.stringify(contentSegments), assistantThinking || undefined);
					}
					// Reset for next turn
					assistantText = "";
					assistantThinking = "";
					assistantToolCalls.length = 0;
				}
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			tabAgent.status = "error";
			this.emit({ type: "error", error: errorMsg }, tabId);
			this.emit({ type: "status", status: "error" }, tabId);
		}
	}

	destroy(): void {
		this.configWatcher?.close();
		this.skillsWatcher?.close();
	}
}
