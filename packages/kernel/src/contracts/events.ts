/**
 * Outward events — the event type the runtime emits to the outside world.
 *
 * These are the events transport extensions push to clients, notification
 * extensions react to, and conversation-store uses for persistence.
 * Discriminated by `type`.
 */

import type { Usage } from "./provider.js";

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

/** Status change for a tab / session (e.g. idle → running). */
export interface StatusEvent {
	readonly type: "status";
	readonly tabId: string;
	readonly status: string;
}

/** A turn has begun. */
export interface TurnStartEvent {
	readonly type: "turn-start";
	readonly tabId: string;
	readonly turnId: string;
}

/** Incremental text content from the model during a turn. */
export interface TurnTextDeltaEvent {
	readonly type: "text-delta";
	readonly tabId: string;
	readonly turnId: string;
	readonly delta: string;
}

/** Incremental reasoning / thinking content during a turn. */
export interface TurnReasoningDeltaEvent {
	readonly type: "reasoning-delta";
	readonly tabId: string;
	readonly turnId: string;
	readonly delta: string;
}

/** The model has requested a tool to be run. */
export interface TurnToolCallEvent {
	readonly type: "tool-call";
	readonly tabId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

/** A tool has completed execution. */
export interface TurnToolResultEvent {
	readonly type: "tool-result";
	readonly tabId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: string;
	readonly isError: boolean;
}

/** Streaming output from a tool execution (e.g. shell stdout/stderr). */
export interface TurnToolOutputEvent {
	readonly type: "tool-output";
	readonly tabId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly data: string;
	readonly stream: "stdout" | "stderr";
}

/** Token usage for the current step or turn. */
export interface TurnUsageEvent {
	readonly type: "usage";
	readonly tabId: string;
	readonly turnId: string;
	readonly usage: Usage;
}

/** An error occurred during the turn. */
export interface TurnErrorEvent {
	readonly type: "error";
	readonly tabId: string;
	readonly turnId: string;
	readonly message: string;
	readonly code?: string;
}

/** The turn has completed (model finished generating). */
export interface TurnDoneEvent {
	readonly type: "done";
	readonly tabId: string;
	readonly turnId: string;
	readonly reason: string;
}

/**
 * The turn has been sealed — all chunks persisted, history is final.
 * This is the hook point for post-turn extensions (compaction, cache-warm).
 */
export interface TurnSealedEvent {
	readonly type: "turn-sealed";
	readonly tabId: string;
	readonly turnId: string;
}
