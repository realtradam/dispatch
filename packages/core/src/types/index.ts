import type { ZodType } from "zod";
import type { PermissionChecker, Ruleset } from "../permission/index.js";

// ─── Message Types ───────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "tool";

export interface ChatMessage {
	role: MessageRole;
	content: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	toolName: string;
	result: string;
	isError: boolean;
}

// ─── Agent Status & Events ───────────────────────────────────────

export type AgentStatus = "idle" | "running" | "error" | "waiting_for_key";

export type AgentEvent =
	| { type: "status"; status: AgentStatus }
	| { type: "text-delta"; delta: string }
	| { type: "reasoning-delta"; delta: string }
	| { type: "tool-call"; toolCall: ToolCall }
	| { type: "tool-result"; toolResult: ToolResult }
	| { type: "shell-output"; data: string; stream: "stdout" | "stderr" }
	| { type: "error"; error: string }
	| { type: "done"; message: ChatMessage }
	| { type: "task-list-update"; tasks: TaskItem[] }
	| { type: "config-reload" }
	| {
			type: "tab-created";
			id: string;
			title: string;
			keyId: string | null;
			modelId: string | null;
			parentTabId: string | null;
	  };

// ─── Tool Types ──────────────────────────────────────────────────

export interface ToolExecuteContext {
	onOutput?: (data: string, stream: "stdout" | "stderr") => void;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: ZodType;
	execute: (args: Record<string, unknown>, context?: ToolExecuteContext) => Promise<string>;
}

// ─── Agent Configuration ─────────────────────────────────────────

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export interface AgentConfig {
	model: string;
	apiKey: string;
	baseURL: string;
	systemPrompt: string;
	tools: ToolDefinition[];
	workingDirectory: string;
	permissionChecker?: PermissionChecker;
	ruleset?: Ruleset;
	reasoningEffort?: ReasoningEffort;
	provider?: string;
	claudeCredentials?: {
		accessToken: string;
	};
}

// ─── Config Types (dispatch.toml) ────────────────────────────────

export interface DispatchConfig {
	keys?: KeyDefinition[];
	permissions: Record<string, string | Record<string, string>>;
}

export interface KeyDefinition {
	id: string;
	provider: string;
	env?: string;
	base_url: string;
	/** For "anthropic" provider: path to credentials file (default: ~/.claude/.credentials.json) */
	credentials_file?: string;
}

export type KeyStatus = "active" | "exhausted";

export interface KeyState {
	definition: KeyDefinition;
	status: KeyStatus;
	lastError?: string;
	exhaustedAt?: number;
}

// ─── Skills Types ────────────────────────────────────────────────

export type SkillScope = "global" | "project";
export type SkillDirectory = string;

export interface SkillDefinition {
	name: string;
	description: string;
	tags: string[];
	content: string;
	scope: SkillScope;
	source: string;
	directory: SkillDirectory;
}

export interface AgentSkillMapping {
	agentType: string;
	isOrchestrator: boolean;
	skills: string[];
	scope: SkillScope;
}

// ─── Task List Types ─────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TaskItem {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
}

// ─── Config Validation ───────────────────────────────────────────

export interface ConfigError {
	path: string;
	message: string;
}

// ─── Agent Definition Types ──────────────────────────────────────

export interface AgentModelEntry {
	key_id: string;
	model_id: string;
}

export interface AgentDefinition {
	/** Human-readable name */
	name: string;
	/** Short description of what this agent does */
	description: string;
	/** Skills to auto-include, as "scope:name" strings */
	skills: string[];
	/** Allowed tools (allowlist) */
	tools: string[];
	/** Key+model fallback hierarchy, tried in order */
	models: AgentModelEntry[];
	/** Where the TOML was loaded from: "global" or a directory path */
	scope: string;
	/** The slug (filename without .toml) */
	slug: string;
	/** Default working directory for this agent (optional, absolute path) */
	cwd?: string;
}
