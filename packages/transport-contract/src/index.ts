/**
 * Transport contract — the typed description of Dispatch's client–server API
 * (HTTP + WebSocket).
 *
 * This package is types-only (zero runtime). It is the single shared surface
 * every client imports to know how to talk to the backend — the CLI, the web
 * frontend (in its own repo), any third-party client — and the transport-http /
 * transport-ws servers import to know what they must accept and emit.
 *
 * Each side owns its OWN (de)serialization: there is deliberately no shared
 * parse/serialize helper here (isolation-over-DRY). The contract is the SHAPES,
 * not the codec. The streaming response payload is the kernel's `AgentEvent`
 * union, re-exported here so a client has one import for the whole wire.
 *
 * The WebSocket carries BOTH chat ops (defined here) and surface ops (defined in
 * `@dispatch/ui-contract`) over one connection; the unified `WsClientMessage` /
 * `WsServerMessage` unions below compose them. Chat ops are new, non-colliding
 * `type` variants — there is no channel wrapper, so the shipped surface protocol
 * is unchanged.
 */

import type { SurfaceClientMessage, SurfaceServerMessage } from "@dispatch/ui-contract";
import type { AgentEvent, StoredChunk, TurnMetrics } from "@dispatch/wire";

export type { AgentEvent, StepMetrics, StoredChunk, TurnMetrics } from "@dispatch/wire";

/**
 * Request body for `POST /chat` (sent as JSON).
 *
 * The response is an NDJSON stream: one JSON-encoded `AgentEvent` per line.
 * The resolved conversation id is also returned in the `X-Conversation-Id`
 * response header (useful when `conversationId` was omitted).
 */
export interface ChatRequest {
	/**
	 * The conversation to continue. Omit to start a fresh conversation — the
	 * server mints an id and returns it via the `X-Conversation-Id` header.
	 */
	readonly conversationId?: string;

	/** The user's message text for this turn. */
	readonly message: string;

	/**
	 * The model to use, as a model name in `<credentialName>/<model>` form — one
	 * of the exact strings returned by `GET /models`. Omit to use the server's
	 * default credential + model.
	 */
	readonly model?: string;

	/**
	 * Working directory for this turn's tool execution. Defaults server-side when
	 * omitted. Forwarded to tools for path resolution; never part of the model
	 * prompt (so it does not affect prompt caching).
	 */
	readonly cwd?: string;
}

/**
 * Response body for `GET /models` — the model catalog.
 *
 * Each entry is a model name in `<credentialName>/<model>` form: exactly the
 * string a client passes back as `ChatRequest.model`.
 */
export interface ModelsResponse {
	readonly models: readonly string[];
}

/**
 * Response body for `GET /conversations/:id?sinceSeq=<n>` — the incremental
 * read-side history endpoint a long-lived client uses to (re)hydrate a
 * conversation cheaply.
 *
 * `chunks` is the RAW, append-order, seq-ordered slice of the conversation log
 * with `seq > sinceSeq` (or the whole log when `sinceSeq` is omitted/0). It is
 * NOT reconciled: a dangling tool-call is returned as-is (rendered as an
 * interrupted call). Reconciliation is a turn-path concern — the server repairs
 * history only when it feeds a provider, never on this read path — which is what
 * preserves the per-chunk `seq` cursor invariant (a synthesized repair chunk
 * would have no seq).
 *
 * `latestSeq` is the `seq` of the LAST chunk in this response, or — when the
 * slice is empty (the client is already caught up) — the requested `sinceSeq`
 * (0 for a full read of an empty conversation). So after applying the response a
 * client's new cursor is always `latestSeq`, and an empty `chunks` means
 * "nothing new past your cursor". (A true server-side high-water mark
 * independent of the filter is deferred until a consumer needs it — it would
 * require widening the store contract.)
 */
export interface ConversationHistoryResponse {
	readonly chunks: readonly StoredChunk[];
	readonly latestSeq: number;
}

/**
 * Response body for `GET /conversations/:id/metrics` — the persisted per-turn
 * (and per-step) token + timing metrics for a conversation, for a client
 * reopening a past conversation to render historical usage/latency.
 *
 * This is a SEPARATE axis from the two other read concerns and is deliberately
 * its own endpoint: the live `usage`/`step-complete`/`done` events are transient
 * (not persisted), and `ConversationHistoryResponse` carries seq-cursor chunk
 * CONTENT. Metrics are keyed per TURN (not per chunk) and so are not seq-filtered
 * — hence a sibling route rather than a field on the history response.
 *
 * `turns` is every SEALED turn's `TurnMetrics` in turn order. A turn appears only
 * after its metrics were persisted (post-seal); an in-flight or unsealed turn is
 * absent until then.
 */
export interface ConversationMetricsResponse {
	readonly turns: readonly TurnMetrics[];
}

/** The aggregation window for `GET /metrics/throughput`. */
export type ThroughputPeriod = "day" | "week" | "month";

/**
 * One model's throughput over a period. `tokensPerSecond` is the TOKEN-WEIGHTED
 * average — `Σ(output tokens) / Σ(generation seconds)` across the period's
 * turns — so larger turns count proportionally more than smaller ones.
 * Generation time is the model's pure decode time (it excludes tool-execution
 * waits).
 */
export interface ThroughputModelStat {
	/** The model name in `<credentialName>/<model>` form (as selected). */
	readonly model: string;
	/** Token-weighted average tokens/second over the period. */
	readonly tokensPerSecond: number;
	/** Total output tokens generated across the period's turns. */
	readonly totalOutputTokens: number;
	/** Total pure generation time across the period's turns, in milliseconds. */
	readonly totalGenMs: number;
	/** Number of turns that contributed. */
	readonly turns: number;
}

/**
 * Response body for
 * `GET /metrics/throughput?period=day|week|month&date=<...>`.
 *
 * `date` is `YYYY-MM-DD` for day/week (week = the ISO Mon–Sun week containing
 * that date) and `YYYY-MM` for month. Boundaries are computed in the server's
 * local timezone; `start`/`end` are the resolved half-open `[start, end)` range
 * in epoch-ms. `models` lists every model active in the window, sorted by
 * `tokensPerSecond` descending.
 */
export interface ThroughputResponse {
	readonly period: ThroughputPeriod;
	readonly date: string;
	/** Inclusive start of the window, epoch-ms. */
	readonly start: number;
	/** Exclusive end of the window, epoch-ms. */
	readonly end: number;
	readonly models: readonly ThroughputModelStat[];
}

/**
 * Request body for `POST /chat/warm` — manually trigger a prompt-cache WARMING
 * request for a conversation (e.g. a frontend "warm now" button, or fast tests
 * that don't want to wait for the automatic warming timer).
 *
 * The warm replays the conversation's existing prefix to the provider to refresh
 * its prompt cache; it is NEVER persisted and NEVER streamed (no `AgentEvent`s).
 * Pass the same `model`/`cwd` the conversation chats with so the warm request's
 * prefix is byte-identical to a real turn (which is what makes the cache hit).
 */
export interface WarmRequest {
	/** The conversation whose prompt cache to warm. */
	readonly conversationId: string;

	/**
	 * The model name in `<credentialName>/<model>` form the conversation uses, so
	 * the warm resolves the same provider + prefix. Omit to use the server default.
	 */
	readonly model?: string;

	/** Working directory matching the conversation's turns (for cwd-aware tool assembly). */
	readonly cwd?: string;
}

/**
 * Response body for `POST /chat/warm` (HTTP 200). The warm request's usage —
 * never folded into the conversation's real usage. A client surfaces `cachePct`
 * as the "last warming" cache-hit indicator.
 *
 * When warming cannot run because the conversation is currently generating, the
 * server responds `409` with `{ error }` instead of this body.
 */
export interface WarmResponse {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/**
	 * Cache-hit percent: `round(clamp(cacheReadTokens / inputTokens, 0, 1) * 100)`
	 * (0 when `inputTokens <= 0`).
	 */
	readonly cachePct: number;
}

// ─── WebSocket chat ops ───────────────────────────────────────────────────────
// The persistent WS connection multiplexes chat ops (below) with surface ops
// (`@dispatch/ui-contract`). The unified unions at the bottom compose both. Chat
// `type`s are namespaced (`chat.*`) so they never collide with surface ones.

/**
 * Client → server: start or continue a turn over the WS connection. Carries the
 * same fields as the HTTP `ChatRequest` (so one shape drives both transports);
 * omit `conversationId` to start fresh — the resolved id arrives on the streamed
 * `AgentEvent`s (each carries `conversationId`).
 */
export interface ChatSendMessage extends ChatRequest {
	readonly type: "chat.send";
}

/**
 * Server → client: one `AgentEvent` from an in-flight turn (text-delta,
 * tool-call, usage, done, turn-sealed, …). The client folds these into its
 * transcript exactly as it folds the HTTP NDJSON stream — same events, different
 * carrier.
 */
export interface ChatDeltaMessage {
	readonly type: "chat.delta";
	readonly event: AgentEvent;
}

/**
 * Server → client: a chat-scoped TRANSPORT error — e.g. a malformed `chat.send`
 * or a failure before a turn could start. (Errors DURING a turn arrive as a
 * `TurnErrorEvent` inside a `chat.delta`.)
 */
export interface ChatErrorMessage {
	readonly type: "chat.error";
	readonly conversationId?: string;
	readonly message: string;
}

/**
 * Every client → server WS message: surface ops (`@dispatch/ui-contract`) + chat
 * ops. A server discriminates on `type`.
 */
export type WsClientMessage = SurfaceClientMessage | ChatSendMessage;

/**
 * Every server → client WS message: surface ops (`@dispatch/ui-contract`) + chat
 * ops. A client discriminates on `type`.
 */
export type WsServerMessage = SurfaceServerMessage | ChatDeltaMessage | ChatErrorMessage;
