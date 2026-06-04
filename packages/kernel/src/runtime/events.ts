import type { AgentEvent } from "../contracts/events.js";
import type { Usage } from "../contracts/provider.js";

export function textDeltaEvent(tabId: string, turnId: string, delta: string): AgentEvent {
	return { type: "text-delta", tabId, turnId, delta };
}

export function reasoningDeltaEvent(tabId: string, turnId: string, delta: string): AgentEvent {
	return { type: "reasoning-delta", tabId, turnId, delta };
}

export function toolCallEvent(
	tabId: string,
	turnId: string,
	toolCallId: string,
	toolName: string,
	input: unknown,
): AgentEvent {
	return { type: "tool-call", tabId, turnId, toolCallId, toolName, input };
}

export function toolResultEvent(
	tabId: string,
	turnId: string,
	toolCallId: string,
	toolName: string,
	content: string,
	isError: boolean,
): AgentEvent {
	return { type: "tool-result", tabId, turnId, toolCallId, toolName, content, isError };
}

export function toolOutputEvent(
	tabId: string,
	turnId: string,
	toolCallId: string,
	data: string,
	stream: "stdout" | "stderr",
): AgentEvent {
	return { type: "tool-output", tabId, turnId, toolCallId, data, stream };
}

export function usageEvent(tabId: string, turnId: string, usage: Usage): AgentEvent {
	return { type: "usage", tabId, turnId, usage };
}

export function errorEvent(
	tabId: string,
	turnId: string,
	message: string,
	code?: string,
): AgentEvent {
	if (code !== undefined) {
		return { type: "error", tabId, turnId, message, code };
	}
	return { type: "error", tabId, turnId, message };
}
