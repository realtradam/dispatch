/**
 * Provider contract — how an LLM backend plugs into the kernel.
 *
 * The kernel is provider-agnostic: it knows only this streaming interface and
 * the event taxonomy. A provider extension wraps a concrete LLM API and
 * translates its responses into `ProviderEvent`s.
 */

import type { ReasoningEffort, Usage } from "@dispatch/wire";
import type { ChatMessage } from "./conversation.js";
import { defineEventHook, type EventHookDescriptor } from "./hooks.js";
import type { Logger } from "./logging.js";
import type { ToolContract } from "./tool.js";

export type { ReasoningEffort, Usage } from "@dispatch/wire";

/**
 * Events a provider yields during a single `stream` call. The kernel consumes
 * these to drive tool dispatch, build chunks, and emit outward `AgentEvent`s.
 * Discriminated by `type`.
 */
export type ProviderEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ProviderToolCallEvent
  | ToolCallStartEvent
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
 * End of one reasoning block, carrying opaque payloads for verbatim replay.
 * Optional: providers without signed reasoning never need to emit this event.
 * Closes the current reasoning chunk even when neither payload is present.
 * Produces no outward event and is not a first-token marker.
 */
export interface ReasoningEndEvent {
  readonly type: "reasoning-end";
  readonly signature?: string;
  readonly redactedData?: string;
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

/**
 * The model has STARTED streaming a tool call (its name / first argument
 * bytes arrived). Timing-only: carries no content and produces no chunk or
 * outward event — the complete call still arrives as a `tool-call` event.
 * Lets the runtime mark a step's first output token when the step's output is
 * tool calls only (providers that buffer a call until the step finishes would
 * otherwise report no time-to-first-token / decode time for such a step).
 * Optional for providers: one that never emits it just loses that precision.
 */
export interface ToolCallStartEvent {
  readonly type: "tool-call-start";
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
  /**
   * Cancellation signal for this turn (the authoritative `RunTurnInput.signal`
   * for active-turn calls). Providers MUST forward it to abort-capable upstream
   * I/O (e.g. `fetch(..., { signal })` / a body reader), stop producing events
   * after it aborts, and clean up response readers/resources. They MUST NOT
   * convert a deliberate turn abort into an ordinary retryable provider failure.
   *
   * Optional so manual/background callers and tests compile unchanged. Callers
   * may still defensively stop consuming a non-compliant provider even if it
   * ignores this field.
   */
  readonly signal?: AbortSignal;
  /** Model identifier to use. */
  readonly model?: string;
  /** Sampling temperature override. */
  readonly temperature?: number;
  /** Maximum output tokens override. */
  readonly maxTokens?: number;
  /** System prompt to prepend. */
  readonly systemPrompt?: string;
  /**
   * Reasoning-effort level for this request (already RESOLVED by the caller —
   * the session-orchestrator applies the request → conversation → `"high"`
   * default chain, so a provider receiving `undefined` may treat it as "no
   * preference"). The provider maps the level to its native thinking knob in
   * its own code; providers without such a knob ignore it.
   */
  readonly reasoningEffort?: ReasoningEffort;
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
 * A snapshot of the provider's current upstream usage. Returned by a
 * provider's optional `getUsage` so a concurrency limiter can gate slot grants
 * on the REAL upstream in-flight count (not just the limiter's local accounting,
 * which lags the upstream `concurrent_sessions` counter by the release
 * cooldown). `concurrentSessions` is the number of requests the provider counts
 * as currently in flight.
 */
export interface ProviderUsage {
  /** Upstream count of currently in-flight (generating) sessions. */
  readonly concurrentSessions: number;
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
  /** The model's max context window in tokens (e.g. 200000). Optional — providers that don't report it leave it undefined. */
  readonly contextWindow?: number;
  /**
   * Whether this model can natively accept image input (vision/multimodal).
   * When `true`, image chunks in a user message are passed through to the
   * provider serialized to its image-content format. When `false`/absent, the
   * orchestrator's vision handoff transcribes images to text (via a
   * vision-capable model) before the model sees them. Optional — providers
   * that cannot detect it leave it undefined (treated as non-vision); a
   * provider that knows a model is vision-capable sets it `true`.
   */
  readonly vision?: boolean;
  /**
   * The maximum number of inline image parts a single request to this model
   * may carry. Optional and provider-reported: some gateways reject a request
   * with more than N image parts with an opaque HTTP 400 that is independent
   * of body size (e.g. umans: >8). When set, the orchestrator clamps its
   * turn-start vision compaction limit to this value (transcribing the oldest
   * images instead of passing them through), and the provider adapter enforces
   * the same cap on the wire as a last-resort safety net. Absent = no known
   * per-model cap.
   */
  readonly maxImages?: number;
}

/**
 * What a provider extension registers with the kernel. The kernel calls
 * `stream` and consumes the async iterable of events — it never knows which
 * concrete LLM API is behind it.
 */
export interface ProviderContract {
  /** Unique identifier for this provider (e.g. "anthropic", "opencode-1"). */
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

  /**
   * Fetch the provider's current upstream usage snapshot. Optional: a provider
   * that cannot (or chooses not to) report usage omits it, and a concurrency
   * limiter falls back to cooldown-only slot recycling (no usage gate). When
   * present, the limiter polls this before admitting a QUEUED agent and grants
   * only when `concurrentSessions` is below the configured limit — preventing an
   * N+1 overshoot from the upstream accounting lag.
   *
   * May return `undefined` (e.g. the endpoint returned an unexpected shape or a
   * non-200) — the limiter treats `undefined` as "no usage info available" and
   * falls back to granting (cooldown-only behavior) for that poll.
   */
  readonly getUsage?: () => Promise<ProviderUsage | undefined>;
}

// --- Provider response metadata ---

/**
 * Payload of {@link providerResponseHeaders}: the HTTP response headers a
 * provider received for one upstream inference request. Lets observers (e.g.
 * an account-quota tracker) read upstream rate-limit metadata passively,
 * without the provider knowing who listens.
 *
 * Providers MUST include only non-secret headers (response headers carry no
 * credentials; providers may further restrict to a relevant prefix).
 */
export interface ProviderResponseHeadersPayload {
  /** The provider id (`ProviderContract.id`). */
  readonly providerId: string;
  /** The auth provider id the request was billed through (e.g. "claude-oauth"), if any. */
  readonly authId?: string;
  /** HTTP status of the response. */
  readonly status: number;
  /** Response headers, keys lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Event hook emitted by provider extensions after each upstream inference
 * response (success or error) — fire-and-forget, error-isolated.
 */
export const providerResponseHeaders: EventHookDescriptor<ProviderResponseHeadersPayload> =
  defineEventHook<ProviderResponseHeadersPayload>("kernel/provider.response-headers");
