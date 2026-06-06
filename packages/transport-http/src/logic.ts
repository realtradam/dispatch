import type { AgentEvent } from "@dispatch/kernel";

export interface ChatCommand {
	readonly conversationId: string;
	readonly message: string;
	readonly model?: string;
	readonly cwd?: string;
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

	return result;
}

export function isParseError(result: ParseResult): result is ParseError {
	return "error" in result;
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
