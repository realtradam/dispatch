import type { ChatMessage, Chunk, StepId } from "../contracts/conversation.js";
import type { Logger, Span } from "../contracts/logging.js";
import type { ProviderContract, ProviderEvent, Usage } from "../contracts/provider.js";
import type { EventEmitter, RunTurnInput, RunTurnResult } from "../contracts/runtime.js";
import type { ToolCall, ToolContract } from "../contracts/tool.js";
import { createStepDispatcher, type StepDispatcher } from "./dispatch.js";
import {
	doneEvent,
	errorEvent,
	reasoningDeltaEvent,
	stepCompleteEvent,
	textDeltaEvent,
	toolCallEvent,
	toolResultEvent,
	turnStartEvent,
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
	readonly conversationId: string;
	readonly turnId: string;
	readonly stepId: StepId;
	readonly logger: Logger;
	readonly turnSpan: Span | undefined;
	readonly toolSpans: Map<string, Span>;
	readonly cwd: string | undefined;
	readonly now: (() => number) | undefined;
}

interface TimingState {
	ttftSpan: Span | undefined;
	decodeSpan: Span | undefined;
	firstTokenSeen: boolean;
	streamStartMs: number | undefined;
	firstTokenMs: number | undefined;
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
	stepSpan: Span | undefined,
	timing: TimingState,
	toolDispatchTimes: Map<string, number>,
): void {
	switch (event.type) {
		case "text-delta":
			if (!timing.firstTokenSeen) {
				timing.firstTokenSeen = true;
				if (ctx.now !== undefined) {
					timing.firstTokenMs = ctx.now();
				}
				try {
					timing.ttftSpan?.end({ attrs: { firstToken: true } });
				} catch {
					// Swallow — D7.
				}
				timing.ttftSpan = undefined;
				try {
					timing.decodeSpan = stepSpan?.child("decode");
				} catch {
					// Swallow — D7.
				}
			}
			appendTextDelta(chunks, event.delta);
			ctx.emit(textDeltaEvent(ctx.conversationId, ctx.turnId, event.delta));
			break;
		case "reasoning-delta":
			if (!timing.firstTokenSeen) {
				timing.firstTokenSeen = true;
				if (ctx.now !== undefined) {
					timing.firstTokenMs = ctx.now();
				}
				try {
					timing.ttftSpan?.end({ attrs: { firstToken: true } });
				} catch {
					// Swallow — D7.
				}
				timing.ttftSpan = undefined;
				try {
					timing.decodeSpan = stepSpan?.child("decode");
				} catch {
					// Swallow — D7.
				}
			}
			appendThinkingDelta(chunks, event.delta);
			ctx.emit(reasoningDeltaEvent(ctx.conversationId, ctx.turnId, event.delta));
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
				stepId: ctx.stepId,
			});
			ctx.emit(
				toolCallEvent(
					ctx.conversationId,
					ctx.turnId,
					ctx.stepId,
					event.toolCallId,
					event.toolName,
					event.input,
				),
			);

			// Capture dispatch time for tool-call durationMs
			if (ctx.now !== undefined) {
				toolDispatchTimes.set(event.toolCallId, ctx.now());
			}

			// Open a tool-call span as a child of the step span (attrs: name, toolCallId)
			try {
				const tcSpan =
					stepSpan !== undefined
						? stepSpan.child("tool-call", {
								name: event.toolName,
								toolCallId: event.toolCallId,
							})
						: ctx.logger.span("tool-call", {
								name: event.toolName,
								toolCallId: event.toolCallId,
							});
				ctx.toolSpans.set(event.toolCallId, tcSpan);
			} catch {
				// Swallow — D7: logging never breaks the turn.
			}

			if (ctx.dispatch.eager) {
				dispatcher.submit(call);
			}
			break;
		}
		case "usage":
			ctx.emit(usageEvent(ctx.conversationId, ctx.turnId, event.usage, ctx.stepId));
			break;
		case "finish":
			break;
		case "error":
			if (event.code !== undefined) {
				chunks.push({ type: "error", message: event.message, code: event.code });
			} else {
				chunks.push({ type: "error", message: event.message });
			}
			ctx.emit(errorEvent(ctx.conversationId, ctx.turnId, event.message, event.code));
			break;
	}
}

async function executeStep(ctx: StepContext): Promise<StepResult> {
	const chunks: Chunk[] = [];
	const toolCalls: ToolCall[] = [];
	const toolDispatchTimes = new Map<string, number>();
	let stepUsage = zeroUsage();
	let finishReason = "stop";

	// Open a step span as a child of the turn span; capture the verbatim
	// pre-mutation prompt via a "prompt" child span whose body holds the
	// serialized messages+tools.
	let stepSpan: Span | undefined;
	try {
		stepSpan = ctx.turnSpan !== undefined ? ctx.turnSpan.child("step") : ctx.logger.span("step");
		const promptBody = JSON.stringify({ messages: ctx.messages, tools: ctx.tools });
		const promptSpan = stepSpan.child(
			"prompt",
			{
				messageCount: ctx.messages.length,
				toolCount: ctx.tools.length,
			},
			promptBody,
		);
		promptSpan.end();
	} catch {
		// Swallow — D7.
	}

	const dispatcher = createStepDispatcher(
		ctx.toolMap,
		ctx.dispatch,
		ctx.signal,
		ctx.emit,
		ctx.conversationId,
		ctx.turnId,
		ctx.toolSpans,
		ctx.cwd,
	);

	const timing: TimingState = {
		ttftSpan: undefined,
		decodeSpan: undefined,
		firstTokenSeen: false,
		streamStartMs: ctx.now !== undefined ? ctx.now() : undefined,
		firstTokenMs: undefined,
	};

	// Open TTFT span when spans are enabled
	try {
		if (stepSpan !== undefined) {
			timing.ttftSpan = stepSpan.child("ttft");
		}
	} catch {
		// Swallow — D7.
	}

	try {
		const opts = {
			...(ctx.turnSpan !== undefined && stepSpan !== undefined ? { logger: stepSpan.log } : {}),
		};
		const stream = ctx.provider.stream(ctx.messages, ctx.tools, opts);
		for await (const event of stream) {
			if (ctx.signal.aborted) break;
			processEvent(event, chunks, toolCalls, dispatcher, ctx, stepSpan, timing, toolDispatchTimes);
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
		ctx.emit(errorEvent(ctx.conversationId, ctx.turnId, message));
		finishReason = "error";
		// Close step span with error
		try {
			stepSpan?.end({ err });
		} catch {
			// Swallow — D7.
		}
		stepSpan = undefined;
	}

	// Close timing spans: if no first token was seen, end ttft with firstToken: false
	// If decode span is open, close it
	try {
		if (timing.ttftSpan !== undefined) {
			timing.ttftSpan.end({ attrs: { firstToken: false } });
			timing.ttftSpan = undefined;
		}
		if (timing.decodeSpan !== undefined) {
			timing.decodeSpan.end();
			timing.decodeSpan = undefined;
		}
	} catch {
		// Swallow — D7.
	}

	// Emit step-complete event with timing
	const streamEndMs = ctx.now !== undefined ? ctx.now() : undefined;
	if (timing.streamStartMs !== undefined && streamEndMs !== undefined) {
		const genTotalMs = streamEndMs - timing.streamStartMs;
		const stepTiming: { ttftMs?: number; decodeMs?: number; genTotalMs?: number } = {
			genTotalMs,
		};
		if (timing.firstTokenMs !== undefined) {
			stepTiming.ttftMs = timing.firstTokenMs - timing.streamStartMs;
			stepTiming.decodeMs = streamEndMs - timing.firstTokenMs;
		}
		ctx.emit(stepCompleteEvent(ctx.conversationId, ctx.turnId, ctx.stepId, stepTiming));
	} else {
		ctx.emit(stepCompleteEvent(ctx.conversationId, ctx.turnId, ctx.stepId));
	}

	if (!ctx.dispatch.eager) {
		for (const call of toolCalls) {
			dispatcher.submit(call);
		}
	}

	const results = await dispatcher.drain();

	// Close remaining tool-call spans
	for (const call of toolCalls) {
		const tcSpan = ctx.toolSpans.get(call.id);
		if (tcSpan !== undefined) {
			const result = results.get(call.id);
			try {
				tcSpan.end({
					attrs: {
						isError: result?.isError ?? false,
						contentLength: result?.content.length ?? 0,
					},
				});
			} catch {
				// Swallow — D7.
			}
			ctx.toolSpans.delete(call.id);
		}
	}

	const toolMessages: ChatMessage[] = [];
	for (const call of toolCalls) {
		const result = results.get(call.id);
		if (result !== undefined) {
			const isError = result.isError ?? false;
			const dispatchTime = toolDispatchTimes.get(call.id);
			const toolDurationMs =
				ctx.now !== undefined && dispatchTime !== undefined ? ctx.now() - dispatchTime : undefined;
			ctx.emit(
				toolResultEvent(
					ctx.conversationId,
					ctx.turnId,
					ctx.stepId,
					call.id,
					call.name,
					result.content,
					isError,
					toolDurationMs,
				),
			);
			toolMessages.push({
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: call.id,
						toolName: call.name,
						content: result.content,
						isError,
						stepId: ctx.stepId,
					},
				],
			});
		}
	}

	// Close step span (if not already closed by error)
	if (stepSpan !== undefined) {
		try {
			stepSpan.end({
				attrs: {
					finishReason,
					usage_inputTokens: stepUsage.inputTokens,
					usage_outputTokens: stepUsage.outputTokens,
				},
			});
		} catch {
			// Swallow — D7.
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

	const conversationId = input.conversationId;
	const turnId = input.turnId;
	const signal = input.signal ?? new AbortController().signal;
	const logger = input.logger;
	const now = input.now;

	// Record turn start time for durationMs on done
	const turnStartMs = now !== undefined ? now() : undefined;

	// Open a turn span (attrs: conversationId, turnId, model)
	let turnSpan: Span | undefined;
	if (logger !== undefined) {
		try {
			turnSpan = logger.span("turn", {
				conversationId,
				turnId,
				model: input.providerOpts?.model ?? input.provider.id,
			});
		} catch {
			// Swallow — D7.
		}
	}

	// Track open tool-call spans across steps so we can close them on abort
	const toolSpans = new Map<string, Span>();

	input.emit(turnStartEvent(conversationId, turnId));

	try {
		for (let step = 0; step < MAX_STEPS; step++) {
			if (signal.aborted) {
				finishReason = "aborted";
				break;
			}

			const stepId = `${turnId}#${step}` as StepId;

			const stepResult = await executeStep({
				provider: input.provider,
				messages,
				tools: input.tools,
				toolMap,
				dispatch: input.dispatch,
				emit: input.emit,
				signal,
				conversationId,
				turnId,
				stepId,
				logger: turnSpan?.log ?? logger ?? createNoopLogger(),
				turnSpan,
				toolSpans,
				cwd: input.cwd,
				now,
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
	} finally {
		// Close any orphaned tool-call spans (e.g. abort mid-tool)
		for (const [id, tcSpan] of toolSpans) {
			try {
				tcSpan.end({ attrs: { orphaned: true } });
			} catch {
				// Swallow — D7.
			}
			toolSpans.delete(id);
		}

		// Close the turn span
		if (turnSpan !== undefined) {
			try {
				turnSpan.end({
					attrs: {
						finishReason,
						usage_inputTokens: totalUsage.inputTokens,
						usage_outputTokens: totalUsage.outputTokens,
					},
				});
			} catch {
				// Swallow — D7.
			}
		}
	}

	const turnDurationMs =
		turnStartMs !== undefined && now !== undefined ? now() - turnStartMs : undefined;
	const hasUsage =
		totalUsage.inputTokens > 0 ||
		totalUsage.outputTokens > 0 ||
		totalUsage.cacheReadTokens !== undefined ||
		totalUsage.cacheWriteTokens !== undefined;
	input.emit(
		doneEvent(
			conversationId,
			turnId,
			finishReason,
			turnDurationMs,
			hasUsage ? totalUsage : undefined,
		),
	);

	return { messages: resultMessages, usage: totalUsage, finishReason };
}

function createNoopLogger(): Logger {
	return {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return createNoopLogger();
		},
		span() {
			return {
				id: "noop",
				log: createNoopLogger(),
				setAttributes() {},
				addLink() {},
				child() {
					return this;
				},
				end() {},
			};
		},
	};
}
