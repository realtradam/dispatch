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
} from "@dispatch/core";
import type { PermissionManager } from "./permission-manager.js";
import { setConfigGetter } from "./routes/config.js";
import { setSkillsGetter } from "./routes/skills.js";
import { setModelsGetter } from "./routes/models.js";

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

	private config: DispatchConfig;
	private skillsData: { skills: SkillDefinition[]; mappings: AgentSkillMapping[] };
	private modelRegistry: ModelRegistry | null = null;
	private modelResolver: ModelResolver | null = null;
	private taskList: TaskList;

	private configWatcher: { close(): void } | null = null;
	private skillsWatcher: { close(): void } | null = null;

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

		// Wire route getters
		setConfigGetter(() => this.config);
		setSkillsGetter(() => this.skillsData);
		setModelsGetter(
			() => this.modelRegistry,
			() => this.modelResolver,
		);

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

	private getOrCreateAgent(): Agent {
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

			if (this.modelRegistry && this.modelResolver) {
				// Try to get model_tag from default agent template, fall back to "heavy"
				const defaultAgent = this.config.agents?.["default"];
				const tag = defaultAgent?.model_tag ?? "heavy";
				const resolved = this.modelResolver.resolve(tag);
				if (resolved) {
					model = resolved.model.id;
					baseURL = resolved.key.base_url;
					const envKey = process.env[resolved.key.env];
					if (envKey) {
						apiKey = envKey;
					} else {
						console.warn(`dispatch: env var "${resolved.key.env}" not set for key "${resolved.key.id}", falling back to env vars`);
						// Don't use the resolved key — fall back to default env vars entirely
						model = process.env.DISPATCH_MODEL ?? "deepseek-v4-flash";
						baseURL = "https://opencode.ai/zen/go/v1";
						apiKey = process.env.OPENCODE_API_KEY ?? "";
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

	async processMessage(message: string): Promise<void> {
		const agent = this.getOrCreateAgent();

		this.status = "running";
		this.messageCount += 1;

		try {
			for await (const event of agent.run(message)) {
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
