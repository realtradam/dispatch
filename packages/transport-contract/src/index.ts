/**
 * Transport contract — the typed description of Dispatch's client–server API
 * (HTTP + WebSocket).
 *
 * This package defines types plus pure conversation-ID boundary validation.
 * That deliberate runtime exception is not a shared codec. It is the shared surface
 * every client imports to know how to talk to the backend — the CLI, the web
 * frontend (in its own repo), any third-party client — and the transport-http /
 * transport-ws servers import to know what they must accept and emit.
 *
 * Each side owns its OWN (de)serialization: there is deliberately no shared
 * wire parse/serialize helper here (isolation-over-DRY). The contract is the SHAPES,
 * not the codec. The streaming response payload is the kernel's `AgentEvent`
 * union, re-exported here so a client has one import for the whole wire.
 *
 * The WebSocket carries BOTH chat ops (defined here) and surface ops (defined in
 * `@dispatch/ui-contract`) over one connection; the unified `WsClientMessage` /
 * `WsServerMessage` unions below compose them. Chat ops are new, non-colliding
 * `type` variants — there is no channel wrapper, so the shipped surface protocol
 * is unchanged.
 */

import type { LayoutTree } from "@dispatch/layout-contract";
import type { TileGeometryMode, TileLayoutData } from "@dispatch/tile-layout-contract";
import type { SurfaceClientMessage, SurfaceServerMessage } from "@dispatch/ui-contract";
import type {
  AgentEvent,
  Computer,
  ComputerEntry,
  ConversationMeta,
  ConversationStatus,
  ImageInput,
  NamedAgent,
  NamedAgentSelectionSnapshot,
  QueuedMessage,
  ReasoningEffort,
  StoredChunk,
  TurnMetrics,
  Workspace,
  WorkspaceEntry,
} from "@dispatch/wire";

export type { LayoutTree } from "@dispatch/layout-contract";
export type {
  AgentEvent,
  CompactionResult,
  Computer,
  ComputerEntry,
  ConversationMeta,
  ConversationStatus,
  ImageChunk,
  ImageInput,
  NamedAgent,
  NamedAgentSelectionSnapshot,
  QueuedMessage,
  ReasoningEffort,
  StepMetrics,
  StoredChunk,
  TurnMetrics,
  Workspace,
  WorkspaceEntry,
} from "@dispatch/wire";
export { isValidConversationId, parseConversationId } from "./conversation-id.js";

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
   * When supplied, must match `^[A-Za-z0-9_-]{1,128}$` (UUIDs and legacy IDs).
   * Empty, null, and non-string values are rejected, not treated as absent.
   */
  readonly conversationId?: string;

  /** The user's message text for this turn. */
  readonly message: string;

  /**
   * Images attached to this turn (e.g. a user-pasted screenshot). Each entry's
   * `url` is a base64 data URL (`data:image/…;base64,…`) or an `http(s)://`
   * URL. The server converts these to `image` chunks on the persisted user
   * message. For a VISION-capable model (e.g. kimi), the images are passed
   * through to the provider natively. For a NON-vision model (e.g. glm-5.2),
   * the server's vision handoff transcribes each image to a text description
   * (via a vision-capable model) and feeds that text instead — so a text-only
   * model can still reason about the image's contents. Optional — omit for a
   * text-only turn (backward compatible).
   */
  readonly images?: readonly ImageInput[];

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
   * The computer to run this turn's tools on — an SSH config `Host` alias
   * (one of the `alias` values returned by `GET /computers`). Omit to inherit
   * the resolved chain: per-conversation `computerId` → the workspace's
   * `defaultComputerId` → `null`/local (today's behavior). Like `cwd`, this is
   * a per-turn tool-execution target forwarded to tools and never part of the
   * model prompt (so it does not affect prompt caching). Mirrors `cwd`.
   */
  readonly computerId?: string;

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

  /**
   * A human-readable title for the conversation tab — persisted at creation
   * time, after the new-conversation workspace setup resolves (so workspace
   * assignment and first-turn system-prompt construction are not skipped) and
   * before the first message append (so the append's auto-derived title does
   * not overwrite it). The tab shows it instead of the default derived from
   * the first message (`"Untitled"` until the first append). Omit to keep the
   * auto-derived title. When present, the value is trimmed server-side; a
   * whitespace-only value is treated as absent (auto-derive). A non-string
   * value → HTTP 400 `{ error }`.
   *
   * Backward compatible — clients that omit it are unaffected. Mirrors the
   * dedicated `PUT /conversations/:id/title` endpoint but is atomic with the
   * turn (no second round-trip from the client).
   */
  readonly title?: string;

  /**
   * Named Agent selection snapshot to persist on the conversation at creation.
   *
   * When the client starts a conversation via the synthetic **Named Agents**
   * provider, it resolves the selected Named Agent to its raw `model` and sends
   * that **plus** this snapshot so the conversation freezes how it was selected
   * (snapshot semantics — see `NamedAgentSelectionSnapshot` in `@dispatch/wire`).
   * The server persists it alongside the model; later edits/deletes of the Named
   * Agent do not change this conversation's selection. Omit for a raw-model-only
   * conversation (backward compatible). Ignored/overwritten by a subsequent
   * `PUT /conversations/:id/model` that carries its own snapshot.
   */
  readonly namedAgent?: NamedAgentSelectionSnapshot;
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
  /**
   * Whether this model can natively accept image input (vision/multimodal).
   * When `true`, image chunks in a user message are passed through to the
   * provider. When `false`/absent, the server's vision handoff transcribes
   * images to text before the model sees them. A client may use this to show a
   * vision badge in the model picker. Optional — absent when unknown.
   */
  readonly vision?: boolean;
}

// ─── Named Agents ────────────────────────────────────────────────────────────

/**
 * Response body for `GET /named-agents` — the list of configured Named Agents.
 *
 * Each record is a user-curated model preset (`id`, friendly `name`, canonical
 * `<credential>/<model>`). This is the local configuration that drives the
 * "Named Agents" synthetic provider in the frontend model selector and the
 * `list_agent_models`/`summon_agent` agent tools — NOT the raw model catalog
 * (which `GET /models` continues to serve unchanged).
 */
export interface NamedAgentsResponse {
  readonly namedAgents: readonly NamedAgent[];
}

/** Response body for `POST`/`PUT /named-agents(/:id)` — the canonical saved record. */
export interface NamedAgentResponse {
  readonly namedAgent: NamedAgent;
}

/** Request body for `POST /named-agents` — create a Named Agent. */
export interface CreateNamedAgentRequest {
  /** User-chosen friendly name (trimmed; unique case-insensitively). */
  readonly name: string;
  /** Canonical `<credential>/<model>` identifier. */
  readonly model: string;
}

/** Request body for `PUT /named-agents/:id` — full update of a Named Agent. */
export interface UpdateNamedAgentRequest {
  readonly name: string;
  readonly model: string;
}

/**
 * Response body for `DELETE /named-agents/:id` — confirms removal of the record
 * with the stable id.
 */
export interface DeleteNamedAgentResponse {
  readonly id: string;
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
 * Seq is positive and never reused within a conversation, even when history is
 * replaced. The retained log need not start at 1, so `oldestLoaded.seq > 1`
 * does not prove older chunks exist. An empty/short backfill page can establish
 * that no earlier chunks remain.
 *
 * `historyEpoch` is the persisted replacement count (missing storage value = 0).
 * Every successful replacement, including an empty one, increments it once.
 * On a different epoch, clients invalidate their conversation cache and refetch
 * with `sinceSeq=0` (optionally windowed), even if this response has no chunks.
 *
 * `chunks` is the RAW, append-order, seq-ordered slice of the conversation log
 * selected + windowed as above. It is NOT reconciled: a dangling tool-call is
 * returned as-is (rendered as an interrupted call). Reconciliation is a
 * turn-path concern — the server repairs history only when it feeds a provider,
 * never on this read path — which is what preserves the per-chunk `seq` cursor
 * invariant (a synthesized repair chunk would have no seq). Provider-opaque
 * thinking replay fields (`signature` and `redactedData`) are omitted from
 * this client-facing response; chunk presence, text, order, and seq are intact.
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
  readonly historyEpoch: number;
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
 *
 * `namedAgent` is the Named Agent selection snapshot recorded when the
 * conversation was started/selected via a Named Agent. Present only for
 * conversations that were created through a Named Agent (snapshot semantics: it
 * freezes the friendly id/name + resolved model at selection time, so later
 * edits to the Named Agent do not change this conversation's selection). A
 * conversation holding only a raw model carries no `namedAgent`.
 */
export interface ModelResponse {
  readonly conversationId: string;
  readonly model: string | null;
  readonly namedAgent?: NamedAgentSelectionSnapshot;
}

/**
 * Body of `PUT /conversations/:id/model` — persists the conversation's sticky
 * model selection (used for every later turn that does not carry a per-turn
 * `ChatRequest.model` override). Pass `null` to clear the persisted selection.
 * An unrecognized model name is not validated here (the provider resolves it
 * at turn time; an unknown model → turn error, not a 400).
 *
 * `namedAgent` (optional) is a Named Agent selection snapshot to persist with
 * the model — sent when the client sets this conversation's model via the
 * synthetic **Named Agents** provider so the conversation freezes the friendly
 * selection. When `model` is `null` (clear), the persisted snapshot is also
 * cleared. Omit entirely for a raw-model selection (backward compatible).
 */
export interface SetModelRequest {
  readonly model: string | null;
  readonly namedAgent?: NamedAgentSelectionSnapshot;
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

// ─── Vision settings (global) ──────────────────────────────────────────────────

/**
 * Response of `GET /settings/vision` — the global vision configuration shared
 * across all conversations and vision models.
 */
export interface VisionSettingsResponse {
  readonly imageLimit: number;
  readonly compactionModel: string | null;
}

/** Body of `PUT /settings/vision` — a partial update. */
export interface SetVisionSettingsRequest {
  readonly imageLimit?: number;
  readonly compactionModel?: string | null;
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

/**
 * Response body for
 * `DELETE /conversations/:id/queue/:messageId` — cancel (remove) a single
 * queued steering message by id so it never runs.
 *
 * `cancelled` is `true` when a message with the given id was found in the
 * conversation's queue and removed (it will never be delivered as steering nor
 * carried into a new turn). `cancelled` is `false` when the message was not in
 * the queue (already drained/delivered, never existed, unknown conversation)
 * OR when the message-queue extension isn't loaded (degraded — feature off).
 * `queue` is the post-cancel snapshot (empty when no queue extension is
 * loaded). Idempotent — cancelling a message that is no longer queued returns
 * `cancelled: false` with HTTP 200 (not an error), so a client may optimistically
 * fire-and-forget a cancel and reconcile from the surface.
 */
export interface QueueCancelResponse {
  readonly conversationId: string;
  readonly cancelled: boolean;
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

// ─── MCP status ──────────────────────────────────────────────────────

export type McpServerState = "connecting" | "connected" | "error" | "disconnected";

/** One MCP server's status as reported to the frontend. */
export interface McpServerInfo {
  /** Stable server id (the config key from `.dispatch/mcp.json`), e.g. "freecad". */
  readonly id: string;
  /** Current connection state. */
  readonly state: McpServerState;
  /** Present only when `state === "error"`: a short human-readable reason. */
  readonly error?: string;
  /** Number of tools discovered from this server. */
  readonly toolCount: number;
  /** Which config source this server was resolved from. */
  readonly configSource?: string;
}

/** Response of `GET /conversations/:id/mcp`. */
export interface McpStatusResponse {
  readonly conversationId: string;
  /**
   * The resolved working directory the MCP servers are configured for, or
   * `null` when no cwd has been set for the conversation (then `servers` is
   * empty). Mirrors the LSP status endpoint behavior.
   */
  readonly cwd: string | null;
  /** The MCP servers configured for `cwd` and their live state. */
  readonly servers: readonly McpServerInfo[];
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
 * Client → server: cancel (remove) a SINGLE queued steering message by id so
 * it never runs. The WebSocket counterpart of the HTTP
 * `DELETE /conversations/:id/queue/:messageId` (`QueueCancelResponse`).
 * Fire-and-forget: success is confirmed by the message-queue SURFACE updating
 * (the cancelled message leaves the snapshot); a failure (missing/empty
 * `conversationId` or `messageId`) arrives as a `chat.error`. Idempotent —
 * cancelling a message that is no longer queued (already drained/delivered) is
 * a silent no-op (no surface update, no error). `messageId` is the stable
 * client-visible `QueuedMessage.id` (obtained from the queue surface snapshot
 * or the enqueue response).
 */
export interface ChatQueueCancelMessage {
  readonly type: "chat.queue.cancel";
  readonly conversationId: string;
  readonly messageId: string;
}

/**
 * Client → server: declare THIS connection's active workspace (plan 06
 * §6.4). Workspace switching is instant and client-side, so the server
 * must be told explicitly — on receipt the server records the
 * connection's workspace and RE-PUSHES the surface catalog filtered to
 * that workspace (surfaces contributed by plugins that are not usable in
 * the workspace are omitted). Clients that never send it keep the
 * unfiltered (global) catalog — backward compatible. Owned by plan 06
 * (backend contract + server handling); plan 07 sends it from the client.
 */
export interface WorkspaceSetMessage {
  readonly type: "workspace.set";
  readonly workspaceId: string;
}

/**
 * Broadcast to all connected WS clients after every successful layout write
 * (plan 02 §2.5 — the `layout-chat` provider's PUT / setTree / DELETE / ops).
 * Carries the FULL tree for ONE workspace (decision 7 — no patch protocol);
 * the broadcast is a global fan-out and CLIENTS FILTER by their active
 * workspace (the workspaceId is the payload, not a subscription). Additive to
 * `WsServerMessage` — next to `extensions-changed`, a contract addition, not
 * core layout knowledge (D-L6: no core extension or transport learns the
 * layout domain; the transport ferries the message verbatim).
 */
export interface LayoutChangedMessage {
  readonly type: "layout";
  readonly workspaceId: string;
  readonly tree: LayoutTree;
}

/**
 * Broadcast to all connected WS clients after every successful home
 * tile-layout write (the `home-tile-layout` plugin's PUT / DELETE). Carries
 * the FULL document for ONE device orientation (`mode`: "wide" = landscape/
 * desktop, "tall" = portrait/mobile — two independent shared layouts); the
 * broadcast is a global fan-out and CLIENTS FILTER by their active mode.
 * Additive to `WsServerMessage`, the same verbatim-ferry pattern as
 * `LayoutChangedMessage` — no core extension or transport learns the tile
 * domain.
 */
export interface TileLayoutChangedMessage {
  readonly type: "tile-layout";
  readonly mode: TileGeometryMode;
  readonly data: TileLayoutData;
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
  | ChatQueueMessage
  | ChatQueueCancelMessage
  | WorkspaceSetMessage;

/**
 * Every server → client WS message: surface ops (`@dispatch/ui-contract`) + chat
 * ops. A client discriminates on `type`.
 */
export type WsServerMessage =
  | SurfaceServerMessage
  | ChatDeltaMessage
  | ChatErrorMessage
  | ConversationOpenMessage
  | ConversationTabGroupChangedMessage
  | ConversationStatusChangedMessage
  | ConversationCompactedMessage
  | ExtensionsChangedMessage
  | LayoutChangedMessage
  | TileLayoutChangedMessage;

// ─── Conversation list + metadata ────────────────────────────────────────────

/** A visual grouping change, globally broadcast to every connected client. */
export interface ConversationTabGroupChangedMessage {
  readonly type: "conversation.tabGroupChanged";
  readonly conversationId: string;
  /** The conversation's persisted workspace id. */
  readonly workspaceId: string;
  /** The new EFFECTIVE tab group parent; null = ungrouped. */
  readonly tabGroupParentId: string | null;
}

/**
 * Broadcast to all connected WS clients when a conversation is "opened" (e.g.
 * via the CLI `--open` flag). The frontend decides whether to open/focus a tab
 * — the backend just signals. Additive to `WsServerMessage`.
 */
export interface ConversationOpenMessage {
  readonly type: "conversation.open";
  /** Effective visual group parent; absent = ungrouped. */
  readonly tabGroupParentId?: string;
  readonly conversationId: string;
  /**
   * The conversation's actual workspace id, so a frontend can open/focus it
   * in the correct workspace instead of stamping it with the viewer's current
   * workspace.
   */
  readonly workspaceId: string;
  /**
   * The conversation's persisted per-conversation model when set (absent =
   * default provider model), so a frontend can stamp the new tab with the
   * conversation's ACTUAL model rather than the globally-selected one
   * (fix-toolcall-duplicate-keys plan Part 4).
   */
  readonly model?: string;
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
 * compacted (summarized). `historyEpoch` is the persisted replacement count:
 * missing storage value = 0; every successful replacement increments it once,
 * including empty replacements. On a different epoch, clients invalidate their
 * conversation cache and refetch `GET /conversations/:id?sinceSeq=0`.
 */
export interface ConversationCompactedMessage {
  readonly type: "conversation.compacted";
  readonly conversationId: string;
  readonly newConversationId: string;
  readonly messagesSummarized: number;
  readonly messagesKept: number;
  readonly historyEpoch: number;
}

// ─── Plugin manager (plan 05) ────────────────────────────────────────────────
//
// The wire shapes for the plugin management API (HTTP routes + the
// `extensions-changed` broadcast). Tier/trust mirror the kernel's
// `PluginTier`/`TrustLevel` (stable three-value enums — the manager's
// manifest→row mapping is the drift detector: any kernel-side change fails
// the assignment there at compile time).

/** Classification tier of a plugin (mirror of the kernel's `PluginTier`). */
export type PluginTier = "core" | "providers" | "standard";

/** Trust level of a plugin (mirror of the kernel's `TrustLevel`). */
export type PluginTrustLevel = "bundled" | "local" | "external";

/** How a persisted override came to be (absent in plan-04-era records). */
export type PluginOverrideKind = "unloaded" | "disabled";

/** The persisted user override for a discovered plugin (wire shape). */
export interface PluginOverrideInfo {
  readonly kind?: PluginOverrideKind;
  readonly reason?: string;
  readonly disabledAt?: string;
}

/** A plugin currently loaded and live — the manager's `loaded` table rows. */
export interface LoadedPluginRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tier: PluginTier;
  readonly trust: PluginTrustLevel;
  /** True for tier "core" — the server refuses to unload it. */
  readonly locked: boolean;
  readonly dependsOn: readonly string[];
  /**
   * The plugin's frontend section (plan 03), present when the loaded plugin
   * declares one AND its entry file is servable (resolved inside the plugin
   * directory). `apiVersion`/`entry` mirror the manifest; `bust` is the entry
   * file's mtimeMs — the SAME value the backend loader uses as its `?v=`
   * cache-bust query — so clients can build content-versioned import URLs.
   */
  readonly frontend?: LoadedPluginFrontend;
}

/** The wire shape of a servable frontend section (plan 03). */
export interface LoadedPluginFrontend {
  readonly apiVersion: string;
  readonly entry: string;
  readonly bust: string;
}

/** A plugin the system refused or failed to load — disabled-with-reason. */
export interface DisabledWithReasonRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tier: PluginTier;
  readonly trust: PluginTrustLevel;
  readonly reason: string;
}

/** A plugin present on disk but not loaded — the manager's second table. */
export interface DiscoveredPluginRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tier: PluginTier;
  readonly trust: PluginTrustLevel;
  /** Absolute plugin directory. */
  readonly dir: string;
  /**
   * The persisted user override, if any. Absent = a fresh discovery the
   * consent gate renders UNCHECKED; present rows distinguish a deliberate
   * unload (`kind: "unloaded"`) from an explicit disable (`"disabled"`).
   */
  readonly override?: PluginOverrideInfo;
}

/** An override record whose plugin directory is gone — a greyed-out row. */
export interface MissingPluginRow {
  readonly id: string;
  readonly reason?: string;
  readonly disabledAt?: string;
}

/** Response for `GET /plugins` — the two manager tables + the missing strip. */
export interface PluginListResponse {
  readonly loaded: readonly LoadedPluginRow[];
  readonly disabledWithReason: readonly DisabledWithReasonRow[];
  readonly discovered: readonly DiscoveredPluginRow[];
  readonly missing: readonly MissingPluginRow[];
}

/** One directory that failed scan validation (manifest missing/unparsable/invalid). */
export interface InvalidPluginDir {
  readonly dir: string;
  readonly errors: readonly string[];
}

/** One directory whose (valid) manifest is incompatible with the kernel. */
export interface IncompatiblePluginDir {
  readonly dir: string;
  readonly id: string;
  readonly reason: string;
}

/**
 * Response for `POST /plugins/scan` — the manual scan's product (§5): newly
 * discovered plugins are UNCHECKED (the consent gate — the scan never
 * auto-loads), broken directories report their validation errors.
 */
export interface PluginScanResponse {
  /** The plugins root that was scanned. */
  readonly root: string;
  /** Fresh discoveries: loadable, not loaded, no override. */
  readonly newPlugins: readonly DiscoveredPluginRow[];
  /** Directories that failed manifest/entry validation. */
  readonly invalid: readonly InvalidPluginDir[];
  /** Valid manifests incompatible with the running kernel. */
  readonly incompatible: readonly IncompatiblePluginDir[];
}

/** The mutation a plugin-management route performed. */
export type PluginAction = "load" | "unload" | "reload" | "forget";

/** Why a plugin operation was refused (HTTP 409/404 — see the route docs). */
export type PluginBlockReason =
  /** Core plugins cannot be unloaded (never force-able). */
  | "core-locked"
  /** Unloading would leave zero loaded providers (never force-able). */
  | "last-provider"
  /** Loaded dependents exist — retry with `force` (the dependents are listed). */
  | "cascade-needs-force"
  /** The target plugin is not currently loaded. */
  | "not-loaded"
  /** No such plugin was found (no loadable directory with that id). */
  | "not-found"
  /** The target is already loaded (load; use reload). */
  | "already-loaded"
  /** The engine refused or failed the operation (reason in `message`). */
  | "engine-refused";

/** Successful plugin-management operation (HTTP 200). */
export interface PluginOpSuccess {
  readonly ok: true;
  readonly action: PluginAction;
  readonly id: string;
  /** Forced unload: the dependents that were unloaded before the target. */
  readonly cascade?: readonly string[];
  /** Forced reload: dependents unloaded around the target (engine report). */
  readonly unloadedDependents?: readonly string[];
  /** Forced reload: dependents reloaded after the target (engine report). */
  readonly reloadedDependents?: readonly string[];
  /** Whether a saved override record was removed (load / reload / forget). */
  readonly clearedOverride?: boolean;
  /** Forced ops stop ALL agents first — how many in-flight turns aborted. */
  readonly stoppedAgents?: number;
}

/** Refused plugin-management operation (HTTP 404 / 409). */
export interface PluginOpBlocked {
  readonly ok: false;
  readonly action: PluginAction;
  readonly id: string;
  readonly reason: PluginBlockReason;
  /** Human-readable reason (server-log grammar) for the UI to surface. */
  readonly message: string;
  /** For `cascade-needs-force`: the loaded dependents a force would remove. */
  readonly dependents?: readonly string[];
}

/** Response for the plugin-management mutation routes. */
export type PluginOpResponse = PluginOpSuccess | PluginOpBlocked;

/**
 * Broadcast to ALL connected WS clients after every plugin-manager mutation
 * (load / unload / reload / scan / forget) so every connected frontend
 * refetches the extension list AND the surface catalog (§11 multi-client
 * coherence). The payload is intentionally minimal — the client refreshes
 * from `GET /plugins` + the surface catalog rather than diffing here.
 */
export interface ExtensionsChangedMessage {
  readonly type: "extensions-changed";
  readonly action: "load" | "unload" | "reload" | "scan" | "forget";
  /** The plugin the action applied to (absent for a scan). */
  readonly pluginId?: string;
}

// ─── Per-workspace plugin enablement (plan 06 §6.6) ─────────────────────────
//
// The workspace modal's read+write contract for "is this plugin used HERE".
// The routes are thin shells over the workspace-plugin-config core service;
// the state-transition + validation logic lives THERE (pure, unit-tested).

/**
 * The wire form of a per-workspace plugin state: `"enabled"` / `"disabled"`
 * — an explicit record — or the string `"undefined"` for NO record (the
 * blank slate, §7). The triple is spelled out on the wire (rather than
 * omitting the field) so a client can render all three states uniformly.
 */
export type WorkspacePluginStateValue = "enabled" | "disabled" | "undefined";

/**
 * One row of `GET /workspaces/:id/plugins` — a plugin's effective state in
 * the workspace plus the metadata the modal needs (unloaded → greyed;
 * core → locked).
 */
export interface WorkspacePluginRow {
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly state: WorkspacePluginStateValue;
  /** Whether the plugin is currently loaded globally (plan 05). */
  readonly loaded: boolean;
  /** True for tier "core" — the per-workspace state cannot be changed. */
  readonly locked: boolean;
}

/**
 * Response for `GET /workspaces/:id/plugins` — this workspace's effective
 * plugin states. READING triggers read-through materialization (§6.1):
 * the first read snapshots inherited records from the default workspace
 * (Core → `enabled` always). `enabledProviderCount` is folded in for
 * convenience; the dedicated `providers-status` route reports the same
 * signal without parsing the full list.
 */
export interface WorkspacePluginsResponse {
  readonly workspaceId: string;
  readonly plugins: readonly WorkspacePluginRow[];
  /** Loaded provider-tier plugins effectively enabled here (§6.5 guardrail). */
  readonly enabledProviderCount: number;
}

/**
 * Request body for `PUT /workspaces/:id/plugins/:pluginId` — set/clear
 * this workspace's state for one plugin. `"unset"` returns it to the
 * blank slate (no record). The server refuses (`core-locked` /
 * `unloaded`, HTTP 409) changes for CORE plugins and for plugins that are
 * not currently loaded — strict layering: only the global plugin-manager
 * loads code (§7).
 */
export interface SetWorkspacePluginStateRequest {
  readonly state: "enabled" | "disabled" | "unset";
}

/** Response for `PUT /workspaces/:id/plugins/:pluginId` (HTTP 200). */
export interface SetWorkspacePluginStateResponse {
  readonly workspaceId: string;
  readonly pluginId: string;
  /** The resulting effective state (`"undefined"` after `"unset"`). */
  readonly state: WorkspacePluginStateValue;
}

/** Why a `PUT /workspaces/:id/plugins/:pluginId` was refused (HTTP 409). */
export type SetWorkspacePluginStateBlockReason = "core-locked" | "unloaded";

/** Refused per-workspace state change (HTTP 409). */
export interface SetWorkspacePluginStateBlocked {
  readonly workspaceId: string;
  readonly pluginId: string;
  readonly reason: SetWorkspacePluginStateBlockReason;
  /** Human-readable reason (server-log grammar) for the UI to surface. */
  readonly message: string;
}

/** Response for `GET /workspaces/:id/plugins/providers-status` (§6.5). */
export interface WorkspacePluginProvidersStatusResponse {
  readonly workspaceId: string;
  /**
   * Loaded provider-tier plugins effectively `enabled` in this workspace.
   * `0` is the first-boot guardrail signal (§7): show a visible "no
   * providers enabled" prompt instead of a silently empty model picker.
   */
  readonly enabledProviderCount: number;
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

/** Body for `PUT /conversations/:id/tab-group`. null = remove from its group (ungroup). */
export interface SetTabGroupRequest {
  readonly parentId: string | null;
}

/** Response for `PUT /conversations/:id/tab-group` — the new EFFECTIVE value. */
export interface TabGroupResponse {
  readonly conversationId: string;
  readonly tabGroupParentId: string | null;
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

/**
 * Response of `GET /workspaces` — the workspaces sorted by `lastActivityAt`
 * desc. The optional `?archived=` query selects which workspaces are included:
 * `"true"` → archived only, `"all"` → every workspace; absent (or any other
 * value) → non-archived only (the home grid's default view).
 */
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

// ─── Computers ───────────────────────────────────────────────────────────────

/**
 * Response of `GET /computers` — every remote computer discovered from the
 * system's `~/.ssh/config`, sorted by `alias`. Parallel to
 * `WorkspaceListResponse`: each entry is a `ComputerEntry` (a `Computer` plus a
 * usage count). There is no Computer CRUD — to add one, the user adds a `Host`
 * block to `~/.ssh/config` and Dispatch discovers it on the next read.
 */
export interface ComputerListResponse {
  readonly computers: readonly ComputerEntry[];
}

/**
 * Response of `GET /computers/:alias` — a single computer. Parallel to
 * `WorkspaceResponse` (the entity itself). `alias` is the `computerId` users
 * select; the remaining fields are resolved from the SSH config.
 */
export interface ComputerResponse extends Computer {}

/**
 * Response of `GET /computers/:alias/status` — the live connection state of a
 * computer (whether Dispatch currently holds an open SSH session to it). Drives
 * the frontend connection indicator. `error` is present only when
 * `state === "error"`; `knownHost` mirrors the read-only `Computer` field.
 */
export interface ComputerStatusResponse {
  readonly alias: string;
  readonly state: "disconnected" | "connecting" | "connected" | "error";
  readonly error?: string;
  readonly knownHost: boolean;
}

/**
 * Body of `PUT /conversations/:id/computer` — set or clear the conversation's
 * persisted computer selection (the computer analog of `SetCwdRequest`). Pass
 * `null` to clear → the conversation inherits the workspace's
 * `defaultComputerId`, then `null`/local. An unknown alias is not validated here
 * (the connection resolves at turn time; an unreachable host → turn error, not
 * a 400). Mirrors the cwd/model PUT clear semantics.
 */
export interface SetConversationComputerRequest {
  readonly computerId: string | null;
}

/**
 * Response of `GET /conversations/:id/computer`. `computerId` is the persisted
 * SSH `Host` alias, or `null` when never set (the conversation then inherits
 * the workspace default → local). Parallel to `CwdResponse`.
 */
export interface ConversationComputerResponse {
  readonly conversationId: string;
  readonly computerId: string | null;
}

/**
 * Body of `PUT /workspaces/:id/default-computer` — set or clear the workspace's
 * default computer (the computer analog of `SetWorkspaceDefaultCwdRequest`).
 * `null` means local (no SSH). Conversations in the workspace with no
 * `computerId` of their own inherit this.
 */
export interface SetWorkspaceDefaultComputerRequest {
  readonly computerId: string | null;
}

/**
 * Response of `POST /computers/:alias/test` — the result of a one-shot
 * connectivity probe (Dispatch opens an SSH connection to the alias, runs a
 * trivial command, then closes). `ok` is true on success; `error` carries the
 * failure reason (e.g. auth refused, host unreachable) when `ok` is false.
 */
export interface TestComputerResponse {
  readonly alias: string;
  readonly ok: boolean;
  readonly error?: string;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

/**
 * The per-workspace Heartbeat config — a single record stored per workspace.
 *
 * A heartbeat is an AI that runs on a configurable loop per workspace: when
 * `enabled`, the backend summons a NEW conversation every `intervalMinutes`
 * minutes, gives the heartbeat AI `systemPrompt` + sends `taskPrompt` as the
 * opening user message, and inherits the workspace's computer (SSH) + cwd +
 * standard tool kit. The main purpose is monitoring (e.g. checking if chats
 * are stuck).
 *
 * `model` is a model name in `<credentialName>/<model>` form (one of the strings
 * from `GET /models`), or the empty string to use the server default.
 * `reasoningEffort` is `null` to inherit the workspace default, or an explicit
 * level. The scheduler resets its timer after each run completes (not a fixed
 * wall-clock schedule); on backend restart it resumes scheduling for enabled
 * heartbeats.
 *
 * `inactiveOnly` (default `true`) gates each fire on the configured workspace
 * having NO active agents (no conversation with status `"active"` or `"queued"`):
 * the heartbeat stays quiet while the user is actively working, and only fires
 * when the workspace is idle. Set `false` to fire unconditionally.
 */
export interface HeartbeatConfig {
  /** Whether the heartbeat loop is active for this workspace. */
  readonly enabled: boolean;
  /**
   * When `true` (the default), the heartbeat SKIPS a fire when the configured
   * workspace has any active agents — conversations whose persisted status is
   * `"active"` (driving a turn) or `"queued"` (waiting on the message queue).
   * The fire is silently skipped (no run is recorded); the scheduler re-arms
   * and tries again at the next interval. When `false`, the heartbeat fires
   * unconditionally regardless of workspace activity. The spawned heartbeat
   * conversation lives in the DEDICATED heartbeat workspace, so it never
   * counts as an "active agent" of the configured workspace (no self-block).
   */
  readonly inactiveOnly: boolean;
  /** Custom system prompt for the heartbeat AI (empty = no system prompt). */
  readonly systemPrompt: string;
  /** Task prompt sent as the first user message when the heartbeat fires. */
  readonly taskPrompt: string;
  /** How often to fire, in minutes (default 30). */
  readonly intervalMinutes: number;
  /** Model name (`<credentialName>/<model>`), or empty string = server default. */
  readonly model: string;
  /** Reasoning-effort level, or `null` = inherit the workspace default. */
  readonly reasoningEffort: ReasoningEffort | null;
}

/**
 * Body of `PUT /workspaces/:id/heartbeat` — a partial update. All fields are
 * optional; only the provided fields are applied. `reasoningEffort` accepts
 * `null` to clear to the workspace default. `intervalMinutes` must be a positive
 * integer (clamped server-side to a minimum of 1). An unrecognized
 * `reasoningEffort` → HTTP 400.
 */
export interface UpdateHeartbeatRequest {
  readonly enabled?: boolean;
  readonly inactiveOnly?: boolean;
  readonly systemPrompt?: string;
  readonly taskPrompt?: string;
  readonly intervalMinutes?: number;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort | null;
}

/** The status of a single heartbeat run. */
export type HeartbeatRunStatus = "running" | "completed" | "stopped";

/**
 * One heartbeat run — created each time the heartbeat fires. A run tracks the
 * conversation it spawned and its lifecycle. `triggeredAt` is an ISO-8601
 * timestamp. `status` is `"running"` while the turn is in flight,
 * `"completed"` when the turn sealed normally, or `"stopped"` when the user
 * stopped it via the stop endpoint (the turn is aborted and seals `"stopped"`).
 */
export interface HeartbeatRun {
  readonly id: string;
  readonly conversationId: string;
  readonly triggeredAt: string;
  readonly status: HeartbeatRunStatus;
}

/** Response of `GET /workspaces/:id/heartbeat/runs` — runs, most-recent first. */
export interface HeartbeatRunsResponse {
  readonly runs: readonly HeartbeatRun[];
}

/** Response of `POST /workspaces/:id/heartbeat/runs/:runId/stop`. */
export interface StopHeartbeatRunResponse {
  readonly ok: true;
}

// ─── Search backend selection ─────────────────────────────────────────────────

/**
 * Re-exported wire types for the global search-backend selection
 * (`GET/PUT /search/config`). The web frontend consumes these directly.
 */
export type {
  SearchBackendAvailability,
  SearchBackendConfigResponse,
  UpdateSearchConfigRequest,
} from "@dispatch/wire";

// ─── Provider concurrency limits ──────────────────────────────────────────────

/**
 * Response of `GET /concurrency/limits` — all providers with configured
 * concurrency limits. Each entry pairs a provider id (e.g. "umans",
 * "opencode-1") with its maximum concurrent in-flight requests. Providers
 * not listed here have no limit (unlimited).
 */
export interface ConcurrencyLimitsResponse {
  readonly limits: readonly { readonly providerId: string; readonly limit: number }[];
}

/**
 * Body of `PUT /concurrency/limits/:providerId` — set or update the concurrency
 * limit for a provider. `limit` must be a positive integer. When a limit is
 * set, requests beyond the limit queue (oldest-agent-first) rather than being
 * sent immediately.
 */
export interface SetConcurrencyLimitRequest {
  readonly limit: number;
}

/** Response of `GET/PUT /concurrency/limits/:providerId` — the configured limit. */
export interface ConcurrencyLimitResponse {
  readonly providerId: string;
  readonly limit: number;
}

/**
 * One provider's live concurrency status.
 *
 * - `inFlight`: how many slots are currently held (tokens being generated).
 * - `queued`: how many agents are waiting for a slot.
 * - `paused`: whether the queue is paused due to a 429 backoff.
 * - `pausedUntil`: when the pause expires (epoch-ms), present only when paused.
 * - `cooldownMs`: the per-slot release cooldown (ms). A recycled slot is held
 *   this long before the next waiter is admitted — covers the upstream
 *   provider's accounting lag. Configurable + persisted per provider.
 * - `autoReduced`: whether the limit was auto-reduced by 1 after a 429
 *   (adaptive headroom, one-way, persisted). The user restores the limit
 *   manually via `PUT /concurrency/limits/:providerId`, which clears the flag.
 *   When `true`, the frontend renders a visible notice/banner.
 * - `autoReducedFrom`: the original limit before auto-reduction (present only
 *   when `autoReduced` is true).
 * - `notice`: a human-readable notice string for the frontend to render as a
 *   banner when the limit was auto-reduced (present only when `autoReduced`).
 */
export interface ConcurrencyStatusEntry {
  readonly providerId: string;
  readonly limit: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly paused: boolean;
  readonly pausedUntil?: number;
  readonly cooldownMs: number;
  readonly autoReduced: boolean;
  readonly autoReducedFrom?: number;
  readonly notice?: string;
}

/**
 * Response of `GET /concurrency/status` — live status for every provider with a
 * configured limit. Providers without a limit are absent (they are unlimited).
 */
export interface ConcurrencyStatusResponse {
  readonly providers: readonly ConcurrencyStatusEntry[];
}

// ─── Provider concurrency cooldown ────────────────────────────────────────────

/**
 * Response of `GET /concurrency/cooldown/:providerId` — the per-slot release
 * cooldown (ms) for a provider. A recycled slot is held this long before the
 * next waiter is admitted, covering the upstream provider's accounting lag.
 * When no cooldown was explicitly set, the server default (350ms) is returned.
 */
export interface ConcurrencyCooldownResponse {
  readonly providerId: string;
  readonly cooldownMs: number;
}

/**
 * Body of `PUT /concurrency/cooldown/:providerId` — set the release cooldown
 * (ms) for a provider. `cooldownMs` must be a non-negative integer (0 = no
 * cooldown, instant re-admission). The value is persisted and applied to
 * subsequently recycled slots.
 */
export interface SetConcurrencyCooldownRequest {
  readonly cooldownMs: number;
}

// ─── Account usage (Claude / Codex subscription quotas) ───────────────────────
//
// Subscription quota usage polled from each provider's first-party account
// API (Claude `GET /api/oauth/usage`, Codex `GET /backend-api/wham/usage`),
// cached server-side. Distinct from per-turn token `Usage`: these are the
// account's plan allowance windows, never estimated from token counts.

/**
 * The subscription accounts the usage service reports on. `hyper` is a daily
 * Hypercredit allowance (Hyper's API reports only the balance — the allowance
 * and reset time are user settings, see `AccountUsageDailyCredits`).
 */
export type AccountUsageProviderId = "claude" | "codex" | "hyper";

/**
 * Freshness/availability of one provider's report:
 * - `fresh`          — the last refresh succeeded and is within the cache TTL.
 * - `stale`          — the latest refresh FAILED; `limits` are the last good
 *                      report (≤ 24h old), see `fetchedAt` / `error`.
 * - `unavailable`    — refresh failed and there is no last-good report.
 * - `unsupported`    — a credential exists but cannot query subscription usage
 *                      (e.g. a plain Anthropic API key).
 * - `not-configured` — no credential / the auth extension is not loaded.
 */
export type AccountUsageState =
  | "fresh"
  | "stale"
  | "unavailable"
  | "unsupported"
  | "not-configured";

/** Severity of a single limit: `warning` ≥ 90% used, `exhausted` ≥ 100%. */
export type AccountUsageLimitStatus = "ok" | "warning" | "exhausted" | "unknown";

/**
 * One quota meter. Percent meters have `unit: "percent"`, `limit: 100`.
 * Spend meters (`kind: "spend"`, `unit: "usd"`) may have `limit: null` when the
 * cap is unlimited/unset — never treat that as a zero-dollar cap.
 */
export interface AccountUsageLimit {
  /** Stable id, e.g. `claude:5h`, `claude:7d:opus`, `codex:primary`, `codex:spark:secondary`. */
  readonly id: string;
  /** Human label, e.g. "5 Hour", "7 Day (Opus)", "Spark · 5 hours". */
  readonly label: string;
  readonly kind: "window" | "spend";
  /** Window id, e.g. `5h`, `7d`, `30d`, `extra`. */
  readonly windowId: string;
  /** True for account-wide windows that gate every request. */
  readonly shared: boolean;
  /** Model family / metered-feature slug for scoped meters, else null. */
  readonly tier: string | null;
  /** Window length in ms (null when unknown, e.g. spend meters). */
  readonly durationMs: number | null;
  /** Epoch-ms when the window resets (null when unknown). */
  readonly resetsAt: number | null;
  /** `credits` = Hypercredits (`limit` = the daily allowance). */
  readonly unit: "percent" | "usd" | "credits";
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
  /** 0..1 (null when there is no cap). */
  readonly usedFraction: number | null;
  readonly remainingFraction: number | null;
  readonly status: AccountUsageLimitStatus;
}

/** Codex paid-credit details (from `/wham/usage` `credits` + `spend_control`). */
export interface AccountUsageCredits {
  readonly hasCredits: boolean | null;
  readonly unlimited: boolean | null;
  readonly overageLimitReached: boolean | null;
  /** Remaining credit balance as reported (string or number upstream; normalized to number). */
  readonly balance: number | null;
  readonly spendControlReached: boolean | null;
}

/** One provider's usage report as served to clients. Never carries credentials. */
export interface AccountUsageReport {
  readonly provider: AccountUsageProviderId;
  /** Display name: "Claude" / "Codex". */
  readonly label: string;
  readonly state: AccountUsageState;
  readonly account: {
    readonly accountId: string | null;
    readonly email: string | null;
    readonly planType: string | null;
  } | null;
  readonly limits: readonly AccountUsageLimit[];
  /**
   * Plan-level verdict (Codex): `limitReached` = plan allowance consumed;
   * `canServe` = the account can still serve requests (credits may fund
   * overage). Null when unknown (Claude reports per-window only).
   */
  readonly limitReached: boolean | null;
  readonly canServe: boolean | null;
  /** True when Codex credits fund requests past an exhausted plan window. */
  readonly creditOverage: boolean;
  readonly credits: AccountUsageCredits | null;
  /** Daily credit allowance details (Hyper only; null for other providers). */
  readonly dailyCredits: AccountUsageDailyCredits | null;
  /** Epoch-ms of the report's data (last successful fetch), null if never. */
  readonly fetchedAt: number | null;
  /** Epoch-ms of the last refresh attempt (success or failure), null if never. */
  readonly lastAttemptAt: number | null;
  /** Epoch-ms after which the server will refresh on the next request. */
  readonly nextRefreshAt: number | null;
  /** Last refresh failure message (sanitized, no secrets), null on success. */
  readonly error: string | null;
}

/**
 * Daily credit allowance (Hyper). Hyper's `GET /v1/credits` returns only the
 * balance, so `allowance` (default 250) and the reset time are settings:
 * - `resetAnchor`: an epoch-ms instant of ANY past or future refresh; resets
 *   recur every 24h from it (`resetsAt` on the limit is the next one).
 * - `resetSource`: `manual` (user-set), `detected` (inferred from an observed
 *   balance refill — approximate, ± the poll interval), or null (unknown ⇒ no
 *   `resetsAt`, so no pace marker).
 */
export interface AccountUsageDailyCredits {
  /** Current balance as reported (may exceed `allowance` with purchased bundles). */
  readonly balance: number;
  readonly allowance: number;
  readonly resetAnchor: number | null;
  readonly resetSource: "manual" | "detected" | null;
}

/**
 * Body of `PUT /usage/:provider/settings` (only `hyper` has settings). Omitted
 * fields are unchanged. `dailyAllowance` must be a positive integer;
 * `resetAnchor` is an epoch-ms refresh instant, or `null` to clear the manual
 * time (falling back to a detected one, if any). Responds with the provider's
 * refreshed `AccountUsageReport`; 400 invalid body, 404 provider without settings.
 */
export interface UpdateAccountUsageSettingsRequest {
  readonly dailyAllowance?: number;
  readonly resetAnchor?: number | null;
}

/** Response of `GET /usage` — one report per provider, in fixed order (claude, codex, hyper). */
export interface AccountUsageResponse {
  readonly providers: readonly AccountUsageReport[];
  /** Server clock (epoch-ms) when this response was built — use it to compute window progress. */
  readonly servedAt: number;
}
