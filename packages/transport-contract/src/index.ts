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

export type { AgentEvent } from "@dispatch/kernel";

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
