/**
 * @dispatch/wire — pure wire types shared by the kernel, the transport
 * contract, and out-of-repo clients (the web frontend).
 *
 * Types ONLY: zero runtime, zero `@dispatch/*` dependencies, so a client can
 * depend on the wire without pulling the kernel runtime.
 */

// ─── Conversation model ─────────────────────────────────────────────────────

/** Who produced a message. */
export type Role = "system" | "user" | "assistant" | "tool";

/** Opaque identifier for a turn (one user→assistant cycle). */
export type TurnId = string & { readonly __brand: "TurnId" };

/** Opaque identifier for a step (one LLM round-trip within a turn). */
export type StepId = string & { readonly __brand: "StepId" };

/**
 * A chunk is one ordered piece of a message — the atomic unit of the
 * append-only conversation log. Discriminated by `type`.
 */
export type Chunk =
	| TextChunk
	| ThinkingChunk
	| ToolCallChunk
	| ToolResultChunk
	| ErrorChunk
	| SystemChunk;

/** A piece of plain text content from the assistant or user. */
export interface TextChunk {
	readonly type: "text";
	readonly text: string;
}

/** A piece of model reasoning / thinking content (e.g. extended thinking). */
export interface ThinkingChunk {
	readonly type: "thinking";
	readonly text: string;
}

/**
 * A model's request to run a tool. The kernel routes by `name`; the tool
 * implementation never sees this directly — it receives parsed `input` via
 * `ToolContract.execute`.
 */
export interface ToolCallChunk {
	readonly type: "tool-call";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

/**
 * The result of a tool execution, attributed to the originating tool-call id.
 * The kernel guarantees every tool-call chunk gets exactly one result chunk
 * (synthesized if interrupted — see reconcile).
 */
export interface ToolResultChunk {
	readonly type: "tool-result";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: string;
	readonly isError: boolean;
}

/** An error that occurred during generation or tool dispatch. */
export interface ErrorChunk {
	readonly type: "error";
	readonly message: string;
	readonly code?: string;
}

/**
 * A system-injected message (e.g. system prompt, context assembly output).
 * Kept distinct from text so the log records provenance.
 */
export interface SystemChunk {
	readonly type: "system";
	readonly text: string;
}

/**
 * A chat message: a role plus an ordered sequence of chunks. Messages are the
 * unit passed to and from the provider; chunks are the unit persisted and
 * rendered.
 */
export interface ChatMessage {
	readonly role: Role;
	readonly chunks: readonly Chunk[];
}

/**
 * A persisted chunk plus its sync metadata. The append-only conversation log
 * stamps every chunk with a monotonic, gap-free, per-conversation `seq` (the
 * sync cursor, assigned in append order) and records the `role` of the message
 * it belongs to. This makes a flat seq-ordered stream both incrementally
 * syncable ("give me chunks after seq N") and regroupable into messages by the
 * client. `chunk` is the pure content unit, unchanged — `Chunk` itself never
 * carries storage metadata (it is also passed to/from the provider, which has
 * no use for a cursor).
 */
export interface StoredChunk {
	readonly seq: number;
	readonly role: Role;
	readonly chunk: Chunk;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

/**
 * Token usage counters for a single step. All fields are counts of tokens.
 * Cache fields are optional because not all providers expose cache metrics.
 */
export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
}

// ─── Outward events ─────────────────────────────────────────────────────────

/**
 * The union of all events the runtime emits outward during a turn.
 * Consumers (transport, persistence, notifications) pattern-match on `type`.
 */
export type AgentEvent =
	| StatusEvent
	| TurnStartEvent
	| TurnTextDeltaEvent
	| TurnReasoningDeltaEvent
	| TurnToolCallEvent
	| TurnToolResultEvent
	| TurnToolOutputEvent
	| TurnUsageEvent
	| TurnErrorEvent
	| TurnDoneEvent
	| TurnSealedEvent;

/** Status change for a conversation (e.g. idle → running). */
export interface StatusEvent {
	readonly type: "status";
	readonly conversationId: string;
	readonly status: string;
}

/** A turn has begun. */
export interface TurnStartEvent {
	readonly type: "turn-start";
	readonly conversationId: string;
	readonly turnId: string;
}

/** Incremental text content from the model during a turn. */
export interface TurnTextDeltaEvent {
	readonly type: "text-delta";
	readonly conversationId: string;
	readonly turnId: string;
	readonly delta: string;
}

/** Incremental reasoning / thinking content during a turn. */
export interface TurnReasoningDeltaEvent {
	readonly type: "reasoning-delta";
	readonly conversationId: string;
	readonly turnId: string;
	readonly delta: string;
}

/** The model has requested a tool to be run. */
export interface TurnToolCallEvent {
	readonly type: "tool-call";
	readonly conversationId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

/** A tool has completed execution. */
export interface TurnToolResultEvent {
	readonly type: "tool-result";
	readonly conversationId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: string;
	readonly isError: boolean;
}

/** Streaming output from a tool execution (e.g. shell stdout/stderr). */
export interface TurnToolOutputEvent {
	readonly type: "tool-output";
	readonly conversationId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly data: string;
	readonly stream: "stdout" | "stderr";
}

/** Token usage for the current step or turn. */
export interface TurnUsageEvent {
	readonly type: "usage";
	readonly conversationId: string;
	readonly turnId: string;
	readonly usage: Usage;
}

/** An error occurred during the turn. */
export interface TurnErrorEvent {
	readonly type: "error";
	readonly conversationId: string;
	readonly turnId: string;
	readonly message: string;
	readonly code?: string;
}

/** The turn has completed (model finished generating). */
export interface TurnDoneEvent {
	readonly type: "done";
	readonly conversationId: string;
	readonly turnId: string;
	readonly reason: string;
}

/**
 * The turn has been sealed — all chunks persisted, history is final.
 * This is the hook point for post-turn extensions (compaction, cache-warm).
 */
export interface TurnSealedEvent {
	readonly type: "turn-sealed";
	readonly conversationId: string;
	readonly turnId: string;
}
