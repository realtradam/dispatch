/**
 * Runtime contracts — the input/output types for `runTurn`.
 *
 * The kernel's turn loop is a pure function of these inputs. It takes
 * messages as a plain input, returns result messages, and touches no DB.
 * The implementation lives in the kernel runtime module; these types are
 * the contract the session-orchestrator (core) programs against.
 */

import type { ChatMessage } from "./conversation.js";
import type { ToolDispatchPolicy } from "./dispatch.js";
import type { AgentEvent } from "./events.js";
import type { Logger } from "./logging.js";
import type { ProviderContract, ProviderStreamOptions, Usage } from "./provider.js";
import type { ToolContract } from "./tool.js";

/**
 * The emitter function the kernel calls to push events outward.
 * The session-orchestrator provides this, wiring it to transport + persistence.
 */
export type EventEmitter = (event: AgentEvent) => void;

/**
 * Why a turn ended. Known kernel/provider reasons are enumerated for ergonomics;
 * the trailing `(string & {})` keeps the type open for provider-specific reasons
 * passed through verbatim without losing autocomplete on the known values.
 */
export type FinishReason =
	| "stop"
	| "tool-calls"
	| "length"
	| "content-filter"
	| "max-steps"
	| "error"
	| "aborted"
	| (string & {});

/**
 * Input to `runTurn` — everything the kernel needs to execute one turn.
 * All fields are resolved by the session-orchestrator before calling;
 * the kernel never reads config or resolves providers/tools itself.
 */
export interface RunTurnInput {
	/** The resolved provider to stream from. */
	readonly provider: ProviderContract;

	/** The conversation history (including system prompt as first message). */
	readonly messages: readonly ChatMessage[];

	/** The tool set available for this turn (may be empty). */
	readonly tools: readonly ToolContract[];

	/** How to dispatch tool calls within each step. */
	readonly dispatch: ToolDispatchPolicy;

	/** The emitter the kernel calls for each outward event. */
	readonly emit: EventEmitter;

	/**
	 * Identifiers used to attribute every emitted `AgentEvent`. The kernel does
	 * not generate these — the session-orchestrator owns turn/conversation identity
	 * and passes them in, so events are traceable to their conversation.
	 */
	readonly conversationId: string;
	readonly turnId: string;

	/**
	 * Optional per-turn provider options (model, temperature, maxTokens,
	 * systemPrompt). The orchestrator resolves these; the kernel forwards them
	 * verbatim to `provider.stream` and never interprets them. A provider may
	 * also be pre-configured at construction and ignore these.
	 */
	readonly providerOpts?: ProviderStreamOptions;

	/** Cancellation signal for the entire turn. */
	readonly signal?: AbortSignal;

	/**
	 * Working directory for this turn's tool execution. The kernel does NOT
	 * interpret it — it forwards the value verbatim to each `ToolExecuteContext.cwd`
	 * so tools resolve/contain paths against it. It never enters the model prompt,
	 * so it does not affect prompt caching. When omitted, tools fall back to their
	 * own configured/default workdir.
	 */
	readonly cwd?: string;

	/**
	 * The computer to execute this turn's tools on (SSH support). Omitted/undefined
	 * = LOCAL (today's behavior). When set, it is an SSH config alias; the kernel
	 * does NOT interpret it — it forwards the value verbatim to each
	 * `ToolExecuteContext.computerId`, exactly like `cwd`. It never enters the
	 * model prompt, so it does not affect prompt caching. Tools resolve their
	 * execution backend (local vs. remote) from this; see
	 * `notes/ssh-support-plan.md`.
	 */
	readonly computerId?: string;

	/**
	 * Optional logger for structured span instrumentation. The runtime opens
	 * turn/step/tool-call spans using this logger. If omitted, no spans are
	 * emitted (backward-compatible with callers that don't yet pass a logger).
	 */
	readonly logger?: Logger;

	/**
	 * Optional monotonic-ish clock (milliseconds) for emitting wall-clock timing
	 * on outward events: per-step `step-complete` (ttft/decode/genTotal), tool
	 * execution `durationMs` on `tool-result`, and turn `durationMs` on `done`.
	 * Injected (not ambient) so the runtime stays pure and deterministic in tests.
	 * If omitted, the runtime emits no such timing (the optional fields stay
	 * absent) — backward-compatible with callers that don't provide a clock.
	 */
	readonly now?: () => number;

	/**
	 * Optional. Called by the runtime at the tool-result boundary — after a
	 * step whose tool calls have all executed, before the next step begins —
	 * to drain messages to inject alongside the tool results. Whatever it
	 * returns is appended as user-role messages to the next step's input, so
	 * a caller can inject mid-turn guidance the model sees with the tool
	 * results. When omitted or returning an empty array, no injection happens
	 * (the runtime is unchanged).
	 *
	 * Injected (not ambient) so the kernel stays pure: it owns no queue and
	 * names no feature — it just calls the callback and appends what it gets.
	 * Only invoked when a step PRODUCED tool calls (the tool-result boundary);
	 * a step that ends without tool calls does not drain (the caller decides
	 * what to do with any pending messages after the turn ends).
	 */
	readonly drainSteering?: () => readonly ChatMessage[];

	/**
	 * Optional. Called by the runtime after each step's messages are finalized
	 * (the assistant message + tool-result messages are built). The caller can
	 * use this to persist step messages incrementally — assigning seq numbers
	 * during generation so consumers can `GET /conversations/:id?sinceSeq=N`
	 * mid-turn. When omitted, the caller must persist all messages at turn end
	 * (via `RunTurnResult.messages`). The messages passed to this callback are
	 * the SAME objects in `RunTurnResult.messages` — the caller must NOT
	 * double-persist them.
	 */
	readonly onStepComplete?: (messages: readonly ChatMessage[]) => Promise<void> | void;

	/**
	 * Optional injected retry strategy for retryable provider errors (e.g. HTTP
	 * 429 / 5xx "overloaded"). When omitted, a retryable error ends the step
	 * exactly as before (backward-compatible). When provided, the runtime wraps
	 * `provider.stream()` consumption in a retry loop: on a retryable error
	 * (an emitted `error` ProviderEvent with `retryable === true`, OR a thrown
	 * error) — ONLY when no content was emitted yet this step (the safety
	 * invariant — never duplicate partial output) — it asks `retry.delayFor`
	 * for a delay, emits a transient `provider-retry` AgentEvent, sleeps via the
	 * injected `retry.sleep` (abortable), and re-calls `provider.stream()`.
	 *
	 * Injected (not ambient): the kernel imports no timer and owns no schedule.
	 * Mirrors the `now`/`logger` injection pattern — optional + backward-compatible.
	 */
	readonly retry?: RetryStrategy;
}

/**
 * The result of a completed turn. The session-orchestrator uses this to
 * persist the new messages and report usage.
 */
export interface RunTurnResult {
	/** The assistant messages produced by this turn (appended to history). */
	readonly messages: readonly ChatMessage[];

	/** Aggregated token usage across all steps in the turn. */
	readonly usage: Usage;

	/** Why the turn ended. */
	readonly finishReason: FinishReason;
}

/**
 * Injected retry strategy for retryable provider errors (e.g. HTTP 429 / 5xx).
 *
 * The kernel provides the HOOK (this contract + the retry loop in `runTurn`);
 * the shell (session-orchestrator) provides the POLICY (the concrete schedule)
 * and the I/O (the actual sleep). The kernel imports no timer — `sleep` is an
 * injected effect so the runtime stays pure and deterministic in tests.
 *
 * Retries are ONLY attempted when NO content was emitted yet this step (the
 * safety invariant — never duplicate partial output). When omitted on
 * `RunTurnInput`, no retry happens (backward-compatible: a retryable error ends
 * the step exactly as before).
 */
export interface RetryStrategy {
	/**
	 * Pure, deterministic decision: given the 0-based attempt index, return the
	 * delay in ms to sleep before the next retry, or `undefined` to stop (budget
	 * exhausted). No I/O, no clock — fully testable.
	 */
	readonly delayFor: (attempt: number) => number | undefined;
	/**
	 * Injected effect: actually sleep for the given ms. Must honor the abort
	 * signal — reject when aborted so the turn seals `aborted`. The kernel
	 * imports no timer; the shell provides a `setTimeout`-based implementation.
	 */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}
