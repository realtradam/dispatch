/**
 * Conversation model — the kernel's representation of a dialogue.
 *
 * Re-exported from @dispatch/wire so the kernel barrel surface stays
 * byte-identical. The canonical definitions live in @dispatch/wire.
 */

export type {
	ChatMessage,
	Chunk,
	ErrorChunk,
	Role,
	StepId,
	StoredChunk,
	SystemChunk,
	TextChunk,
	ThinkingChunk,
	ToolCallChunk,
	ToolResultChunk,
	TurnId,
} from "@dispatch/wire";
