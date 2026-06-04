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
import type { ProviderContract, Usage } from "./provider.js";
import type { ToolContract } from "./tool.js";

/**
 * The emitter function the kernel calls to push events outward.
 * The session-orchestrator provides this, wiring it to transport + persistence.
 */
export type EventEmitter = (event: AgentEvent) => void;

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

	/** Cancellation signal for the entire turn. */
	readonly signal?: AbortSignal;
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

	/** Why the turn ended (e.g. "stop", "max-steps", "error", "aborted"). */
	readonly finishReason: string;
}
