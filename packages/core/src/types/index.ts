import type { ZodType } from "zod";
import type { PermissionChecker, Ruleset } from "../permission/index.js";

// ─── Message Types ───────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

/**
 * A single ordered chunk of content inside a message. The chunk list
 * preserves the actual temporal ordering of text, reasoning, tool calls,
 * system notices, and errors as they arrived from the model.
 *
 * Coalescing rules (see plan-chunk-refactor.md):
 *  - `text` and `thinking` coalesce on consecutive same-type deltas.
 *  - `tool-batch` coalesces on consecutive `tool-call` events
 *    (appends a new entry to `calls`).
 *  - `error` and `system` are always single-event chunks (no coalescing).
 */
export type Chunk = TextChunk | ThinkingChunk | ToolBatchChunk | ErrorChunk | SystemChunk;

export interface TextChunk {
	type: "text";
	text: string;
}

export interface ThinkingChunk {
	type: "thinking";
	text: string;
}

export interface ToolBatchChunk {
	type: "tool-batch";
	calls: ToolBatchEntry[];
}

export interface ToolBatchEntry {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	shellOutput?: { stdout: string; stderr: string };
}

export interface ErrorChunk {
	type: "error";
	message: string;
	statusCode?: number;
}

export type SystemChunkKind = "notice" | "model-changed" | "config-reload" | "cancelled";

export interface SystemChunk {
	type: "system";
	kind: SystemChunkKind;
	text: string;
}

export interface ChatMessage {
	role: MessageRole;
	chunks: Chunk[];
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
	| { type: "error"; error: string; statusCode?: number }
	| { type: "notice"; message: string }
	| { type: "model-changed"; keyId: string; modelId: string }
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
			workingDirectory: string | null;
	  }
	| { type: "message-queued"; tabId: string; messageId: string; message: string }
	| { type: "message-consumed"; tabId: string; messageIds: string[] }
	| { type: "message-cancelled"; tabId: string; messageId: string };

// ─── Tool Types ──────────────────────────────────────────────────

export interface ToolExecuteContext {
	onOutput?: (data: string, stream: "stdout" | "stderr") => void;
	queueCallbacks?: QueueCallbacks;
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
	/**
	 * Tab ID the agent runs on. Used to scope per-tab side effects, namely
	 * the tool-output spill directory (`/tmp/dispatch/tool-results/<tabId>/`).
	 * Optional so legacy callers and tests can construct an Agent without one;
	 * a fallback ID is generated when absent.
	 */
	tabId?: string;
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

// ─── Message Queue Types ─────────────────────────────────────────

export interface QueuedMessage {
	id: string;
	message: string;
	timestamp: number;
}

export interface QueueCallbacks {
	dequeueMessages: () => QueuedMessage[];
	waitForQueuedMessage: () => { promise: Promise<void>; cancel: () => void };
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
	/** Whether this agent is a subagent (hidden from Chat Settings) */
	is_subagent?: boolean;
}
