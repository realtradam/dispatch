/**
 * Conversation model — the kernel's representation of a dialogue.
 *
 * Re-exported from @dispatch/wire so the kernel barrel surface stays
 * byte-identical. The canonical definitions live in @dispatch/wire.
 */

export type {
	ChatMessage,
	Chunk,
	ConversationMeta,
	ErrorChunk,
	Role,
	StepId,
	StepMetrics,
	StoredChunk,
	SystemChunk,
	TextChunk,
	ThinkingChunk,
	ToolCallChunk,
	ToolResultChunk,
	TurnId,
	TurnMetrics,
} from "@dispatch/wire";
