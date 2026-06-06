/**
 * Provider contract — how an LLM backend plugs into the kernel.
 *
 * The kernel is provider-agnostic: it knows only this streaming interface and
 * the event taxonomy. A provider extension wraps a concrete LLM API and
 * translates its responses into `ProviderEvent`s.
 */

import type { Usage } from "@dispatch/wire";
import type { ChatMessage } from "./conversation.js";
import type { Logger } from "./logging.js";
import type { ToolContract } from "./tool.js";

export type { Usage } from "@dispatch/wire";

/**
 * Events a provider yields during a single `stream` call. The kernel consumes
 * these to drive tool dispatch, build chunks, and emit outward `AgentEvent`s.
 * Discriminated by `type`.
 */
export type ProviderEvent =
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ProviderToolCallEvent
	| UsageEvent
	| FinishEvent
	| ProviderErrorEvent;

/** Incremental text content from the model. */
export interface TextDeltaEvent {
	readonly type: "text-delta";
	readonly delta: string;
}

/** Incremental reasoning / thinking content from the model. */
export interface ReasoningDeltaEvent {
	readonly type: "reasoning-delta";
	readonly delta: string;
}

/**
 * A complete tool-call parsed by the provider. The kernel uses `name` to
 * dispatch to the matching `ToolContract`.
 */
export interface ProviderToolCallEvent {
	readonly type: "tool-call";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

/** Token usage report, typically emitted at step end. */
export interface UsageEvent {
	readonly type: "usage";
	readonly usage: Usage;
}

/**
 * Signals the end of a step. `reason` indicates why the model stopped
 * generating (e.g. "stop", "tool-calls", "length", "content-filter").
 */
export interface FinishEvent {
	readonly type: "finish";
	readonly reason: string;
}

/** An error from the provider (network, rate-limit, model error, etc.). */
export interface ProviderErrorEvent {
	readonly type: "error";
	readonly message: string;
	readonly code?: string;
	readonly retryable?: boolean;
}

/**
 * Options passed to a provider's `stream` method beyond messages and tools.
 * Kept minimal — providers may ignore fields they don't support.
 */
export interface ProviderStreamOptions {
	/** Model identifier to use. */
	readonly model?: string;
	/** Sampling temperature override. */
	readonly temperature?: number;
	/** Maximum output tokens override. */
	readonly maxTokens?: number;
	/** System prompt to prepend. */
	readonly systemPrompt?: string;
	/**
	 * Correlated logger for this turn's step (Phase A logging ABI). When present,
	 * the provider should open a child `provider.request` span and capture the
	 * verbatim post-transform request + raw response/error there, self-redacting
	 * secrets in its own code. Optional so non-instrumented callers/tests still
	 * compile (the provider falls back to no capture).
	 */
	readonly logger?: Logger;
}

/**
 * Metadata describing a single model a provider can serve. Returned by
 * `listModels` so a catalog (e.g. the credential-store) can enumerate the
 * `<credentialName>/<model>` choices a client may select. Kept minimal — `id`
 * is the wire model identifier; `displayName` is an optional human label.
 */
export interface ModelInfo {
	readonly id: string;
	readonly displayName?: string;
}

/**
 * What a provider extension registers with the kernel. The kernel calls
 * `stream` and consumes the async iterable of events — it never knows which
 * concrete LLM API is behind it.
 */
export interface ProviderContract {
	/** Unique identifier for this provider (e.g. "anthropic", "openai-compat"). */
	readonly id: string;

	/**
	 * Stream a response for the given messages and available tools.
	 * The provider yields `ProviderEvent`s incrementally; the kernel drives
	 * tool dispatch and chunk assembly from them.
	 */
	readonly stream: (
		messages: readonly ChatMessage[],
		tools: readonly ToolContract[],
		opts?: ProviderStreamOptions,
	) => AsyncIterable<ProviderEvent>;

	/**
	 * Enumerate the models this provider can serve, each in its own way (e.g. an
	 * OpenAI-compatible provider GETs `/v1/models`). Optional: a provider that
	 * cannot (or chooses not to) enumerate omits it, and a catalog simply lists
	 * none for it. A future multi-credential design may pass per-credential
	 * credentials in; today the provider uses the key it resolved at activate.
	 */
	readonly listModels?: () => Promise<readonly ModelInfo[]>;
}
