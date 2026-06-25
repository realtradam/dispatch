import type { ChatMessage, Chunk, StepId } from "../contracts/conversation.js";
import type { Logger, Span } from "../contracts/logging.js";
import type {
	ProviderContract,
	ProviderEvent,
	ProviderStreamOptions,
	Usage,
} from "../contracts/provider.js";
import type {
	EventEmitter,
	RetryStrategy,
	RunTurnInput,
	RunTurnResult,
} from "../contracts/runtime.js";
import type { ToolCall, ToolContract } from "../contracts/tool.js";
import { createStepDispatcher, type StepDispatcher } from "./dispatch.js";
import {
	doneEvent,
	errorEvent,
	providerRetryEvent,
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

function usageAttrs(usage: Usage): Record<string, string | number | boolean | null> {
	const attrs: Record<string, string | number | boolean | null> = {
		"usage.inputTokens": usage.inputTokens,
		"usage.outputTokens": usage.outputTokens,
	};
	if (usage.cacheReadTokens !== undefined) {
		attrs["usage.cacheReadTokens"] = usage.cacheReadTokens;
	}
	if (usage.cacheWriteTokens !== undefined) {
		attrs["usage.cacheWriteTokens"] = usage.cacheWriteTokens;
	}
	return attrs;
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

/**
 * Remove tool-call chunks from an assistant message, returning a new message
 * with only the non-tool-call chunks (text, thinking, error). Returns
 * `undefined` when all chunks were tool-calls (so the caller can omit the
 * message entirely). Used when a step is aborted to avoid persisting
 * incomplete tool calls whose placeholder "Aborted" results would create
 * orphaned `tool` messages in the next turn's history.
 */
function stripToolCallChunks(msg: ChatMessage): ChatMessage | undefined {
	const stripped = msg.chunks.filter((c) => c.type !== "tool-call");
	return stripped.length > 0 ? { role: msg.role, chunks: stripped } : undefined;
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
	readonly computerId: string | undefined;
	readonly now: (() => number) | undefined;
	/** Per-turn provider options (model, systemPrompt, …) threaded to stream(). */
	readonly providerOpts: ProviderStreamOptions | undefined;
	/** Optional injected retry strategy (omit = no retry, backward-compatible). */
	readonly retry: RetryStrategy | undefined;
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
			// Handled by the retry loop in executeStep (not here): an error event
			// is intercepted before processEvent so the step can decide whether to
			// retry (suppressing the error) or give up (emit it). processEvent
			// never receives an "error" event.
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
		ctx.computerId,
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

	// Retry loop: wrap provider.stream() consumption. Retries are ONLY
	// attempted when no content was emitted yet this step (the safety
	// invariant — never duplicate partial output). On a retryable error —
	// either an EMITTED `error` ProviderEvent with `retryable === true`, OR a
	// THROWN error (retryable-by-default when pre-content) — with !hadContent:
	// ask retry.delayFor(attempt); if it returns a delay → emit a transient
	// provider-retry AgentEvent, sleep via the injected retry.sleep (abortable),
	// attempt++, re-call provider.stream(); if it returns undefined (budget
	// exhausted) → give up. Non-retryable emitted errors (retryable === false or
	// absent), errors after content, and the no-retry-configured case all fall
	// through to "give up" — identical to the pre-retry behavior.
	let hadContent = false;
	let attempt = 0;
	while (true) {
		let errored = false;
		let wasThrown = false;
		let errorMessage: string | undefined;
		let errorCode: string | undefined;
		let errorRetryable: boolean | undefined;
		let thrownErr: unknown;

		try {
			const opts: ProviderStreamOptions = {
				...ctx.providerOpts,
				...(ctx.turnSpan !== undefined && stepSpan !== undefined ? { logger: stepSpan.log } : {}),
			};
			const stream = ctx.provider.stream(ctx.messages, ctx.tools, opts);
			for await (const event of stream) {
				if (ctx.signal.aborted) break;
				if (event.type === "error") {
					// Intercept: hold for the retry decision — don't push a chunk
					// or emit yet (a successful retry would leave a stale error).
					errored = true;
					errorMessage = event.message;
					errorCode = event.code;
					errorRetryable = event.retryable;
					break;
				}
				if (
					event.type === "text-delta" ||
					event.type === "reasoning-delta" ||
					event.type === "tool-call" ||
					event.type === "usage"
				) {
					hadContent = true;
				}
				processEvent(
					event,
					chunks,
					toolCalls,
					dispatcher,
					ctx,
					stepSpan,
					timing,
					toolDispatchTimes,
				);
				if (event.type === "usage") {
					stepUsage = addUsage(stepUsage, event.usage);
				}
				if (event.type === "finish") {
					finishReason = event.reason;
				}
			}
		} catch (err) {
			errored = true;
			wasThrown = true;
			errorMessage = err instanceof Error ? err.message : String(err);
			errorCode = undefined;
			errorRetryable = undefined;
			thrownErr = err;
		}

		// Abort (during stream) → stop; the runTurn loop seals aborted.
		if (ctx.signal.aborted) {
			break;
		}

		// No error → step succeeded.
		if (!errored) {
			break;
		}

		// Retryable? A thrown error is retryable-by-default when pre-content;
		// an emitted error is retryable ONLY when `retryable === true` (absent
		// or false → not retried, per the contract).
		const isRetryable = wasThrown ? true : errorRetryable === true;
		if (ctx.retry !== undefined && !hadContent && isRetryable) {
			const delay = ctx.retry.delayFor(attempt);
			if (delay !== undefined) {
				// Emit the transient provider-retry event BEFORE the sleep so the
				// UI shows "⚠ retrying in Ns…" immediately. Not persisted as a
				// chat message — it never pollutes the prompt.
				ctx.emit(
					providerRetryEvent(
						ctx.conversationId,
						ctx.turnId,
						attempt,
						delay,
						errorMessage ?? "",
						errorCode,
					),
				);
				// Abortable sleep. If the signal fires during sleep, the shell's
				// sleep rejects — we catch it and break so the turn seals aborted.
				try {
					await ctx.retry.sleep(delay, ctx.signal);
				} catch {
					// Abort during sleep (or unexpected sleep failure).
				}
				if (ctx.signal.aborted) {
					break;
				}
				attempt++;
				continue;
			}
			// delayFor returned undefined → budget exhausted → give up.
		}

		// Give up: emit the suppressed error and end the step. This is the
		// single emission point for a terminal provider error (non-retryable,
		// post-content, budget-exhausted, or no-retry-configured).
		const message = errorMessage ?? "";
		if (errorCode !== undefined) {
			chunks.push({ type: "error", message, code: errorCode });
		} else {
			chunks.push({ type: "error", message });
		}
		ctx.emit(errorEvent(ctx.conversationId, ctx.turnId, message, errorCode));
		finishReason = "error";
		try {
			stepSpan?.end({ err: thrownErr ?? new Error(message) });
		} catch {
			// Swallow — D7.
		}
		stepSpan = undefined;
		break;
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
					...usageAttrs(stepUsage),
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
	let lastStepUsage: Usage | undefined;
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
				computerId: input.computerId,
				now,
				providerOpts: input.providerOpts,
				retry: input.retry,
			});

			totalUsage = addUsage(totalUsage, stepResult.usage);
			lastStepUsage = stepResult.usage;

			// When the signal is aborted mid-step, the tool results are
			// placeholders ({ content: "Aborted", isError: true }). If these
			// are persisted and included in the next turn's message history,
			// the provider sees a `tool` role message without a preceding
			// `assistant` message carrying `tool_calls` → 400 error.
			//
			// To prevent this, when the signal is aborted we:
			//  1. Strip tool-call chunks from the assistant message (keep
			//     text/thinking/error chunks so the partial response is
			//     preserved).
			//  2. Omit tool-result messages entirely (they are not persisted,
			//     not added to resultMessages, and not passed to onStepComplete).
			//
			// This keeps the conversation history clean: the assistant's
			// partial text is preserved, but no incomplete tool calls are
			// left dangling. The `done` event still carries
			// `reason: "aborted"`, so the turn seals cleanly.
			const stepAborted = signal.aborted;
			const assistantMessage =
				stepAborted && stepResult.assistantMessage !== undefined
					? stripToolCallChunks(stepResult.assistantMessage)
					: stepResult.assistantMessage;
			const toolMessages = stepAborted ? [] : stepResult.toolMessages;

			if (assistantMessage !== undefined) {
				messages.push(assistantMessage);
				resultMessages.push(assistantMessage);
			}

			for (const msg of toolMessages) {
				messages.push(msg);
				resultMessages.push(msg);
			}

			// Incremental persistence: notify the caller that this step's
			// messages are finalized. The caller can persist them immediately
			// (assigning seq numbers during generation). The messages are the
			// SAME objects in resultMessages — the caller must NOT double-persist.
			if (input.onStepComplete !== undefined) {
				const stepMessages: ChatMessage[] = [];
				if (assistantMessage !== undefined) {
					stepMessages.push(assistantMessage);
				}
				for (const msg of toolMessages) {
					stepMessages.push(msg);
				}
				if (stepMessages.length > 0) {
					await input.onStepComplete(stepMessages);
				}
			}

			if (stepAborted) {
				finishReason = "aborted";
				break;
			}

			if (stepResult.toolCalls.length === 0) {
				finishReason = stepResult.finishReason;
				break;
			}

			if (step === MAX_STEPS - 1) {
				finishReason = "max-steps";
				// No next step → no tool-result boundary. Leave any pending
				// steering messages for the caller (it owns the queue).
			} else {
				// Tool-result boundary: this step produced tool calls and we are
				// about to call provider.stream again. Drain steering messages
				// and append them after the tool results, before the next call.
				// The kernel owns no queue and names no feature — it just calls
				// the callback and appends. Emits nothing (caller emits the
				// `steering` AgentEvent in its own wrapper).
				const steering = input.drainSteering?.() ?? [];
				for (const msg of steering) {
					messages.push(msg);
				}
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
						...usageAttrs(totalUsage),
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
	const contextSize =
		hasUsage && lastStepUsage !== undefined
			? lastStepUsage.inputTokens + lastStepUsage.outputTokens
			: undefined;
	input.emit(
		doneEvent(
			conversationId,
			turnId,
			finishReason,
			turnDurationMs,
			hasUsage ? totalUsage : undefined,
			contextSize,
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
