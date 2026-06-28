/**
 * @dispatch/wire — pure wire types shared by the kernel, the transport
 * contract, and out-of-repo clients (the web frontend).
 *
 * Types ONLY: zero runtime, zero `@dispatch/*` dependencies, so a client can
 * depend on the wire without pulling the kernel runtime.
 */

// ─── Conversation model ─────────────────────────────────────────────────────

/** Who produced a message. */
export type Role = "system" | "user" | "assistant" | "tool";

/** Opaque identifier for a turn (one user→assistant cycle). */
export type TurnId = string & { readonly __brand: "TurnId" };

/**
 * Opaque identifier for a step (one LLM round-trip within a turn). It is the
 * authoritative grouping key for the tool calls a model batches together in a
 * single step (parallel/batched calls): every `tool-call`/`tool-result` event
 * and every persisted tool chunk (`ToolCallChunk`/`ToolResultChunk`) from the
 * same step carries the SAME `stepId`, so a client groups a batch purely by
 * equality — identically on the live stream and in replayed history. Per-turn
 * unique and gap-free in step order; treat it as opaque (do not parse it). The
 * runtime derives it deterministically from the turn id + 0-based step index.
 */
export type StepId = string & { readonly __brand: "StepId" };

/**
 * A chunk is one ordered piece of a message — the atomic unit of the
 * append-only conversation log. Discriminated by `type`.
 */
export type Chunk =
  | TextChunk
  | ThinkingChunk
  | ToolCallChunk
  | ToolResultChunk
  | ErrorChunk
  | SystemChunk
  | ImageChunk;

/** A piece of plain text content from the assistant or user. */
export interface TextChunk {
  readonly type: "text";
  readonly text: string;
}

/** A piece of model reasoning / thinking content (e.g. extended thinking). */
export interface ThinkingChunk {
  readonly type: "thinking";
  readonly text: string;
}

/**
 * A model's request to run a tool. The kernel routes by `name`; the tool
 * implementation never sees this directly — it receives parsed `input` via
 * `ToolContract.execute`.
 */
export interface ToolCallChunk {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  /**
   * The step that produced this call — generation provenance stamped by the
   * runtime when the model emits the call (NOT storage metadata like `seq`,
   * which is why it lives on the chunk and travels with it through persistence
   * and replay). Tool calls a model batches together in one step share the same
   * `stepId`: the grouping key for rendering a parallel batch as one unit, and
   * equal to the `stepId` on the matching `tool-call` AgentEvent. Optional:
   * absent on chunks reconstructed outside a turn and on rows persisted before
   * this field existed, so a consumer must tolerate its absence (render
   * ungrouped).
   */
  readonly stepId?: StepId;
}

/**
 * The result of a tool execution, attributed to the originating tool-call id.
 * The kernel guarantees every tool-call chunk gets exactly one result chunk
 * (synthesized if interrupted — see reconcile).
 */
export interface ToolResultChunk {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  /**
   * The step that produced the originating call — equal to the `stepId` on the
   * matching `tool-call` chunk (same `toolCallId`) and on the `tool-result`
   * AgentEvent, so a consumer groups a step's calls with their results.
   * Generation provenance, not storage metadata (see `ToolCallChunk.stepId`).
   * Optional for the same reasons; `reconcile` copies it from the originating
   * call onto a synthesized (interrupted) result.
   */
  readonly stepId?: StepId;
}

/** An error that occurred during generation or tool dispatch. */
export interface ErrorChunk {
  readonly type: "error";
  readonly message: string;
  readonly code?: string;
}

/**
 * A system-injected message (e.g. system prompt, context assembly output).
 * Kept distinct from text so the log records provenance.
 */
export interface SystemChunk {
  readonly type: "system";
  readonly text: string;
}

/**
 * An image attached to a message (e.g. a user-pasted screenshot or pasted
 * photo). Carries a `url` that is EITHER a base64 data URL
 * (`data:image/png;base64,…`) OR an `http(s)://` URL. Vision-capable models
 * receive it natively (the provider serializes it to its image-content
 * format); non-vision models never see it directly — the orchestrator's
 * **vision handoff** transcribes it to a text description (via a
 * vision-capable model) and feeds that text instead, so a text-only model can
 * still reason about the image's contents.
 *
 * When a transcription was performed, it is persisted as a separate `text`
 * chunk alongside the `image` chunk in the SAME user message, so the
 * description is reused on every later turn (no re-transcription) and a
 * client renders both the original image and its textual analysis.
 */
export interface ImageChunk {
  readonly type: "image";
  /** Image source: a base64 data URL (`data:image/…;base64,…`) or an `http(s)://` URL. */
  readonly url: string;
  /**
   * Optional MIME type of the image (e.g. `"image/png"`). Inferred from the
   * data URL when absent; present so a client can render an icon/label without
   * parsing the URL. Optional — callers that only have a URL omit it.
   */
  readonly mimeType?: string;
}

/**
 * An image a client attaches to a chat message (`ChatRequest.images`). The
 * transport-facing input shape; the orchestrator converts each `ImageInput`
 * into an `ImageChunk` on the persisted user message. Carries the same `url`
 * semantics as `ImageChunk.url`.
 */
export interface ImageInput {
  /** Image source: a base64 data URL (`data:image/…;base64,…`) or an `http(s)://` URL. */
  readonly url: string;
  /** Optional MIME type (e.g. `"image/png"`). Optional — inferred from the data URL when absent. */
  readonly mimeType?: string;
}

/**
 * A chat message: a role plus an ordered sequence of chunks. Messages are the
 * unit passed to and from the provider; chunks are the unit persisted and
 * rendered.
 */
export interface ChatMessage {
  readonly role: Role;
  readonly chunks: readonly Chunk[];
}

/**
 * A persisted chunk plus its sync metadata. The append-only conversation log
 * stamps every chunk with a **1-based**, monotonic, gap-free, per-conversation
 * `seq` (the sync cursor, assigned in append order) and records the `role` of
 * the message it belongs to. This makes a flat seq-ordered stream both
 * incrementally syncable ("give me chunks after seq N") and regroupable into
 * messages by the client.
 *
 * The 1-based start is a CONTRACTUAL GUARANTEE (not an implementation detail):
 * a conversation's first chunk is always `seq === 1` and numbering never skips,
 * so a client holding only a windowed suffix of the log can derive "older
 * chunks exist server-side" purely from `oldestLoaded.seq > 1` — no separate
 * has-older flag is needed (or provided). `chunk` is the content unit — `Chunk` carries no storage/sync cursor
 * (`seq` lives here on the envelope, not on the chunk, since it is assigned by
 * the store and the provider has no use for it). A chunk MAY still carry
 * generation provenance assigned at production time (e.g. a tool chunk's
 * `stepId`), which is intrinsic to the content and so travels with it.
 */
export interface StoredChunk {
  readonly seq: number;
  readonly role: Role;
  readonly chunk: Chunk;
}

// ─── Reasoning effort ───────────────────────────────────────────────────────

/**
 * The per-request thinking-depth knob: how much extended thinking / reasoning
 * the model should spend before answering. Provider-agnostic ladder; each
 * provider maps a level to its native knob in its own code (e.g. an Anthropic
 * provider maps it to a `thinking.budget_tokens` value) and MAY ignore levels
 * (or the field entirely) that its backend cannot express.
 *
 * Resolution (owned by the session-orchestrator): per-turn request value →
 * persisted per-conversation value → default `"high"`.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

// ─── Usage ──────────────────────────────────────────────────────────────────

/**
 * Token usage counters for a single step. All fields are counts of tokens.
 * Cache fields are optional because not all providers expose cache metrics.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

// ─── Persisted metrics ───────────────────────────────────────────────────────

/**
 * Durable per-step metrics for a completed step — the persisted, replayable
 * counterpart of the live `usage` + `step-complete` events. Combines the step's
 * token usage with its generation timing so a client reopening a past
 * conversation renders the same per-step token/latency breakdown it would have
 * seen live. Built from the turn's events, stored by `conversation-store`, and
 * served by `GET /conversations/:id/metrics`.
 */
export interface StepMetrics {
  readonly stepId: StepId;
  /** The step's token usage (all four counters; cache fields optional per `Usage`). */
  readonly usage: Usage;
  /** Time to first token (stream start → first text/reasoning delta). Optional — see `TurnStepCompleteEvent.ttftMs`. */
  readonly ttftMs?: number;
  /** Decode time (first token → stream end). Optional — see `TurnStepCompleteEvent.decodeMs`. */
  readonly decodeMs?: number;
  /** Total generation time for the step (stream start → stream end). Optional: present only when a clock was available. */
  readonly genTotalMs?: number;
}

/**
 * Durable per-turn metrics for a completed (sealed) turn — the persisted,
 * replayable counterpart of the live `done` event's aggregate `usage` +
 * `durationMs`, plus the per-step breakdown. `usage` is the aggregate across all
 * steps; `steps` carries each step's `StepMetrics` in step order. Persisted per
 * turn by `conversation-store` (returned in turn-append order) and served by
 * `GET /conversations/:id/metrics`. (`turnId` is the plain wire string carried
 * on every `AgentEvent`, the join key to the live stream.)
 */
export interface TurnMetrics {
  readonly turnId: string;
  /** Aggregate token usage across all steps in the turn. */
  readonly usage: Usage;
  /** Total wall-clock duration of the turn (turn start → turn end). Optional: present only when a clock was available. */
  readonly durationMs?: number;
  /** Per-step metrics in step order. */
  readonly steps: readonly StepMetrics[];
  /**
   * **Context size** — tokens the conversation occupies as of this turn: the
   * turn's FINAL step `inputTokens + outputTokens` (the last entry of `steps`),
   * NOT the aggregate `usage` (which sums per-step prompts and overcounts a
   * multi-step turn). The persisted, replayable counterpart of
   * `TurnDoneEvent.contextSize` and equal to it for the same turn. A client
   * reopening a past conversation reads the LAST turn's `contextSize` as the
   * current context usage. Optional: absent when no per-step usage was available.
   */
  readonly contextSize?: number;
}

// ─── Message queue + steering ───────────────────────────────────────────────

/**
 * A user message held in a conversation's message queue, awaiting mid-turn
 * steering delivery. The message-queue extension owns the queue and exposes it
 * as a per-conversation `custom` surface field; this type is the shared shape
 * the surface payload, the enqueue response, and the extension's service all
 * use (so a separate frontend repo can depend on the wire alone to render it).
 */
export interface QueuedMessage {
  /** Stable id (client-visible) for UI keying + dedup. */
  readonly id: string;
  /** The message text the client enqueued. */
  readonly text: string;
  /** When the message was enqueued (epoch-ms). */
  readonly queuedAt: number;
}

/**
 * The payload of the message-queue extension's per-conversation `custom`
 * surface field (`rendererId: "message-queue"`): the current queue snapshot a
 * frontend renders. Carried on the SURFACE channel (NOT the chat stream) — the
 * queue is control/state, distinct from turn content. An empty `messages`
 * array means the queue is empty (no pending steering). The frontend moves a
 * message from this queue surface into the transcript when it is drained (the
 * surface clears) and/or when the matching `TurnSteeringEvent` arrives.
 */
export interface QueuePayload {
  readonly messages: readonly QueuedMessage[];
}

// ─── Outward events ─────────────────────────────────────────────────────────

/**
 * The union of all events the runtime emits outward during a turn.
 * Consumers (transport, persistence, notifications) pattern-match on `type`.
 */
export type AgentEvent =
  | StatusEvent
  | TurnStartEvent
  | TurnInputEvent
  | TurnTextDeltaEvent
  | TurnReasoningDeltaEvent
  | TurnToolCallEvent
  | TurnToolResultEvent
  | TurnToolOutputEvent
  | TurnUsageEvent
  | TurnStepCompleteEvent
  | TurnErrorEvent
  | TurnProviderRetryEvent
  | TurnDoneEvent
  | TurnSealedEvent
  | TurnSteeringEvent;

/** Status change for a conversation (e.g. idle → running). */
export interface StatusEvent {
  readonly type: "status";
  readonly conversationId: string;
  readonly status: string;
}

/** A turn has begun. */
export interface TurnStartEvent {
  readonly type: "turn-start";
  readonly conversationId: string;
  readonly turnId: string;
}

/**
 * The user prompt that opened this turn, surfaced INTO the turn's outward event
 * stream. The user message is persisted only when the turn seals (atomically with
 * the assistant reply), so without this event a client that is merely WATCHING a
 * conversation (subscribed but not the sender) has no source for the prompt text
 * mid-turn — it would see the streaming reply with no preceding user bubble until
 * seal. Emitted once, as the FIRST event of the turn (before `turn-start`), so it
 * is buffered and replayed to every subscriber — live and late-join — exactly like
 * the rest of the turn. The sender already echoes its own prompt optimistically, so
 * a consumer should de-dup against that (e.g. by text); a pure watcher renders it
 * directly. Carries the raw prompt `text` (the same text passed to the provider).
 */
export interface TurnInputEvent {
  readonly type: "user-message";
  readonly conversationId: string;
  readonly turnId: string;
  readonly text: string;
}

/** Incremental text content from the model during a turn. */
export interface TurnTextDeltaEvent {
  readonly type: "text-delta";
  readonly conversationId: string;
  readonly turnId: string;
  readonly delta: string;
}

/** Incremental reasoning / thinking content during a turn. */
export interface TurnReasoningDeltaEvent {
  readonly type: "reasoning-delta";
  readonly conversationId: string;
  readonly turnId: string;
  readonly delta: string;
}

/** The model has requested a tool to be run. */
export interface TurnToolCallEvent {
  readonly type: "tool-call";
  readonly conversationId: string;
  readonly turnId: string;
  /**
   * The step that produced this call. Tool calls a model batches together in
   * one step share the same `stepId` — the grouping key for rendering a
   * parallel batch as one unit. Matches the `stepId` on the matching
   * `tool-result` event and on the persisted tool chunk
   * (`StoredChunk.chunk.stepId`).
   */
  readonly stepId: StepId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** A tool has completed execution. */
export interface TurnToolResultEvent {
  readonly type: "tool-result";
  readonly conversationId: string;
  readonly turnId: string;
  /**
   * The step that produced the originating call. Equal to the `stepId` on the
   * matching `tool-call` event (same `toolCallId`) and on the persisted tool
   * chunk (`StoredChunk.chunk.stepId`), so a client groups a step's calls with
   * their results.
   */
  readonly stepId: StepId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  /**
   * How long the tool took to execute (dispatch → result), in milliseconds —
   * the backend's authoritative execution time, distinct from any client-side
   * wall-clock. Optional: present only when the runtime was given a clock.
   */
  readonly durationMs?: number;
}

/** Streaming output from a tool execution (e.g. shell stdout/stderr). */
export interface TurnToolOutputEvent {
  readonly type: "tool-output";
  readonly conversationId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly data: string;
  readonly stream: "stdout" | "stderr";
}

/** Token usage for the current step or turn. */
export interface TurnUsageEvent {
  readonly type: "usage";
  readonly conversationId: string;
  readonly turnId: string;
  /**
   * The step this usage report belongs to, so a consumer can attribute tokens
   * per step (and join with the matching `step-complete` timing by `stepId`).
   * Optional: absent when the runtime had no step context, and on usage emitted
   * before this field existed.
   */
  readonly stepId?: StepId;
  readonly usage: Usage;
}

/**
 * A step (one LLM round-trip) has completed — the authoritative per-step metrics
 * packet, emitted once at the step's end (after the generation stream finishes),
 * so its timing is final (unlike `usage`, which may arrive mid-stream). Carries
 * the step's generation timing; join to the step's tokens via `stepId` on the
 * `usage` event. All timing fields are optional: present only when the runtime
 * was given a clock, and `ttftMs`/`decodeMs` additionally require that a first
 * content token (text or reasoning) was observed this step.
 */
export interface TurnStepCompleteEvent {
  readonly type: "step-complete";
  readonly conversationId: string;
  readonly turnId: string;
  readonly stepId: StepId;
  /** Time to first token: stream start → first text/reasoning delta. */
  readonly ttftMs?: number;
  /** Decode time: first token → stream end (generation total − TTFT). */
  readonly decodeMs?: number;
  /**
   * Total generation time for the step: stream start → stream end. Present
   * whenever a clock was available, even if no first token was seen (in which
   * case `ttftMs`/`decodeMs` are absent). When a first token was seen,
   * `genTotalMs === ttftMs + decodeMs`.
   */
  readonly genTotalMs?: number;
}

/** An error occurred during the turn. */
export interface TurnErrorEvent {
  readonly type: "error";
  readonly conversationId: string;
  readonly turnId: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * A retryable provider error is being retried with backoff. Emitted once per
 * scheduled retry, BEFORE the sleep, so the UI can show "⚠ Server overloaded —
 * retrying in 5s…" immediately. TRANSIENT: emitted to the frontend but NOT
 * persisted into the model's message history (it never pollutes the prompt).
 *
 * When the retry budget is exhausted, the existing `error` event is emitted and
 * the turn seals — so the final failure is still a persisted error. `attempt` is
 * 0-based (the Nth retry about to happen); `delayMs` is the scheduled sleep
 * before that retry fires.
 */
export interface TurnProviderRetryEvent {
  readonly type: "provider-retry";
  readonly conversationId: string;
  readonly turnId: string;
  /** 0-based: this is the Nth retry about to happen. */
  readonly attempt: number;
  /** ms the client should expect to wait before the retry fires. */
  readonly delayMs: number;
  /** The endpoint's error verbatim (e.g. "HTTP 429: {…overloaded_error…}"). */
  readonly message: string;
  /** The HTTP code when known (e.g. "429"). */
  readonly code?: string;
}

/** The turn has completed (model finished generating). */
export interface TurnDoneEvent {
  readonly type: "done";
  readonly conversationId: string;
  readonly turnId: string;
  readonly reason: string;
  /**
   * Total wall-clock duration of the turn (turn start → turn end), in
   * milliseconds. Optional: present only when the runtime was given a clock.
   */
  readonly durationMs?: number;
  /**
   * Aggregate token usage across all steps in the turn — a convenience total so
   * a consumer need not sum the per-step `usage` events. Optional (absent if the
   * provider reported no usage).
   */
  readonly usage?: Usage;
  /**
   * **Context size** — the number of tokens the conversation now occupies: this
   * (the most recent) turn's FINAL step `inputTokens + outputTokens` (the full
   * prompt sent into the last LLM round-trip plus that round-trip's output). This
   * is the "tokens in context" figure a client renders as the chat's current
   * context usage, and a client treats the LATEST turn's value as the live total.
   *
   * Deliberately NOT the aggregate `usage` above: `usage` SUMS each step's
   * `inputTokens`, which overcounts a multi-step / tool-calling turn because every
   * step re-prefills the growing prompt — the final step's input already includes
   * all prior context, so its input+output is the true occupancy. Optional: absent
   * when no per-step usage was observed this turn (mirrors `usage`). A later field
   * will carry the model's max context-window LIMIT; this is only the current size.
   */
  readonly contextSize?: number;
}

/**
 * The turn has been sealed — all chunks persisted, history is final.
 * This is the hook point for post-turn extensions (compaction, cache-warm).
 */
export interface TurnSealedEvent {
  readonly type: "turn-sealed";
  readonly conversationId: string;
  readonly turnId: string;
}

/**
 * A steering message was injected into an in-flight turn at the tool-result
 * boundary (the model sees it alongside the tool results and may adjust
 * course). Drawn from the conversation's message queue (which the drain
 * clears); the cleared queue arrives as a message-queue SURFACE update, while
 * THIS event carries the injected `text` so a frontend can place a user bubble
 * in the transcript live — and so a late-joining watcher sees it before seal
 * (mirroring `TurnInputEvent` for the opening prompt; emitted into the
 * in-flight buffer by the session-orchestrator).
 *
 * Emitted by the session-orchestrator (in its `drainSteering` wrapper) only
 * when the kernel drained a non-empty queue at a tool-result boundary. If the
 * turn instead ENDS with a non-empty queue (no tool call fired), the queue is
 * carried into a NEW turn whose opening `user-message` event covers the
 * transcript — so no `steering` event is emitted in that case. One `steering`
 * event per drain; the combined text of all drained messages.
 */
export interface TurnSteeringEvent {
  readonly type: "steering";
  readonly conversationId: string;
  readonly turnId: string;
  readonly text: string;
}

// ─── Conversation metadata ───────────────────────────────────────────────────

/**
 * The lifecycle status of a conversation, used for tab persistence across
 * devices. `active` = an agent is currently generating; `queued` = the
 * request is waiting in the per-provider concurrency queue for a slot (not yet
 * generating — the FE shows a loading ring, not dots); `idle` = exists but not
 * generating; `closed` = user dismissed the tab (hidden from the tab bar, not
 * deleted). New conversations start as `idle`; transitions to `active` on
 * turn-start, back to `idle` on turn done/error, and to `closed` on user close.
 * When the concurrency extension is loaded and a request blocks on
 * `acquire()`, `queued` is broadcast (persisted status stays `active`); when
 * the slot is granted, `active` is re-broadcast. A request that gets a slot
 * immediately never emits `queued`.
 */
export type ConversationStatus = "active" | "queued" | "idle" | "closed";

/**
 * Metadata for a conversation, returned by `GET /conversations` (the list
 * endpoint). The title defaults to the first user message (truncated) and can
 * be set via `PUT /conversations/:id/title`. `createdAt` is set on first write;
 * `lastActivityAt` is updated on every append. `status` tracks the tab lifecycle
 * for cross-device persistence.
 */
export interface ConversationMeta {
  readonly id: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly title: string;
  readonly status: ConversationStatus;
  /**
   * The workspace this conversation belongs to. Always present; reads as
   * `"default"` for legacy conversations that were never explicitly assigned.
   * Conversations created with no `workspaceId` default to `"default"`.
   */
  readonly workspaceId: string;
  /**
   * Set on a compacted conversation: points to the archive conversation ID
   * that holds the full pre-compaction history. Absent on conversations
   * that have never been compacted.
   */
  readonly compactedFrom?: string;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

/**
 * Result of a compaction operation. `summary` is the text the model produced;
 * `messagesKept` is how many recent messages were retained after the summary;
 * `messagesSummarized` is how many old messages were replaced by the summary.
 * `newConversationId` is the ID of the new conversation that holds the full
 * pre-compaction history (non-destructive — the original history is preserved).
 */
export interface CompactionResult {
  readonly summary: string;
  readonly newConversationId: string;
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

/**
 * A named, URL-driven grouping of conversations that owns a default cwd.
 * Every conversation belongs to exactly one workspace; conversations that
 * haven't set their own per-conversation cwd inherit `defaultCwd`.
 *
 * Workspaces are backend-owned (so cross-device just works): the workspace
 * entity and each conversation's `workspaceId` live server-side. The
 * `"default"` workspace is always present and non-deletable; conversations
 * created with no `workspaceId` are assigned to `"default"`.
 */
export interface Workspace {
  /** The URL slug (immutable). Lowercase `[a-z0-9-]`, 1–40 chars. */
  readonly id: string;
  /** Display title (editable). Defaults to `id` on creation. */
  readonly title: string;
  /** The workspace's default cwd, or `null` (fall through to server default). */
  readonly defaultCwd: string | null;
  /**
   * The workspace's default computer — an SSH config `Host` alias that
   * conversations in this workspace inherit when they set no `computerId` of
   * their own. `null` means local (no SSH; today's behavior). The computer
   * analog of `defaultCwd`. Resolved per-conversation by `getEffectiveComputer`
   * (per-conv `computerId` → this → `null`/local).
   */
  readonly defaultComputerId: string | null;
  /**
   * Whether the workspace is starred by the user. Starred workspaces receive
   * PRIORITY in the concurrency limiter queue — their agents jump ahead of
   * agents from non-starred workspaces (oldest-agent-first within each group).
   * Defaults to `false` on creation.
   */
  readonly starred: boolean;
  /** Epoch-ms when the workspace was first created. */
  readonly createdAt: number;
  /** Epoch-ms of the most recent conversation activity in this workspace. */
  readonly lastActivityAt: number;
}

/**
 * A workspace entry in the list response (`GET /workspaces`) — a `Workspace`
 * plus a conversation count.
 */
export interface WorkspaceEntry extends Workspace {
  /** Number of conversations assigned to this workspace. */
  readonly conversationCount: number;
}

// ─── Computers ───────────────────────────────────────────────────────────────

/**
 * A read-only view of a remote computer discovered from the system's
 * `~/.ssh/config` — a "computer" is a `Host` alias, NOT an editable entity
 * (there is no Computer CRUD store). To add a computer, the user adds a `Host`
 * block to `~/.ssh/config`; Dispatch discovers it on the next `listComputers()`
 * read. Every field below is resolved from the config (first-match-wins for
 * `HostName`/`User`/`Port`/`IdentityFile`).
 *
 * `alias` is the `computerId` users select — the string persisted per
 * conversation and per workspace (the computer analog of `cwd`). `knownHost`
 * drives the frontend "known/new" indicator and is read-only.
 */
export interface Computer {
  /** The SSH config `Host` alias — also the `computerId` users select. */
  readonly alias: string;
  /** Resolved `HostName`/IP from the config (falls back to the alias itself). */
  readonly hostName: string;
  /** Resolved port (config `Port`, default 22). */
  readonly port: number;
  /** Resolved user (config `User`, default the current user). */
  readonly user: string;
  /** Resolved `IdentityFile` path (from the config, or `null` = default `~/.ssh/id_*`). */
  readonly identityFile: string | null;
  /**
   * Whether the host's key is already in `~/.ssh/known_hosts` (i.e. previously
   * connected). Drives the frontend "known/new" indicator. Read-only.
   */
  readonly knownHost: boolean;
}

/**
 * A computer entry in the list response (`GET /computers`) — a `Computer` plus
 * a usage count. Parallel to `WorkspaceEntry`.
 */
export interface ComputerEntry extends Computer {
  /** Number of conversations/workspaces whose `computerId` resolves to this alias. */
  readonly usageCount: number;
}
