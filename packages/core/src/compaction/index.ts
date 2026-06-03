// Conversation compaction — summarize the older "head" of a conversation into
// a structured anchor while preserving the most recent turns verbatim.
//
// Ported from opencode's `session/compaction.ts` (SUMMARY_TEMPLATE, the
// anchored-summary `buildPrompt`, and the `TOOL_OUTPUT_MAX_CHARS` cap). The
// turn-budget `splitTurn` tail selection is intentionally simplified to a fixed
// recent-turn count (`DEFAULT_TAIL_TURNS`) — Dispatch keeps the last N turns
// verbatim rather than computing a token budget.
//
// This module is pure and DB-free so it can be unit-tested in isolation and
// shared by the API orchestrator.

import type { ChatMessage } from "../types/index.js";

/** Number of trailing turns kept verbatim (opencode's DEFAULT_TAIL_TURNS). */
export const DEFAULT_TAIL_TURNS = 2;

/** Max characters of a single tool result fed into the summary request. */
export const TOOL_OUTPUT_MAX_CHARS = 2_000;

/**
 * Marker prefixing the seeded summary turn in a compacted conversation. Lets a
 * subsequent compaction detect a prior summary and re-summarize (anchor) it
 * instead of treating it as ordinary conversation.
 */
export const SUMMARY_MARKER = "[CONVERSATION SUMMARY]";

/**
 * Structured Markdown template the summary must follow. Ported verbatim from
 * opencode's `SUMMARY_TEMPLATE`.
 */
export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

/**
 * Build the compaction instruction. When `previousSummary` is provided, the
 * model is asked to UPDATE the anchored summary rather than create a fresh one
 * (opencode's `buildPrompt` anchor behaviour).
 */
export function buildCompactionPrompt(input: { previousSummary?: string }): string {
	const anchor = input.previousSummary
		? [
				"Update the anchored summary below using the conversation history above.",
				"Preserve still-true details, remove stale details, and merge in the new facts.",
				"<previous-summary>",
				input.previousSummary,
				"</previous-summary>",
			].join("\n")
		: "Create a new anchored summary from the conversation history above.";
	return `${anchor}\n\n${SUMMARY_TEMPLATE}`;
}

/**
 * The first text chunk of a message, trimmed (empty → undefined). Used to read
 * the seeded summary out of a compacted conversation's first user turn.
 */
function firstText(message: ChatMessage): string | undefined {
	for (const chunk of message.chunks) {
		if (chunk.type === "text") {
			const t = chunk.text.trim();
			if (t) return t;
		}
	}
	return undefined;
}

/**
 * Extract a prior summary from the conversation head. If the first user message
 * is a seeded summary (starts with {@link SUMMARY_MARKER}), return its body
 * (marker stripped) so the next compaction can anchor on it.
 */
export function extractPreviousSummary(messages: ChatMessage[]): string | undefined {
	const first = messages.find((m) => m.role === "user");
	if (!first) return undefined;
	const text = firstText(first);
	if (!text?.startsWith(SUMMARY_MARKER)) return undefined;
	const body = text.slice(SUMMARY_MARKER.length).trim();
	return body || undefined;
}

export interface HeadTailSelection<T extends ChatMessage = ChatMessage> {
	/** Older messages to be summarized away. */
	head: T[];
	/** Recent messages preserved verbatim in the continuation. */
	tail: T[];
}

/**
 * Split a conversation into a summarizable `head` and a preserved `tail` of the
 * last `tailTurns` turns. A "turn" begins at a user message and runs until the
 * next user message.
 *
 * When the conversation has `tailTurns` or fewer turns, `head` is empty: there
 * is nothing to compact (the caller should refuse).
 */
export function selectHeadTail<T extends ChatMessage>(
	messages: T[],
	tailTurns: number = DEFAULT_TAIL_TURNS,
): HeadTailSelection<T> {
	if (tailTurns <= 0) return { head: messages, tail: [] };
	const userIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.role === "user") userIndices.push(i);
	}
	if (userIndices.length <= tailTurns) return { head: [], tail: messages };
	const tailStart = userIndices[userIndices.length - tailTurns];
	if (tailStart === undefined || tailStart <= 0) return { head: [], tail: messages };
	return { head: messages.slice(0, tailStart), tail: messages.slice(tailStart) };
}

/** Cap a tool result to `max` chars with a truncation marker. */
function capToolOutput(result: string, max: number): string {
	if (result.length <= max) return result;
	const omitted = result.length - max;
	return `${result.slice(0, max)}\n…[${omitted} chars truncated for summary]`;
}

/**
 * Render conversation messages into a compact, provider-agnostic plain-text
 * transcript suitable as summary-request context. Tool results are capped at
 * `toolOutputMaxChars` (opencode's `TOOL_OUTPUT_MAX_CHARS`), and a seeded prior
 * summary message is skipped (its content is carried by the prompt anchor).
 * Thinking/error/system chunks are omitted as summary noise.
 */
export function renderTranscript(
	messages: ChatMessage[],
	toolOutputMaxChars: number = TOOL_OUTPUT_MAX_CHARS,
): string {
	const blocks: string[] = [];
	for (const message of messages) {
		// Skip a seeded prior-summary user turn — it's represented via the anchor.
		if (message.role === "user") {
			const t = firstText(message);
			if (t?.startsWith(SUMMARY_MARKER)) continue;
		}

		const lines: string[] = [];
		for (const chunk of message.chunks) {
			if (chunk.type === "text") {
				const t = chunk.text.trim();
				if (t) lines.push(t);
			} else if (chunk.type === "tool-batch") {
				for (const call of chunk.calls) {
					let args = "";
					try {
						args = JSON.stringify(call.arguments ?? {});
					} catch {
						args = "{}";
					}
					lines.push(`[tool ${call.name} ${args}]`);
					if (call.result !== undefined) {
						const tag = call.isError ? "tool-error" : "tool-result";
						lines.push(`[${tag}] ${capToolOutput(call.result, toolOutputMaxChars)}`);
					}
				}
			}
		}
		if (lines.length === 0) continue;
		const role =
			message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
		blocks.push(`## ${role}\n${lines.join("\n")}`);
	}
	return blocks.join("\n\n");
}

export interface CompactionRequest<T extends ChatMessage = ChatMessage> {
	/** Messages selected for summarization (older head). */
	head: T[];
	/** Recent messages preserved verbatim (last N turns). */
	tail: T[];
	/** Prior summary anchored on, if the conversation was compacted before. */
	previousSummary?: string;
	/**
	 * The full user-message content for the summary request: rendered head
	 * transcript followed by the compaction prompt/template. `undefined` when
	 * there is nothing to compact (`head` empty).
	 */
	prompt?: string;
}

/**
 * Assemble everything needed to run a compaction: head/tail split, prior-summary
 * extraction, and the combined summary-request prompt. Returns `prompt:
 * undefined` when the conversation is too short to compact.
 */
export function buildCompactionRequest<T extends ChatMessage>(input: {
	messages: T[];
	tailTurns?: number;
	toolOutputMaxChars?: number;
}): CompactionRequest<T> {
	const tailTurns = input.tailTurns ?? DEFAULT_TAIL_TURNS;
	const toolMax = input.toolOutputMaxChars ?? TOOL_OUTPUT_MAX_CHARS;
	const { head, tail } = selectHeadTail(input.messages, tailTurns);
	const previousSummary = extractPreviousSummary(input.messages);
	if (head.length === 0) {
		return { head, tail, previousSummary };
	}
	const transcript = renderTranscript(head, toolMax);
	const instruction = buildCompactionPrompt({ previousSummary });
	const prompt = `${transcript}\n\n${instruction}`;
	return { head, tail, previousSummary, prompt };
}

/**
 * Wrap a generated summary as the seeded user-turn text for the continuation
 * conversation. Prefixed with {@link SUMMARY_MARKER} so a later compaction can
 * anchor on it.
 */
export function buildSummaryTurnText(summary: string): string {
	return `${SUMMARY_MARKER}\n\n${summary.trim()}`;
}
