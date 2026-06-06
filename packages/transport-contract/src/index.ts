/**
 * Transport contract — the typed description of Dispatch's HTTP API.
 *
 * This package is types-only (zero runtime). It is the single shared surface
 * every client imports to know how to talk to the backend — the CLI, the web
 * frontend (in its own repo), any third-party client — and the transport-http
 * server imports to know what it must accept and emit.
 *
 * Each side owns its OWN (de)serialization: there is deliberately no shared
 * parse/serialize helper here (isolation-over-DRY). The contract is the SHAPES,
 * not the codec. The streaming response payload is the kernel's `AgentEvent`
 * union, re-exported here so a client has one import for the whole wire.
 */

import type { StoredChunk } from "@dispatch/wire";

export type { AgentEvent, StoredChunk } from "@dispatch/wire";

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
