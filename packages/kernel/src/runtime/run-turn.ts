import type { ChatMessage, Chunk } from "../contracts/conversation.js";
import type { ProviderContract, ProviderEvent, Usage } from "../contracts/provider.js";
import type { EventEmitter, RunTurnInput, RunTurnResult } from "../contracts/runtime.js";
import type { ToolCall, ToolContract } from "../contracts/tool.js";
import { createStepDispatcher, type StepDispatcher } from "./dispatch.js";
import {
	errorEvent,
	reasoningDeltaEvent,
	textDeltaEvent,
	toolCallEvent,
	toolResultEvent,
	usageEvent,
} from "./events.js";

export const MAX_STEPS = 50;

function zeroUsage(): Usage {
	return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
	const inputTokens = a.inputTokens + b.inputTokens;
	const outputTokens = a.outputTokens + b.outputTokens;

	if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
		const cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
		if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
			return {
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
			};
		}
		return { inputTokens, outputTokens, cacheReadTokens };
	}

	if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
		return {
			inputTokens,
			outputTokens,
			cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
		};
	}

	return { inputTokens, outputTokens };
}

function appendTextDelta(chunks: Chunk[], delta: string): void {
	const lastIdx = chunks.length - 1;
	const last = chunks[lastIdx];
	if (last !== undefined && last.type === "text") {
		chunks[lastIdx] = { type: "text", text: last.text + delta };
	} else {
		chunks.push({ type: "text", text: delta });
	}
}

function appendThinkingDelta(chunks: Chunk[], delta: string): void {
	const lastIdx = chunks.length - 1;
	const last = chunks[lastIdx];
	if (last !== undefined && last.type === "thinking") {
		chunks[lastIdx] = { type: "thinking", text: last.text + delta };
	} else {
		chunks.push({ type: "thinking", text: delta });
	}
}

interface StepContext {
	readonly provider: ProviderContract;
	readonly messages: ChatMessage[];
	readonly tools: readonly ToolContract[];
	readonly toolMap: Map<string, ToolContract>;
	readonly dispatch: RunTurnInput["dispatch"];
	readonly emit: EventEmitter;
	readonly signal: AbortSignal;
	readonly tabId: string;
	readonly turnId: string;
}

interface StepResult {
	readonly assistantMessage: ChatMessage | undefined;
	readonly toolCalls: ToolCall[];
	readonly toolMessages: ChatMessage[];
	readonly usage: Usage;
	readonly finishReason: string;
}

function processEvent(
	event: ProviderEvent,
	chunks: Chunk[],
	toolCalls: ToolCall[],
	dispatcher: StepDispatcher,
	ctx: StepContext,
): void {
	switch (event.type) {
		case "text-delta":
			appendTextDelta(chunks, event.delta);
			ctx.emit(textDeltaEvent(ctx.tabId, ctx.turnId, event.delta));
			break;
		case "reasoning-delta":
			appendThinkingDelta(chunks, event.delta);
			ctx.emit(reasoningDeltaEvent(ctx.tabId, ctx.turnId, event.delta));
			break;
		case "tool-call": {
			const call: ToolCall = {
				id: event.toolCallId,
				name: event.toolName,
				input: event.input,
			};
			toolCalls.push(call);
			chunks.push({
				type: "tool-call",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input: event.input,
			});
			ctx.emit(toolCallEvent(ctx.tabId, ctx.turnId, event.toolCallId, event.toolName, event.input));
			if (ctx.dispatch.eager) {
				dispatcher.submit(call);
			}
			break;
		}
		case "usage":
			ctx.emit(usageEvent(ctx.tabId, ctx.turnId, event.usage));
			break;
		case "finish":
			break;
		case "error":
			if (event.code !== undefined) {
				chunks.push({ type: "error", message: event.message, code: event.code });
			} else {
				chunks.push({ type: "error", message: event.message });
			}
			ctx.emit(errorEvent(ctx.tabId, ctx.turnId, event.message, event.code));
			break;
	}
}

async function executeStep(ctx: StepContext): Promise<StepResult> {
	const chunks: Chunk[] = [];
	const toolCalls: ToolCall[] = [];
	let stepUsage = zeroUsage();
	let finishReason = "stop";

	const dispatcher = createStepDispatcher(
		ctx.toolMap,
		ctx.dispatch,
		ctx.signal,
		ctx.emit,
		ctx.tabId,
		ctx.turnId,
	);

	try {
		const stream = ctx.provider.stream(ctx.messages, ctx.tools);
		for await (const event of stream) {
			if (ctx.signal.aborted) break;
			processEvent(event, chunks, toolCalls, dispatcher, ctx);
			if (event.type === "usage") {
				stepUsage = addUsage(stepUsage, event.usage);
			}
			if (event.type === "finish") {
				finishReason = event.reason;
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		chunks.push({ type: "error", message });
		ctx.emit(errorEvent(ctx.tabId, ctx.turnId, message));
		finishReason = "error";
	}

	if (!ctx.dispatch.eager) {
		for (const call of toolCalls) {
			dispatcher.submit(call);
		}
	}

	const results = await dispatcher.drain();

	const toolMessages: ChatMessage[] = [];
	for (const call of toolCalls) {
		const result = results.get(call.id);
		if (result !== undefined) {
			const isError = result.isError ?? false;
			ctx.emit(toolResultEvent(ctx.tabId, ctx.turnId, call.id, call.name, result.content, isError));
			toolMessages.push({
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: call.id,
						toolName: call.name,
						content: result.content,
						isError,
					},
				],
			});
		}
	}

	const assistantMessage: ChatMessage | undefined =
		chunks.length > 0 ? { role: "assistant", chunks } : undefined;

	return { assistantMessage, toolCalls, toolMessages, usage: stepUsage, finishReason };
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
	const messages: ChatMessage[] = [...input.messages];
	const resultMessages: ChatMessage[] = [];
	let totalUsage = zeroUsage();
	let finishReason = "stop";

	const toolMap = new Map<string, ToolContract>();
	for (const tool of input.tools) {
		toolMap.set(tool.name, tool);
	}

	const tabId = input.tabId;
	const turnId = input.turnId;
	const signal = input.signal ?? new AbortController().signal;

	for (let step = 0; step < MAX_STEPS; step++) {
		if (signal.aborted) {
			finishReason = "aborted";
			break;
		}

		const stepResult = await executeStep({
			provider: input.provider,
			messages,
			tools: input.tools,
			toolMap,
			dispatch: input.dispatch,
			emit: input.emit,
			signal,
			tabId,
			turnId,
		});

		totalUsage = addUsage(totalUsage, stepResult.usage);

		if (stepResult.assistantMessage !== undefined) {
			messages.push(stepResult.assistantMessage);
			resultMessages.push(stepResult.assistantMessage);
		}

		for (const msg of stepResult.toolMessages) {
			messages.push(msg);
			resultMessages.push(msg);
		}

		if (signal.aborted) {
			finishReason = "aborted";
			break;
		}

		if (stepResult.toolCalls.length === 0) {
			finishReason = stepResult.finishReason;
			break;
		}

		if (step === MAX_STEPS - 1) {
			finishReason = "max-steps";
		}
	}

	return { messages: resultMessages, usage: totalUsage, finishReason };
}
