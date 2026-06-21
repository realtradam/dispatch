import type { AgentEvent, ChatMessage, ReasoningEffort } from "@dispatch/kernel";

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isValidReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === "string" && VALID_REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export interface ChatCommand {
	readonly conversationId: string;
	readonly message: string;
	readonly model?: string;
	readonly cwd?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export interface ParseError {
	readonly error: string;
}

export type ParseResult = ChatCommand | ParseError;

export type SinceSeqResult = number | ParseError;

export function parseChatBody(body: unknown, generateId: () => string): ParseResult {
	if (body === null || typeof body !== "object") {
		return { error: "Request body must be a JSON object" };
	}

	const obj = body as Record<string, unknown>;

	const message = obj.message;
	if (typeof message !== "string" || message.trim().length === 0) {
		return { error: "Field 'message' is required and must be a non-empty string" };
	}

	const conversationId =
		typeof obj.conversationId === "string" && obj.conversationId.length > 0
			? obj.conversationId
			: generateId();

	const result: ChatCommand = { conversationId, message: message.trim() };

	if (obj.model !== undefined) {
		if (typeof obj.model !== "string") {
			return { error: "Field 'model' must be a string" };
		}
		(result as { model?: string }).model = obj.model;
	}

	if (obj.cwd !== undefined) {
		if (typeof obj.cwd !== "string") {
			return { error: "Field 'cwd' must be a string" };
		}
		(result as { cwd?: string }).cwd = obj.cwd;
	}

	if (obj.reasoningEffort !== undefined) {
		if (!isValidReasoningEffort(obj.reasoningEffort)) {
			return {
				error: `Field 'reasoningEffort' must be one of: ${VALID_REASONING_EFFORTS.join(", ")}`,
			};
		}
		(result as { reasoningEffort?: ReasoningEffort }).reasoningEffort = obj.reasoningEffort;
	}

	return result;
}

export function isParseError<T>(result: T | ParseError): result is ParseError {
	return typeof result === "object" && result !== null && "error" in result;
}

export function serializeEventLine(event: AgentEvent): string {
	return `${JSON.stringify(event)}\n`;
}

export function parseSinceSeq(raw: string | undefined): SinceSeqResult {
	if (raw === undefined || raw === "") return 0;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		return { error: "sinceSeq must be a non-negative integer" };
	}
	return n;
}

export function isSinceSeqError(result: SinceSeqResult): result is ParseError {
	return typeof result === "object";
}

/**
 * Result of parsing an OPTIONAL positive-integer history-window query param
 * (`limit` / `beforeSeq`): `undefined` = the param was absent (omit it from the
 * store window), a `number` = a valid positive integer, or a {@link ParseError}
 * for a malformed / zero / negative value (the route 400s on it).
 */
export type WindowParamResult = number | undefined | ParseError;

/**
 * Parse an optional `limit` / `beforeSeq` query param. Unlike `sinceSeq` these
 * must be STRICTLY POSITIVE integers when present (zero is rejected, since the
 * store treats a zero bound as absent and would silently return the full log).
 * Absent (`undefined` / empty) is the valid "no window" case → `undefined`.
 */
export function parseWindowParam(raw: string | undefined, name: string): WindowParamResult {
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		return { error: `${name} must be a positive integer` };
	}
	return n;
}

export function isWindowParamError(result: WindowParamResult): result is ParseError {
	return typeof result === "object" && result !== null;
}

export interface WarmBodyParsed {
	readonly conversationId: string;
	readonly model?: string;
	readonly cwd?: string;
}

export function parseWarmBody(body: unknown): WarmBodyParsed | ParseError {
	if (body === null || typeof body !== "object") {
		return { error: "Request body must be a JSON object" };
	}

	const obj = body as Record<string, unknown>;

	const conversationId = obj.conversationId;
	if (typeof conversationId !== "string" || conversationId.length === 0) {
		return { error: "Field 'conversationId' is required and must be a non-empty string" };
	}

	const result: Record<string, unknown> = { conversationId };

	if (obj.model !== undefined) {
		if (typeof obj.model !== "string") {
			return { error: "Field 'model' must be a string" };
		}
		result.model = obj.model;
	}

	if (obj.cwd !== undefined) {
		if (typeof obj.cwd !== "string") {
			return { error: "Field 'cwd' must be a string" };
		}
		result.cwd = obj.cwd;
	}

	return result as unknown as WarmBodyParsed;
}

export function computeCachePct(inputTokens: number, cacheReadTokens: number): number {
	if (inputTokens <= 0) return 0;
	return Math.round(Math.max(0, Math.min(1, cacheReadTokens / inputTokens)) * 100);
}

export function computeExpectedCacheRate(
	cacheReadTokens: number,
	cacheWriteTokens: number,
): number {
	const denom = cacheReadTokens + cacheWriteTokens;
	if (denom <= 0) return 0;
	return Math.round((cacheReadTokens / denom) * 100);
}

/**
 * Parsed body for `POST /conversations/:id/queue` (`QueueRequest`). Only the
 * `text` field — `conversationId` comes from the path param, not the body, so it
 * is deliberately NOT part of this parse result.
 */
export interface QueueBodyParsed {
	readonly text: string;
}

/**
 * Parse + validate a `POST /conversations/:id/queue` body (`QueueRequest`).
 * `text` must be a non-empty string after trim — invalid/missing →
 * {@link ParseError}. The TRIMMED text is returned (forwarded to
 * `orchestrator.enqueue`), mirroring how `parseChatBody` forwards a trimmed
 * `message`.
 */
export function parseQueueBody(body: unknown): QueueBodyParsed | ParseError {
	if (body === null || typeof body !== "object") {
		return { error: "Request body must be a JSON object" };
	}

	const obj = body as Record<string, unknown>;

	const text = obj.text;
	if (typeof text !== "string" || text.trim().length === 0) {
		return { error: "Field 'text' is required and must be a non-empty string" };
	}

	return { text: text.trim() };
}

export function parseReasoningEffortBody(body: unknown): ReasoningEffort | ParseError {
	if (body === null || typeof body !== "object") {
		return { error: "Request body must be a JSON object" };
	}
	const obj = body as Record<string, unknown>;
	if (!isValidReasoningEffort(obj.reasoningEffort)) {
		return {
			error: `Field 'reasoningEffort' is required and must be one of: ${VALID_REASONING_EFFORTS.join(", ")}`,
		};
	}
	return obj.reasoningEffort;
}

export function isReasoningEffortParseError(
	result: ReasoningEffort | ParseError,
): result is ParseError {
	return typeof result === "object" && result !== null && "error" in result;
}

/**
 * Extract the text of the last assistant message's last `text` chunk — the
 * "show me the last reply" affordance for `GET /conversations/:id/last`.
 *
 * Scan from the END for the last message with `role: "assistant"`, then within
 * THAT message for the last `type: "text"` chunk. Returns its `text`. Returns
 * `""` when there is no assistant message, or when the last assistant message
 * has no text chunk (e.g. only tool-call chunks).
 *
 * Pure (input → output); zero I/O, so it tests directly without mocks.
 */
export function extractLastAssistantText(messages: readonly ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg === undefined || msg.role !== "assistant") continue;
		// Found the last assistant message — scan its chunks from the end for
		// the last `text` chunk. Stop here (do not keep scanning earlier
		// assistant messages): the contract is "the last assistant message's
		// last text chunk", not "the most recent text chunk anywhere".
		for (let j = msg.chunks.length - 1; j >= 0; j--) {
			const chunk = msg.chunks[j];
			if (chunk !== undefined && chunk.type === "text") {
				return chunk.text;
			}
		}
		return "";
	}
	return "";
}
