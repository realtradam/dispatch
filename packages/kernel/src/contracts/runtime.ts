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
	 * Optional logger for structured span instrumentation. The runtime opens
	 * turn/step/tool-call spans using this logger. If omitted, no spans are
	 * emitted (backward-compatible with callers that don't yet pass a logger).
	 */
	readonly logger?: Logger;
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
