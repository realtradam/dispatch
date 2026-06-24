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
import type {
	AgentEvent,
	ConversationMeta,
	ConversationStatus,
	QueuedMessage,
	ReasoningEffort,
	StoredChunk,
	TurnMetrics,
	Workspace,
	WorkspaceEntry,
} from "@dispatch/wire";

export type {
	AgentEvent,
	CompactionResult,
	ConversationMeta,
	ConversationStatus,
	QueuedMessage,
	ReasoningEffort,
	StepMetrics,
	StoredChunk,
	TurnMetrics,
	Workspace,
	WorkspaceEntry,
} from "@dispatch/wire";

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

	/**
	 * Reasoning-effort override for THIS turn only (does not persist). When
	 * omitted, the server resolves the conversation's persisted value, falling
	 * back to `"high"`. Must be one of the `ReasoningEffort` levels; an
	 * unrecognized value → HTTP 400 `{ error }`.
	 */
	readonly reasoningEffort?: ReasoningEffort;

	/**
	 * The workspace to assign this conversation to. Omit for `"default"`.
	 * If the workspace doesn't exist yet, it is auto-created (title = id,
	 * defaultCwd = null).
	 */
	readonly workspaceId?: string;
}

/**
 * Response body for `GET /models` — the model catalog.
 *
 * Each entry in `models` is a model name in `<credentialName>/<model>` form:
 * exactly the string a client passes back as `ChatRequest.model`.
 * `modelInfo` is an optional map from the same `<credentialName>/<model>` key
 * to model metadata (e.g. `contextWindow`). Additive — clients that only
 * read `models` are unaffected.
 */
export interface ModelsResponse {
	readonly models: readonly string[];
	readonly modelInfo?: Readonly<Record<string, ModelMetadata>>;
}

/** Per-model metadata returned alongside the model catalog. */
export interface ModelMetadata {
	readonly contextWindow?: number;
}

/**
 * Response body for
 * `GET /conversations/:id?sinceSeq=<n>&beforeSeq=<s>&limit=<k>` — the
 * incremental read-side history endpoint a long-lived client uses to
 * (re)hydrate a conversation cheaply. All three query params are OPTIONAL and
 * combine as one SELECTION + one WINDOW:
 *
 * - **Selection** — `sinceSeq` (exclusive lower bound, `seq > n`; omitted/0 =
 *   from the start) and `beforeSeq` (exclusive upper bound, `seq < s`; omitted
 *   = to the end). Together: `n < seq < s`.
 * - **Window** — `limit=<k>` returns only the NEWEST `k` chunks of the
 *   selection (the response stays ASCENDING by seq). A selection with ≤ `k`
 *   chunks is returned whole. `limit` omitted = the full selection — exactly
 *   the pre-windowing behavior, so existing clients are unchanged.
 * - `limit` and `beforeSeq` must be POSITIVE integers (`sinceSeq` may be 0);
 *   malformed, zero, or negative values → HTTP 400 `{ error }`.
 *
 * Intended client flows: fresh load = `?sinceSeq=0&limit=<k>` (newest window);
 * tail sync = `?sinceSeq=<cursor>` (no limit); page older history in =
 * `?beforeSeq=<oldestLoadedSeq>&limit=<k>`.
 *
 * Seq numbering is **1-based and gap-free** (a CONTRACTUAL GUARANTEE — see
 * `StoredChunk` in `@dispatch/wire`): a client can derive "older chunks exist"
 * purely from `oldestLoaded.seq > 1`; there is deliberately no
 * `earliestSeq`/`hasOlder` response field.
 *
 * `chunks` is the RAW, append-order, seq-ordered slice of the conversation log
 * selected + windowed as above. It is NOT reconciled: a dangling tool-call is
 * returned as-is (rendered as an interrupted call). Reconciliation is a
 * turn-path concern — the server repairs history only when it feeds a provider,
 * never on this read path — which is what preserves the per-chunk `seq` cursor
 * invariant (a synthesized repair chunk would have no seq).
 *
 * `latestSeq` is the `seq` of the LAST chunk in this response, or — when the
 * slice is empty (the client is already caught up) — the requested `sinceSeq`
 * (0 for a full read of an empty conversation). So after applying the response a
 * client's new cursor is always `latestSeq`, and an empty `chunks` means
 * "nothing new past your cursor". CAVEAT (windowed reads): `latestSeq` is a
 * TAIL-sync cursor — on a `beforeSeq` backfill page (or any `limit`ed read that
 * did not reach the log's true tail) it describes the returned window, NOT the
 * conversation's high-water mark, so a client must not regress its sync cursor
 * from a backfill response. (A true server-side high-water mark independent of
 * the filter is deferred until a consumer needs it — it would require widening
 * the store contract.)
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

export interface ConversationStatusResponse {
	readonly conversationId: string;
	/** True if the orchestrator has an in-memory active turn for this conversation. */
	readonly isActive: boolean;
	/** The persisted lifecycle status from the conversation store. */
	readonly status: ConversationStatus;
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

// ─── Per-conversation working directory (cwd) ─────────────────────────────────

/** Response of `GET /conversations/:id/cwd`. `cwd` is null when never set. */
export interface CwdResponse {
	readonly conversationId: string;
	readonly cwd: string | null;
}

/**
 * Body of `PUT /conversations/:id/cwd`.
 *
 * When `workspaceId` is provided, the conversation is assigned to that
 * workspace BEFORE the cwd is persisted — so a subsequent
 * `GET /conversations/:id/lsp` resolves a relative cwd against the
 * workspace's `defaultCwd` (not the server default). Omit for unchanged
 * workspace assignment (the conversation keeps its current workspace, or
 * `"default"` if none).
 */
export interface SetCwdRequest {
	readonly cwd: string;
	readonly workspaceId?: string;
}

// ─── Per-conversation reasoning effort ────────────────────────────────────────

/**
 * Response of `GET /conversations/:id/reasoning-effort`. `reasoningEffort` is
 * null when never set (the server then resolves turns at the default,
 * `"high"`).
 */
export interface ReasoningEffortResponse {
	readonly conversationId: string;
	readonly reasoningEffort: ReasoningEffort | null;
}

/**
 * Body of `PUT /conversations/:id/reasoning-effort` — persists the
 * conversation's sticky reasoning-effort level (used for every later turn that
 * does not carry a per-turn `ChatRequest.reasoningEffort` override). An
 * unrecognized level → HTTP 400 `{ error }`.
 */
export interface SetReasoningEffortRequest {
	readonly reasoningEffort: ReasoningEffort;
}

// ─── Per-conversation model ──────────────────────────────────────────────────

/**
 * Response of `GET /conversations/:id/model`. `model` is the persisted model
 * name in `<credentialName>/<model>` form, or null when never set (the server
 * then resolves turns using the default provider + model).
 */
export interface ModelResponse {
	readonly conversationId: string;
	readonly model: string | null;
}

/**
 * Body of `PUT /conversations/:id/model` — persists the conversation's sticky
 * model selection (used for every later turn that does not carry a per-turn
 * `ChatRequest.model` override). Pass `null` to clear the persisted selection.
 * An unrecognized model name is not validated here (the provider resolves it
 * at turn time; an unknown model → turn error, not a 400).
 */
export interface SetModelRequest {
	readonly model: string | null;
}

// ─── Conversation close (explicit tab close) ──────────────────────────────────

/**
 * Response of `POST /conversations/:id/close` (no request body).
 *
 * The EXPLICIT "the user closed this conversation's tab" affordance — distinct
 * from a socket disconnect or `chat.unsubscribe`, which deliberately never touch
 * the turn or the warming schedule. Closing:
 *  1. aborts any in-flight turn (the kernel stops at the next event boundary,
 *     partial messages are persisted, and the turn SEALS normally with
 *     `finishReason: "aborted"` — watchers see `done` + `turn-sealed`), and
 *  2. stops + disables cache-warming for the conversation (persisted OFF, so a
 *     reopened conversation stays opt-in).
 * Idempotent: closing an idle or unknown conversation succeeds with
 * `abortedTurn: false`.
 */
export interface CloseConversationResponse {
	readonly conversationId: string;
	/** True when an in-flight turn existed and was aborted by this close. */
	readonly abortedTurn: boolean;
}

// ─── System prompt template ───────────────────────────────────────────────────

/**
 * Response of `GET /system-prompt` — the current global system prompt template.
 *
 * The template is a text string with variable placeholders (`[type:name]`) and
 * conditional blocks (`[if]`/`[else]`/`[endif]`). At construction time (first
 * turn or compaction), variables are resolved against the conversation's cwd
 * and system state. The resolved system prompt is persisted per conversation
 * and reused on all subsequent turns (cache-safe — no per-turn reconstruction).
 */
export interface SystemPromptTemplateResponse {
	/** The template text (may be empty — then no system prompt is sent). */
	readonly template: string;
}

/**
 * Body of `PUT /system-prompt` — set the global system prompt template.
 *
 * Changing the template does NOT affect existing conversations until they are
 * compacted (the persisted resolved system prompt is stable). New
 * conversations use the new template on their first turn.
 */
export interface SetSystemPromptTemplateRequest {
	readonly template: string;
}

/**
 * One available variable for the system prompt template, as reported by
 * `GET /system-prompt/variables` so the frontend can render the variable
 * selector buttons.
 */
export interface SystemPromptVariable {
	/** The variable type/source: `"system"`, `"file"`, `"prompt"`, `"git"`. */
	readonly type: string;
	/** The variable name (e.g. `"time"`, `"date"`, `"os"`). For dynamic types, a description. */
	readonly name: string;
	/** Human-readable description of what the variable resolves to. */
	readonly description: string;
	/**
	 * When `true`, any name is valid for this type (e.g. `file:<path>` accepts
	 * any file path). The frontend should allow free-text input for the name.
	 */
	readonly dynamic?: boolean;
}

/** Response of `GET /system-prompt/variables`. */
export interface SystemPromptVariablesResponse {
	readonly variables: readonly SystemPromptVariable[];
}

// ─── Message queue (steering) ─────────────────────────────────────────────────

/**
 * Request body for `POST /conversations/:id/queue` — enqueue a user message
 * onto a conversation's message queue for mid-turn steering delivery.
 *
 * When a turn is ACTIVE for the conversation, the message is appended to the
 * queue (the message-queue extension's per-conversation SURFACE updates) and
 * delivered at the next tool-result boundary as a steering message the model
 * sees alongside the tool results (a `steering` `AgentEvent` is emitted). When
 * NO turn is active, enqueuing instead STARTS a new turn with the message as its
 * opening prompt (equivalent to `POST /chat`) — so a fire-and-forget enqueue
 * works regardless of generation state. The resolved queue + whether a turn was
 * started are returned in `QueueResponse`.
 *
 * `text` must be non-empty (after trim) → HTTP 400 `{ error }` otherwise.
 */
export interface QueueRequest {
	readonly text: string;
	/**
	 * The workspace to assign the conversation to (if a new conversation is
	 * started). Omit for `"default"`. Auto-creates if missing.
	 */
	readonly workspaceId?: string;
}

/**
 * Response body for `POST /conversations/:id/queue` — the conversation's queue
 * snapshot AFTER the enqueue, so a client renders the queue from this alone.
 * `conversationId` echoes the path. `startedTurn` is true when no turn was
 * active and the enqueue started a new turn (the message is now the turn's
 * opening prompt, not a queued steering message); the turn's events stream on
 * the chat channel as usual.
 */
export interface QueueResponse {
	readonly conversationId: string;
	readonly startedTurn: boolean;
	readonly queue: readonly QueuedMessage[];
}

// ─── Per-conversation LSP status ──────────────────────────────────────────────

/** The connection state of a single language server for a workspace. */
export type LspServerState = "connected" | "starting" | "error" | "not-started";

/** One language server's status as reported to the frontend. */
export interface LspServerInfo {
	/** Stable server id, e.g. "typescript", "luau-lsp". */
	readonly id: string;
	/** Human-readable display name. */
	readonly name: string;
	/** The resolved workspace root the server is (or would be) rooted at (absolute). */
	readonly root: string;
	/** File extensions this server handles, e.g. [".ts", ".tsx"] or [".luau"]. */
	readonly extensions: readonly string[];
	/** Current connection state. */
	readonly state: LspServerState;
	/** Present only when `state === "error"`: a short human-readable reason. */
	readonly error?: string;
	/**
	 * Which config source this server was resolved from: `".dispatch/lsp.json"`,
	 * `"opencode.json"`, or `"built-in"` (the built-in TypeScript default). Omitted
	 * when not yet resolved. Surfaces config-shadow debugging to the status caller
	 * (a broken `.dispatch/lsp.json` silently shadowing `opencode.json`).
	 */
	readonly configSource?: string;
}

/** Response of `GET /conversations/:id/lsp`. */
export interface LspStatusResponse {
	readonly conversationId: string;
	/**
	 * The resolved working directory the LSP connects on, or `null` when no
	 * cwd has been set for the conversation (then `servers` is empty). When
	 * non-null, this is the effective cwd — a relative persisted cwd resolved
	 * against the conversation's workspace `defaultCwd`.
	 */
	readonly cwd: string | null;
	/** The language servers configured for `cwd` and their live state. */
	readonly servers: readonly LspServerInfo[];
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
	 * **Cache rate** — what fraction of THIS request's prompt was served from cache:
	 * `round(cacheReadTokens / inputTokens * 100)` (0 when `inputTokens <= 0`).
	 * (`inputTokens` is the TOTAL prompt incl. cached, so this is in [0,100].)
	 */
	readonly cachePct: number;
	/**
	 * **Expected cache (retention)** — of the cacheable prefix this warm touched, how
	 * much was still warm and read back vs. had to be (re)written:
	 * `round(cacheReadTokens / (cacheReadTokens + cacheWriteTokens) * 100)` (0 when the
	 * sum is 0). For a healthy warm this is ~**100%** (the whole prefix was still
	 * cached); it drops toward 0 as the cache expires/busts and the warm has to rewrite
	 * it. This is the warming HEALTH signal — distinct from `cachePct` (which a warm's
	 * tiny fresh probe makes ~equal, but which on a real turn reflects new content).
	 */
	readonly expectedCacheRate: number;
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
 * Client → server: start WATCHING a conversation's live turn events WITHOUT
 * sending a message. This is what makes a turn viewable independently of who
 * started it — a second device (multi-client handoff) or a client that reloaded
 * mid-turn subscribes to receive the in-flight turn.
 *
 * On subscribe the server replays the CURRENT in-flight turn's events so far as
 * `chat.delta` messages (so a late-joiner sees the whole running turn from its
 * `turn-start`), then streams subsequent live events. If no turn is in-flight,
 * nothing is replayed (the client relies on `GET /conversations/:id` history).
 * A client infers "generating" from a replayed `turn-start` with no matching
 * `done`/`turn-sealed` yet. Idempotent per `(connection, conversationId)`.
 *
 * NOTE: `chat.send` auto-subscribes the sending connection, so a client only needs
 * `chat.subscribe` for conversations it is viewing but did not send to.
 */
export interface ChatSubscribeMessage {
	readonly type: "chat.subscribe";
	readonly conversationId: string;
}

/**
 * Client → server: stop watching a conversation's turn events on this connection.
 * Does NOT stop or affect the turn itself (the turn runs to completion regardless
 * of subscribers). The server also drops all of a connection's subscriptions when
 * the socket closes — again WITHOUT aborting any in-flight turn.
 */
export interface ChatUnsubscribeMessage {
	readonly type: "chat.unsubscribe";
	readonly conversationId: string;
}

/**
 * Client → server: enqueue a message onto a conversation's message queue while
 * a turn is generating (steering). The WebSocket counterpart of the HTTP
 * `POST /conversations/:id/queue` (`QueueRequest`). Fire-and-forget: success is
 * confirmed by the message-queue SURFACE updating (the FE renders the queue
 * from the surface, not from a reply here); a failure (malformed/empty text,
 * unknown conversation) arrives as a `chat.error`. When no turn is active, the
 * enqueue starts a new turn (the turn's events stream as `chat.delta`s), so a
 * client reuses this op for both "queue while generating" and "send" (the
 * latter being equivalent to `chat.send`).
 */
export interface ChatQueueMessage {
	readonly type: "chat.queue";
	readonly conversationId: string;
	readonly text: string;
	/**
	 * The workspace to assign the conversation to (if a new conversation is
	 * started). Omit for `"default"`. Auto-creates if missing.
	 */
	readonly workspaceId?: string;
}

/**
 * Every client → server WS message: surface ops (`@dispatch/ui-contract`) + chat
 * ops. A server discriminates on `type`.
 */
export type WsClientMessage =
	| SurfaceClientMessage
	| ChatSendMessage
	| ChatSubscribeMessage
	| ChatUnsubscribeMessage
	| ChatQueueMessage;

/**
 * Every server → client WS message: surface ops (`@dispatch/ui-contract`) + chat
 * ops. A client discriminates on `type`.
 */
export type WsServerMessage =
	| SurfaceServerMessage
	| ChatDeltaMessage
	| ChatErrorMessage
	| ConversationOpenMessage
	| ConversationStatusChangedMessage
	| ConversationCompactedMessage;

// ─── Conversation list + metadata ────────────────────────────────────────────

/**
 * Broadcast to all connected WS clients when a conversation is "opened" (e.g.
 * via the CLI `--open` flag). The frontend decides whether to open/focus a tab
 * — the backend just signals. Additive to `WsServerMessage`.
 */
export interface ConversationOpenMessage {
	readonly type: "conversation.open";
	readonly conversationId: string;
	/**
	 * The conversation's actual workspace id, so a frontend can open/focus it
	 * in the correct workspace instead of stamping it with the viewer's current
	 * workspace.
	 */
	readonly workspaceId: string;
}

/**
 * Broadcast to all connected WS clients when a conversation's lifecycle status
 * changes (active/idle/closed). The frontend uses this to sync tab state across
 * devices in real time.
 */
export interface ConversationStatusChangedMessage {
	readonly type: "conversation.statusChanged";
	readonly conversationId: string;
	readonly status: ConversationStatus;
	/**
	 * The conversation's actual workspace id, so a frontend can open/focus it
	 * in the correct workspace instead of stamping it with the viewer's current
	 * workspace.
	 */
	readonly workspaceId: string;
}

/**
 * Broadcast to all connected WS clients when a conversation's history has been
 * compacted (summarized). The frontend should reload the conversation history
 * via `GET /conversations/:id` to reflect the compacted state.
 */
export interface ConversationCompactedMessage {
	readonly type: "conversation.compacted";
	readonly conversationId: string;
	readonly newConversationId: string;
	readonly messagesSummarized: number;
	readonly messagesKept: number;
}

/**
 * Response for `GET /conversations` — the list of all known conversations,
 * sorted by `lastActivityAt` descending (most recent first). Each entry carries
 * enough metadata for a conversation picker UI (id, title, timestamps).
 * Optional `?q=` query param filters by id prefix (short-id resolution).
 */
export interface ConversationListResponse {
	readonly conversations: readonly ConversationMeta[];
}

/**
 * Response for `GET /conversations/:id/last` — blocks server-side until the
 * in-flight turn settles (if one is active), then returns the last assistant
 * text message. `content` is empty if the conversation has no assistant message.
 * `turnId` is the turn that produced the message (absent if no turn ran).
 */
export interface LastMessageResponse {
	readonly conversationId: string;
	readonly content: string;
	readonly turnId?: string;
}

/**
 * Response for `POST /conversations/:id/open` — confirms the conversation.open
 * signal was broadcast to connected WS clients.
 */
export interface OpenConversationResponse {
	readonly conversationId: string;
}

/**
 * Request body for `PUT /conversations/:id/title` — set a human-readable title.
 */
export interface SetTitleRequest {
	readonly title: string;
}

/**
 * Response for `GET/PUT /conversations/:id/title` — the current title.
 */
export interface TitleResponse {
	readonly conversationId: string;
	readonly title: string;
}

/**
 * Response for `POST /conversations/:id/compact` — confirms the conversation
 * history was compacted (old messages summarized, recent messages retained).
 */
export interface CompactResponse {
	readonly conversationId: string;
	readonly newConversationId: string;
	readonly messagesSummarized: number;
	readonly messagesKept: number;
}

/**
 * Response for `GET /conversations/:id/compact-percent` — the token count
 * at which automatic compaction triggers (0 = manual only).
 */
export interface CompactPercentResponse {
	readonly conversationId: string;
	readonly threshold: number;
}

/**
 * Request body for `PUT /conversations/:id/compact-percent`.
 */
export interface SetCompactPercentRequest {
	readonly threshold: number;
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

/**
 * Body of `PUT /workspaces/:id` — the idempotent create-on-miss call. All
 * fields are optional and only applied when the workspace is first created;
 * an existing workspace is returned as-is.
 */
export interface EnsureWorkspaceRequest {
	/** Display title. Default: the workspace id. Only used on create. */
	readonly title?: string;
	/** Default cwd. Default: null (inherit server default). Only used on create. */
	readonly defaultCwd?: string | null;
}

/** Response of `GET`/`PUT /workspaces/:id` — the workspace itself. */
export interface WorkspaceResponse extends Workspace {}

/** Response of `GET /workspaces` — all workspaces sorted by `lastActivityAt` desc. */
export interface WorkspaceListResponse {
	readonly workspaces: readonly WorkspaceEntry[];
}

/** Body of `PUT /workspaces/:id/title` — rename (display only; id unchanged). */
export interface SetWorkspaceTitleRequest {
	readonly title: string;
}

/** Body of `PUT /workspaces/:id/default-cwd` — set or clear the default cwd. */
export interface SetWorkspaceDefaultCwdRequest {
	readonly defaultCwd: string | null;
}

/**
 * Response of `DELETE /workspaces/:id`. All conversations in the workspace
 * are closed (status → "closed") and reassigned to "default", then the
 * workspace entity is deleted. `"default"` is non-deletable (HTTP 409).
 */
export interface DeleteWorkspaceResponse {
	readonly workspaceId: string;
	/** Conversations that were closed (status → "closed") by this delete. */
	readonly closedCount: number;
}
