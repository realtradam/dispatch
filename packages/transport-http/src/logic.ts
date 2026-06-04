import type { AgentEvent } from "@dispatch/kernel";

export interface ChatCommand {
	readonly conversationId: string;
	readonly message: string;
}

export interface ParseError {
	readonly error: string;
}

export type ParseResult = ChatCommand | ParseError;

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

	return { conversationId, message: message.trim() };
}

export function isParseError(result: ParseResult): result is ParseError {
	return "error" in result;
}

export function serializeEventLine(event: AgentEvent): string {
	return `${JSON.stringify(event)}\n`;
}
