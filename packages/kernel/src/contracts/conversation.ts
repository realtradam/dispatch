/**
 * Conversation model — the kernel's representation of a dialogue.
 *
 * The kernel owns only the types and pure transforms. Persistence is a core
 * extension (conversation-store). A turn is one user→assistant cycle; a step
 * is one LLM round-trip within a turn. Chunks are append-only.
 */

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
