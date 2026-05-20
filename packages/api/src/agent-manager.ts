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
	ModelResolver,
	TaskList,
	createTaskListTool,
	type ClaudeAccount,
	discoverClaudeAccounts,
	refreshAccountCredentials,
	refreshAccountCredentialsAsync,
} from "@dispatch/core";
import type { PermissionManager } from "./permission-manager.js";
import { setConfigGetter } from "./routes/config.js";
import { setSkillsGetter } from "./routes/skills.js";
import { setModelsGetter, setAccountsGetter } from "./routes/models.js";

const SYSTEM_PROMPT = `You are Dispatch, a helpful AI coding assistant. You have access to the following tools for working with files in the current working directory:

- read_file: Read the contents of a file
- write_file: Write content to a file (creates parent directories if needed)
- list_files: List files and directories
- run_shell: Execute shell commands in the working directory (bash). Returns stdout, stderr, and exit code. Use for running tests, builds, git operations, package management, and other development tasks. Do NOT run destructive or irreversible commands unless the user explicitly requests them.
- task_list: Manage a task list for tracking work items.

When asked to work with files, use these tools. Always confirm what you did after completing an action. Be concise and helpful.`;

export class AgentManager {
	private agent: Agent | null = null;
	private status: AgentStatus = "idle";
	private messageCount = 0;
	private eventListeners: Set<(event: AgentEvent) => void> = new Set();
	private permissionManager: PermissionManager | undefined;

	activeModelId: string | null = null;
	activeKeyId: string | null = null;

	private config: DispatchConfig;
	private skillsData: { skills: SkillDefinition[]; mappings: AgentSkillMapping[] };
	private modelRegistry: ModelRegistry | null = null;
	private modelResolver: ModelResolver | null = null;
	private taskList: TaskList;

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
			() => this.modelResolver,
		);
		setAccountsGetter(() => this.claudeAccounts);

		// Set up task list
		this.taskList = new TaskList();
		this.taskList.onChange((tasks) => {
			this.emit({ type: "task-list-update", tasks });
		});

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
			// Invalidate cached agent so next message uses updated config
			this.agent = null;
			this.emit({ type: "config-reload" });
		});

		this.skillsWatcher = createSkillsWatcher(workingDirectory, (result) => {
			this.skillsData = result;
			// Invalidate cached agent so next message uses updated skills
			this.agent = null;
			this.emit({ type: "config-reload" });
		});
	}

	private _refreshClaudeAccounts(): void {
		try {
			this.claudeAccounts = discoverClaudeAccounts();
			if (this.claudeAccounts.length > 0) {
				console.log(`dispatch: discovered ${this.claudeAccounts.length} Claude account(s)`);
			}
		} catch (err) {
			console.warn(`dispatch: failed to discover Claude accounts: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _initModelRegistry(config: DispatchConfig): void {
		if (config.models && config.keys) {
			if (this.modelRegistry) {
				this.modelRegistry.updateConfig(config.models, config.keys, config.fallback ?? []);
			} else {
				this.modelRegistry = new ModelRegistry(config.models, config.keys, config.fallback ?? []);
				this.modelResolver = new ModelResolver(this.modelRegistry);
			}
		} else {
			// Models/keys removed from config — clear the registry
			this.modelRegistry = null;
			this.modelResolver = null;
		}
	}

	getPermissionManager(): PermissionManager | undefined {
		return this.permissionManager;
	}

	getTaskList(): TaskList {
		return this.taskList;
	}

	getClaudeAccounts(): ClaudeAccount[] {
		return this.claudeAccounts;
	}

	private async getOrCreateAgent(keyId?: string, modelId?: string): Promise<Agent> {
		// Determine effective override: use provided values, or fall back to stored active values
		const effectiveKeyId = keyId ?? this.activeKeyId ?? undefined;
		const effectiveModelId = modelId ?? this.activeModelId ?? undefined;

		// If the override differs from what the current agent was built with, invalidate the cache
		if (
			this.agent &&
			(effectiveKeyId !== this.activeKeyId || effectiveModelId !== this.activeModelId)
		) {
			this.agent = null;
		}

		if (!this.agent) {
			const workingDirectory = process.env.DISPATCH_WORKING_DIR ?? process.cwd();

			const tools = [
				createReadFileTool(workingDirectory),
				createWriteFileTool(workingDirectory),
				createListFilesTool(workingDirectory),
				createRunShellTool(workingDirectory),
				createTaskListTool(this.taskList),
			];

			const ruleset = configToRuleset(this.config);

			// Try to resolve model from registry, fall back to env vars
			let apiKey = process.env.OPENCODE_API_KEY ?? "";
			let model = process.env.DISPATCH_MODEL ?? "deepseek-v4-flash";
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
						const account = credFile
							? this.claudeAccounts.find((a) => a.source === credFile)
							: this.claudeAccounts[0];
						if (account) {
							const creds = refreshAccountCredentials(account);
							if (creds && creds.expiresAt > Date.now() + 60_000) {
								claudeCredentials = { accessToken: creds.accessToken };
								apiKey = creds.accessToken;
								baseURL = key.base_url;
								model = effectiveModelId;
								provider = "anthropic";
								this.activeKeyId = effectiveKeyId;
								this.activeModelId = effectiveModelId;
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
									this.activeKeyId = effectiveKeyId;
									this.activeModelId = effectiveModelId;
									useOverride = true;
								} else {
									console.warn(`dispatch: unable to refresh Claude credentials for "${account.label}" — using stale token`);
									claudeCredentials = { accessToken: account.credentials.accessToken };
									apiKey = account.credentials.accessToken;
									baseURL = key.base_url;
									model = effectiveModelId;
									provider = "anthropic";
									this.activeKeyId = effectiveKeyId;
									this.activeModelId = effectiveModelId;
									useOverride = true;
								}
							}
						} else {
							console.warn(`dispatch: no Claude credentials found for key "${key.id}"`);
						}
					} else {
						// Standard key: resolve from env var
						const envKey = key.env ? process.env[key.env] : undefined;
						if (envKey) {
							apiKey = envKey;
							baseURL = key.base_url;
							model = effectiveModelId;
							this.activeKeyId = effectiveKeyId;
							this.activeModelId = effectiveModelId;
							useOverride = true;
						} else {
							console.warn(`dispatch: env var "${key.env}" not set for key "${key.id}", falling back to env vars`);
							this.activeKeyId = effectiveKeyId;
							this.activeModelId = effectiveModelId;
							useOverride = true;
						}
					}
				} else {
					console.warn(`dispatch: key "${effectiveKeyId}" not found in model registry, falling back to tag-based resolution`);
				}
			}

			if (!useOverride) {
				// Clear any previous override when falling back to default resolution
				this.activeKeyId = null;
				this.activeModelId = null;
			}

			if (!useOverride && this.modelRegistry && this.modelResolver) {
				// Try to get model_tag from default agent template, fall back to "heavy"
				const defaultAgent = this.config.agents?.["default"];
				const tag = defaultAgent?.model_tag ?? "heavy";
				const resolved = this.modelResolver.resolve(tag);
				if (resolved) {
					model = resolved.model.id;
					baseURL = resolved.key.base_url;
					// Check if resolved key is anthropic
					if (resolved.key.provider === "anthropic") {
						const credFile = resolved.key.credentials_file;
						const account = credFile
							? this.claudeAccounts.find((a) => a.source === credFile)
							: this.claudeAccounts[0];
						if (account) {
							let creds = refreshAccountCredentials(account);
							if (!creds || creds.expiresAt <= Date.now() + 60_000) {
								creds = await refreshAccountCredentialsAsync(account);
								if (creds) account.credentials = creds;
							}
							if (creds) {
								claudeCredentials = { accessToken: creds.accessToken };
								apiKey = creds.accessToken;
								provider = "anthropic";
							} else {
								console.warn(`dispatch: no valid Claude credentials for key "${resolved.key.id}"`);
							}
						} else {
							console.warn(`dispatch: no Claude credentials found for key "${resolved.key.id}"`);
						}
					} else {
						const envKey = process.env[resolved.key.env!];
						if (envKey) {
							apiKey = envKey;
						} else {
							console.warn(`dispatch: env var "${resolved.key.env}" not set for key "${resolved.key.id}", falling back to env vars`);
							model = process.env.DISPATCH_MODEL ?? "deepseek-v4-flash";
							baseURL = "https://opencode.ai/zen/go/v1";
							apiKey = process.env.OPENCODE_API_KEY ?? "";
						}
					}
				} else {
					console.warn(`dispatch: could not resolve model for tag "${tag}", falling back to env vars`);
				}
			}

			this.agent = new Agent({
				model,
				apiKey,
				baseURL,
				systemPrompt: SYSTEM_PROMPT,
				tools,
				workingDirectory,
				permissionChecker: this.permissionManager ?? undefined,
				ruleset,
				provider,
				...(claudeCredentials ? { claudeCredentials } : {}),
			});
		}
		return this.agent;
	}

	getStatus(): AgentStatus {
		return this.status;
	}

	getMessageCount(): number {
		return this.messageCount;
	}

	onEvent(listener: (event: AgentEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.eventListeners) {
			listener(event);
		}
	}

	async processMessage(message: string, keyId?: string, modelId?: string, reasoningEffort?: "none" | "low" | "medium" | "high" | "max"): Promise<void> {
		this.status = "running";
		this.messageCount += 1;

		try {
			const agent = await this.getOrCreateAgent(keyId, modelId);
			for await (const event of agent.run(message, reasoningEffort ? { reasoningEffort } : undefined)) {
				this.status = event.type === "status" ? event.status : this.status;
				this.emit(event);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.status = "error";
			this.emit({ type: "error", error: errorMsg });
			this.emit({ type: "status", status: "error" });
		}
	}

	destroy(): void {
		this.configWatcher?.close();
		this.skillsWatcher?.close();
	}
}
