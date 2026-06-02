import type { ZodType } from "zod";
import type { PermissionChecker, Ruleset } from "../permission/index.js";

// ─── Message Types ───────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

/**
 * A single ordered chunk of content inside a message. The chunk list
 * preserves the actual temporal ordering of text, reasoning, tool calls,
 * system notices, and errors as they arrived from the model.
 *
 * Coalescing rules (see notes/plan-chunk-refactor.md):
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
	/**
	 * Full Anthropic `providerMetadata` blob captured from the v6
	 * `reasoning-end` stream event (typically `{ anthropic: { signature
	 * } }` plus any other provider-side metadata). Round-tripped verbatim
	 * as `providerOptions` on the `ReasoningPart` of the next request so
	 * Anthropic can validate the thinking block's signature.
	 *
	 * Also acts as a "sealed" marker for `appendEventToChunks`: once
	 * `metadata` is set, the next `reasoning-delta` opens a new thinking
	 * chunk rather than extending this one (each Anthropic content block
	 * gets its own metadata, so two consecutive thinking blocks must not
	 * be coalesced).
	 *
	 * Optional: non-Anthropic models produce no metadata, and pre-v6
	 * persisted chunks have neither field.
	 */
	metadata?: Record<string, unknown>;
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

// ─── Append-only chunk log (persisted model) ─────────────────────
//
// The DB stores a conversation as a flat stream of `ChunkRow`s (see
// db/chunks.ts). The render-facing `Chunk`/`ChatMessage` shapes above are
// DERIVED from these rows by grouping (turn_id + step + role). Tool calls
// and their results are SEPARATE rows linked by `callId`, mapping 1:1 to the
// Anthropic wire format.

/** Role of a persisted chunk row. `tool` rows hold tool results. */
export type ChunkRole = "user" | "assistant" | "tool" | "system";

/** Discriminator for a persisted chunk row's payload. */
export type ChunkType =
	| "text"
	| "thinking"
	| "tool_call"
	| "tool_result"
	| "error"
	| "system"
	| "usage";

export interface TextData {
	text: string;
}
export interface ThinkingData {
	text: string;
	metadata?: Record<string, unknown>;
}
export interface ToolCallData {
	callId: string;
	name: string;
	arguments: Record<string, unknown>;
}
export interface ToolResultData {
	callId: string;
	name: string;
	result: string;
	isError: boolean;
	shellOutput?: { stdout: string; stderr: string };
}
export interface ErrorData {
	message: string;
	statusCode?: number;
}
export interface SystemData {
	kind: SystemChunkKind;
	text: string;
}
/**
 * Per-request token usage persisted as a SIDE-CHANNEL chunk row (one row per
 * `usage` AgentEvent, i.e. one per LLM round-trip). These rows are deliberately
 * EXCLUDED from `getChunksForTab`/`getTotalChunkCount` so they never enter the
 * render, pagination, eviction, or agent-history-rebuild paths — they exist
 * only to feed the backend aggregate `getUsageStatsForTab`, which seeds the
 * frontend's `cacheStats` on reload. `inputTokens` is the TOTAL prompt
 * (cached + fresh); `cacheReadTokens`/`cacheWriteTokens` are Anthropic's
 * prompt-cache split. Mirrors the `usage` AgentEvent payload.
 */
export interface UsageData {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export type ChunkData =
	| TextData
	| ThinkingData
	| ToolCallData
	| ToolResultData
	| ErrorData
	| SystemData
	| UsageData;

/**
 * A persisted chunk row — the append-only unit of conversation storage and
 * the unit of frontend pagination. `seq` is per-tab monotonic and is both the
 * ordering key and the pagination cursor.
 */
export interface ChunkRow {
	id: string;
	tabId: string;
	seq: number;
	turnId: string;
	step: number;
	role: ChunkRole;
	type: ChunkType;
	data: ChunkData;
	createdAt: number;
}

/**
 * A chunk-row draft (no `seq`/`tabId`/`createdAt`/`id` yet) used when
 * exploding an in-memory turn into rows for persistence.
 */
export interface ChunkRowDraft {
	turnId: string;
	step: number;
	role: ChunkRole;
	type: ChunkType;
	data: ChunkData;
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

/**
 * Per-tab snapshot of live state, sent on WS connect and via
 * `GET /status`. Carries enough information for a freshly-loaded
 * frontend to reconstruct any in-flight assistant message.
 *
 * - `status` — always present; mirrors the in-memory `TabAgent.status`.
 * - `currentChunks` — the live in-flight `Chunk[]` for the running
 *   assistant turn. Present iff `status === "running"` AND
 *   `TabAgent.currentChunks` is non-null. Defensively copied at
 *   snapshot time; the consumer owns the array.
 * - `currentAssistantId` — DB id of the in-flight assistant message
 *   (the row that the eventual `flushAssistant` call will write/update).
 *   Present iff `status === "running"` AND `TabAgent.currentAssistantId`
 *   is set. The frontend uses this to align its local assistant
 *   message id with the persisted id so subsequent `done` and reload
 *   paths line up.
 *
 * Not part of `AgentEvent` itself: the `statuses` payload is a WS-
 * connect-level snapshot, not an event the `Agent` emits. The frontend
 * mirrors this type in `packages/frontend/src/lib/types.ts`.
 */
export interface TabStatusSnapshot {
	status: AgentStatus;
	currentChunks?: Chunk[];
	currentAssistantId?: string;
	/**
	 * `turn_id` of the in-flight turn. Present iff `status === "running"`.
	 * Lets a frontend that reconnects mid-stream key its live chunks the same
	 * way `turn-start` would, so they reconcile cleanly when the turn seals.
	 */
	currentTurnId?: string;
}

export type AgentEvent =
	| { type: "status"; status: AgentStatus }
	/**
	 * Emitted once at the start of a turn (`processMessage`), before any
	 * content deltas. Carries the `turn_id` shared by this turn's user message
	 * and every assistant/tool chunk row. The frontend tags its in-flight
	 * (live) chunks with this id so they key-match the sealed rows on
	 * turn-completion reconcile (no remount/flicker). Display/sync only — not
	 * conversation content.
	 */
	| { type: "turn-start"; turnId: string }
	/**
	 * Emitted once after a turn has fully settled AND its chunks have been
	 * persisted (after `flushAssistant`). Signals the frontend that the turn's
	 * rows — with real `seq`s — are now durable and can be reloaded, so it can
	 * fold its transient live representation into the sealed chunk log. Emitted
	 * after `status: idle`/`error` (which fire before the DB write). Display/sync
	 * only — not conversation content.
	 */
	| { type: "turn-sealed"; turnId: string }
	| { type: "text-delta"; delta: string }
	| { type: "reasoning-delta"; delta: string }
	/**
	 * Emitted on the v6 `reasoning-end` stream event when it carries
	 * `providerMetadata`. `appendEventToChunks` attaches the metadata to
	 * the most recent unsealed `thinking` chunk; `toModelMessages` reads
	 * it back as `providerOptions` on the next request's `ReasoningPart`.
	 */
	| { type: "reasoning-end"; metadata?: Record<string, unknown> }
	| { type: "tool-call"; toolCall: ToolCall }
	| { type: "tool-result"; toolResult: ToolResult }
	| { type: "shell-output"; data: string; stream: "stdout" | "stderr" }
	/**
	 * Per-request token usage, emitted once per LLM round-trip (each
	 * `streamText` step) from the AI SDK `finish` stream event. `inputTokens`
	 * is the TOTAL prompt size including cached tokens; `cacheReadTokens` is
	 * the portion served from Anthropic's prompt cache (a cache HIT) and
	 * `cacheWriteTokens` the portion written to it (a cache seed). The "Cache
	 * Rate" view aggregates these to show the prompt-cache hit rate. Non-
	 * caching providers report zero for the cache fields.
	 */
	| {
			type: "usage";
			usage: {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheWriteTokens: number;
			};
	  }
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
			agentSlug?: string | null;
			workingDirectory: string | null;
			agentModels?: Array<{ key_id: string; model_id: string }> | null;
	  }
	| { type: "message-queued"; tabId: string; messageId: string; message: string }
	| {
			type: "message-consumed";
			tabId: string;
			messageIds: string[];
			/**
			 * Why the queue was drained:
			 *  - "interrupt": consumed mid-turn, folded into a running turn's tool
			 *    result as a [USER INTERRUPT]. The optimistic bubble collapses into
			 *    that sealed turn.
			 *  - "continuation": consumed between turns to START a new turn. The
			 *    optimistic bubble becomes that new turn's initiating user row.
			 * Absent ⇒ treat as "interrupt" (back-compat).
			 */
			reason?: "interrupt" | "continuation";
	  }
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
