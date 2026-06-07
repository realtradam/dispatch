import type { StepId } from "../contracts/conversation.js";
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
	stepId: StepId,
	toolCallId: string,
	toolName: string,
	input: unknown,
): AgentEvent {
	return { type: "tool-call", conversationId, turnId, stepId, toolCallId, toolName, input };
}

export function toolResultEvent(
	conversationId: string,
	turnId: string,
	stepId: StepId,
	toolCallId: string,
	toolName: string,
	content: string,
	isError: boolean,
	durationMs?: number,
): AgentEvent {
	const base = {
		type: "tool-result" as const,
		conversationId,
		turnId,
		stepId,
		toolCallId,
		toolName,
		content,
		isError,
	};
	if (durationMs !== undefined) {
		return { ...base, durationMs };
	}
	return base;
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

export function usageEvent(
	conversationId: string,
	turnId: string,
	usage: Usage,
	stepId?: StepId,
): AgentEvent {
	if (stepId !== undefined) {
		return { type: "usage", conversationId, turnId, usage, stepId };
	}
	return { type: "usage", conversationId, turnId, usage };
}

export function turnStartEvent(conversationId: string, turnId: string): AgentEvent {
	return { type: "turn-start", conversationId, turnId };
}

export function stepCompleteEvent(
	conversationId: string,
	turnId: string,
	stepId: StepId,
	timing?: { ttftMs?: number; decodeMs?: number; genTotalMs?: number },
): AgentEvent {
	if (timing !== undefined) {
		if (timing.ttftMs !== undefined) {
			if (timing.decodeMs !== undefined && timing.genTotalMs !== undefined) {
				return {
					type: "step-complete",
					conversationId,
					turnId,
					stepId,
					ttftMs: timing.ttftMs,
					decodeMs: timing.decodeMs,
					genTotalMs: timing.genTotalMs,
				};
			}
			if (timing.genTotalMs !== undefined) {
				return {
					type: "step-complete",
					conversationId,
					turnId,
					stepId,
					ttftMs: timing.ttftMs,
					genTotalMs: timing.genTotalMs,
				};
			}
			return { type: "step-complete", conversationId, turnId, stepId, ttftMs: timing.ttftMs };
		}
		if (timing.genTotalMs !== undefined) {
			return {
				type: "step-complete",
				conversationId,
				turnId,
				stepId,
				genTotalMs: timing.genTotalMs,
			};
		}
	}
	return { type: "step-complete", conversationId, turnId, stepId };
}

export function doneEvent(
	conversationId: string,
	turnId: string,
	reason: string,
	durationMs?: number,
	usage?: Usage,
): AgentEvent {
	if (durationMs !== undefined && usage !== undefined) {
		return { type: "done", conversationId, turnId, reason, durationMs, usage };
	}
	if (durationMs !== undefined) {
		return { type: "done", conversationId, turnId, reason, durationMs };
	}
	if (usage !== undefined) {
		return { type: "done", conversationId, turnId, reason, usage };
	}
	return { type: "done", conversationId, turnId, reason };
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
