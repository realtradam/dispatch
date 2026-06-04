import type { AgentEvent } from "../contracts/events.js";
import type { Usage } from "../contracts/provider.js";

export function textDeltaEvent(conversationId: string, turnId: string, delta: string): AgentEvent {
	return { type: "text-delta", conversationId, turnId, delta };
}

export function reasoningDeltaEvent(
	conversationId: string,
	turnId: string,
	delta: string,
): AgentEvent {
	return { type: "reasoning-delta", conversationId, turnId, delta };
}

export function toolCallEvent(
	conversationId: string,
	turnId: string,
	toolCallId: string,
	toolName: string,
	input: unknown,
): AgentEvent {
	return { type: "tool-call", conversationId, turnId, toolCallId, toolName, input };
}

export function toolResultEvent(
	conversationId: string,
	turnId: string,
	toolCallId: string,
	toolName: string,
	content: string,
	isError: boolean,
): AgentEvent {
	return { type: "tool-result", conversationId, turnId, toolCallId, toolName, content, isError };
}

export function toolOutputEvent(
	conversationId: string,
	turnId: string,
	toolCallId: string,
	data: string,
	stream: "stdout" | "stderr",
): AgentEvent {
	return { type: "tool-output", conversationId, turnId, toolCallId, data, stream };
}

export function usageEvent(conversationId: string, turnId: string, usage: Usage): AgentEvent {
	return { type: "usage", conversationId, turnId, usage };
}

export function errorEvent(
	conversationId: string,
	turnId: string,
	message: string,
	code?: string,
): AgentEvent {
	if (code !== undefined) {
		return { type: "error", conversationId, turnId, message, code };
	}
	return { type: "error", conversationId, turnId, message };
}
