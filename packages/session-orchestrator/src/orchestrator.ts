import type { ConversationStore } from "@dispatch/conversation-store";
import type {
  AgentEvent,
  ChatMessage,
  ConversationToolPolicy,
  EventHookDescriptor,
  ImageInput,
  Logger,
  ModelInfo,
  ProviderContract,
  ReasoningEffort,
  RetryStrategy,
  RunTurnInput,
  RunTurnResult,
  ToolContract,
  ToolDispatchPolicy,
  TurnEndedEvent,
} from "@dispatch/kernel";
import { defineService, type ServiceHandle } from "@dispatch/kernel";
import type { MessageQueueService, QueuedMessage } from "@dispatch/message-queue";
import type { ConcurrencyLimiter } from "@dispatch/provider-concurrency";
import { wrapProviderWithConcurrency } from "@dispatch/provider-concurrency";
import type { SystemPromptService } from "@dispatch/system-prompt";
import { assembleTurnRequest, TurnRequestRejected } from "./assemble.js";
import {
  type CompactionService,
  DEFAULT_COMPACT_PERCENT,
  DEFAULT_KEEP_LAST_N,
  performCompaction,
} from "./compaction.js";
import {
  conversationClosed,
  conversationStatusChanged,
  turnSettled,
  turnStarted,
} from "./hooks.js";
import { createMetricsAccumulator } from "./metrics.js";
import {
  appendCompacted,
  buildUserMessage,
  defaultDispatchPolicy,
  delayFor,
  generateTurnId,
  type MemorySample,
  memoryDelta,
  memorySampleAttributes,
  resolveModelName,
  resolveReasoningEffort,
} from "./pure.js";
import type { ToolAssembly } from "./tools-filter.js";

export {
  type CompactionService,
  compactionHandle,
  createCompactionService,
} from "./compaction.js";
export {
  type ConversationClosedPayload,
  type ConversationCompactedPayload,
  type ConversationOpenedPayload,
  type ConversationStatusChangedPayload,
  type ConversationTabGroupChangedPayload,
  conversationClosed,
  conversationCompacted,
  conversationOpened,
  conversationStatusChanged,
  conversationTabGroupChanged,
  type TurnLifecyclePayload,
  turnSettled,
  turnStarted,
  type WarmCompletedPayload,
  warmCompleted,
} from "./hooks.js";
export {
  cacheWarmHandle,
  createWarmService,
  type WarmResult,
  type WarmService,
  type WarmServiceDeps,
} from "./warm.js";

// --- Vision handoff (lazy, optional) ---

/**
 * Minimal contract the vision-handoff service satisfies. Defined here (not
 * imported from the vision-handoff package) so the orchestrator has NO
 * compile-time dependency on it — the service is resolved lazily at runtime
 * (like the message-queue / system-prompt services), and the feature degrades
 * off cleanly when the extension isn't loaded (images pass through unchanged,
 * which is correct for vision-capable models and a no-op for text-only turns).
 *
 * `prepareForProvider` transforms a message list for the provider: if the
 * active model is vision-capable, messages pass through unchanged; otherwise
 * image chunks are replaced with numbered placeholders (telling the model to
 * call `consult_vision`) and the images are registered for tool access.
 */
export interface VisionHandoffService {
  /**
   * Store images to tmp files and return compact URLs. Each input image's data
   * URL is saved to a tmp file and replaced with a compact HTTP path so the
   * persisted conversation store holds a tiny string, not megabytes of base64.
   * When `saveImageToTmp` is not configured, data URLs pass through unchanged.
   */
  readonly storeImages: (
    conversationId: string,
    images: readonly ImageInput[],
  ) => Promise<readonly ImageInput[]>;

  /** Delete all tmp images for a conversation (on close). Best-effort. */
  readonly purgeConversationImages: (conversationId: string) => Promise<void>;

  readonly prepareForProvider: (
    messages: readonly ChatMessage[],
    currentModelName: string | undefined,
    opts?: {
      readonly conversationId?: string;
      readonly imageLimit?: number;
      readonly compactionModel?: string | null;
      readonly signal?: AbortSignal;
      readonly logger?: Logger;
    },
  ) => Promise<readonly ChatMessage[]>;
}

/**
 * Local handle for the vision-handoff service, keyed by the same ID the
 * vision-handoff extension registers under (`"vision-handoff/service"`). Defined
 * locally (not imported) so the orchestrator has no compile-time dependency on
 * the vision-handoff package — the service is resolved lazily at runtime, and
 * the feature degrades off cleanly when the extension isn't loaded.
 */
export const visionHandoffLocalHandle: ServiceHandle<VisionHandoffService> =
  defineService<VisionHandoffService>("vision-handoff/service");

// --- Broadcast hub types ---

export interface StartTurnInput {
  readonly conversationId: string;
  readonly text: string;
  /**
   * Images attached to this turn (e.g. user-pasted screenshots). Each is
   * appended as an `image` chunk on the persisted user message. For a
   * vision-capable model the images pass through to the provider natively; for
   * a non-vision model the vision handoff transcribes them to text first.
   * Optional — omit for a text-only turn.
   */
  readonly images?: readonly ImageInput[];
  readonly modelName?: string;
  readonly cwd?: string;
  /**
   * The computer to execute this turn's tools on (SSH config alias). Mirrors
   * `cwd`: an explicit per-turn override resolved via `getEffectiveComputer`.
   * Omitted/`undefined` = use the persisted per-conversation / workspace
   * default (LOCAL when none set). The orchestrator never interprets it — it
   * forwards the alias string verbatim (like cwd forwards a path).
   */
  readonly computerId?: string;
  readonly reasoningEffort?: ReasoningEffort;
  /**
   * The workspace this conversation belongs to. Defaults to `"default"` when
   * omitted. On the first turn for a new conversation, the workspaceId is
   * persisted (the workspace is auto-created if missing) so subsequent turns
   * resolve the effective cwd from the workspace's `defaultCwd`.
   */
  readonly workspaceId?: string;
  /**
   * An EXPLICIT system-prompt override. When provided (a string, including the
   * empty string), it is sent to the provider AS-IS and the system-prompt
   * SERVICE is bypassed entirely (no template construction, no
   * persist/reuse). This is how a caller that owns its own prompt (e.g. the
   * heartbeat extension) drives a turn without the templated workspace prompt.
   * Omitted/`undefined` = the existing behavior (construct/reuse via the
   * system-prompt service when loaded).
   */
  readonly systemPrompt?: string;
  /**
   * A human-readable title for the conversation tab. When provided, it is
   * persisted via `setConversationTitle` AFTER the new-conversation workspace
   * setup resolves (so the `meta === null` newness detection still fires and
   * `ensureWorkspace` / `setWorkspaceId` / first-turn system-prompt
   * construction are NOT skipped) and BEFORE the first message append (so the
   * append's auto-title does not overwrite it). Omit to keep the auto-derived
   * title. The caller is responsible for trimming/validation.
   */
  readonly title?: string;
  /**
   * The parent conversation that summoned this one (lineage metadata). When
   * provided, it is persisted via `setParentConversationId` DURING new-
   * conversation workspace setup — AFTER the `meta === null` newness check
   * (so it never pre-creates the meta row and skips workspace assignment,
   * title, or first-turn system-prompt construction — the same ordering
   * hazard already documented for `title`). Persisted on a SEPARATE store
   * key (`conv:{id}:parent`), so it does NOT touch the meta row at all.
   *
   * The agent-management extension persists `parentConversationId` and
   * `toolPolicy` BEFORE calling `startTurn` (plan §5 step 3), so the
   * toolsFilter chain can read the policy during the first turn's tool
   * assembly. The orchestrator re-stamps the same value here idempotently
   * (never overwrites with a different value) and never invents one — it
   * only persists what the caller explicitly passed. Omit for a top-level
   * conversation.
   */
  readonly parentConversationId?: string;
  /**
   * The initial durable tool policy for a new conversation. When provided, it
   * is persisted via `setToolPolicy` DURING new-conversation workspace setup
   * — AFTER the newness check (same hazard avoidance as `title` and
   * `parentConversationId`). Persisted on a SEPARATE store key
   * (`conv:{id}:toolpolicy`), so it never pre-creates the meta row.
   *
   * The orchestrator applies the persisted policy LAST in tool assembly
   * (after the entire `toolsFilter` chain), so no extension filter can
   * re-add a tool into a restricted conversation. Legacy conversations
   * without a persisted policy resolve to `{ mode: "all" }` (backward
   * compatible). Omit for an ordinary (unrestricted) conversation.
   */
  readonly toolPolicy?: ConversationToolPolicy;
}

export type StartTurnResult =
  | { readonly started: true; readonly turnId: string }
  | { readonly started: false; readonly reason: "already-active" };

/** Input to `SessionOrchestrator.enqueue` — the single entry transports call. */
export interface EnqueueInput {
  readonly conversationId: string;
  readonly text: string;
  /**
   * Images attached (the steering / opening message analog of
   * `StartTurnInput.images`). Stored before insertion, then delivered as steering
   * or carried into the opening message of a new turn.
   */
  readonly images?: readonly ImageInput[];
  /** Workspace to stamp on a new conversation. Defaults to `"default"`. */
  readonly workspaceId?: string;
  /**
   * Computer override (SSH alias). Last explicit queued override wins on carry;
   * steering persists it for the next turn, never switches live tool context.
   */
  readonly computerId?: string;
}

/**
 * Result of `SessionOrchestrator.enqueue`. When `startedTurn` is true the
 * conversation was idle and a turn was started (the message is the opening
 * prompt — nothing queued). When false the conversation was active: the message
 * was enqueued onto the steering queue and `queue` is the post-enqueue snapshot
 * (empty when the message-queue extension isn't loaded — degraded: the message
 * is dropped, see `enqueue` docs).
 */
export interface EnqueueResult {
  readonly startedTurn: boolean;
  readonly queue: readonly QueuedMessage[];
}

/**
 * Result of `SessionOrchestrator.cancelQueuedMessage`. `cancelled` is true when
 * a message with the given id was found in the conversation's queue and removed
 * (it will never run — never delivered as steering, never carried into a new
 * turn). `cancelled` is false when the message was not in the queue (already
 * drained/delivered, never existed, unknown conversation) OR when the
 * message-queue extension isn't loaded (degraded — feature off). `queue` is the
 * post-cancel snapshot (empty when no queue extension is loaded).
 */
export interface CancelQueuedMessageResult {
  readonly cancelled: boolean;
  readonly queue: readonly QueuedMessage[];
}

export type TurnEventListener = (event: AgentEvent) => void;

interface ActiveTurn {
  buffer: readonly AgentEvent[];
  turnId: string;
  /** Aborts this turn's kernel runTurn (closeConversation). */
  controller: AbortController;
}

export interface SessionOrchestrator {
  /** During compaction, queues when available (started=false), otherwise reserves a waiting turn. */
  startTurn(input: StartTurnInput): StartTurnResult;
  /**
   * The single entry transports call to deliver a user message. Owns the
   * idle→startTurn vs active/compacting→queue decision (no separate `isActive` race —
   * `startTurn`'s single-flight guard is authoritative). When the conversation
   * is idle, starts a turn (the message is the opening prompt). When active,
   * enqueues onto the steering queue (if the message-queue extension is
   * loaded); with no queue extension loaded the message is dropped and the
   * returned snapshot is empty (degraded — feature off). Await the result: image
   * storage precedes insertion, failures reject, and Stop cancels pending insertion.
   */
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  /**
   * Cancel (remove) a SINGLE queued message by id so it never runs. The single
   * entry transports call to cancel a queued steering message. Resolves the
   * message-queue service lazily (same as `enqueue`); when the extension isn't
   * loaded the call degrades to `{ cancelled: false, queue: [] }`. Idempotent —
   * cancelling a message that is no longer queued (already drained/delivered)
   * returns `{ cancelled: false, ... }` without error.
   */
  cancelQueuedMessage(input: {
    readonly conversationId: string;
    readonly messageId: string;
  }): CancelQueuedMessageResult;
  subscribe(conversationId: string, listener: TurnEventListener): () => void;
  isActive(conversationId: string): boolean;
  /**
   * The number of conversations currently driving a turn (in the
   * `activeConversations` set). Used by host-bin's periodic memory telemetry
   * to tag each RSS sample with the active-conversation count, so growth can
   * be attributed to the streaming/turn path vs an idle baseline.
   */
  getActiveConversationCount(): number;
  /**
   * Explicitly close a conversation (the user closed its tab — distinct from a
   * socket disconnect, which never touches the turn): aborts any in-flight turn
   * (the kernel finishes with `finishReason: "aborted"`, partial messages are
   * persisted and the turn seals normally) and emits the `conversationClosed`
   * hook so per-conversation background work (cache-warming) stops.
   * Idempotent — closing an idle/unknown conversation just emits the hook.
   */
  closeConversation(conversationId: string): { readonly abortedTurn: boolean };
  /**
   * Stop an in-flight generation WITHOUT closing the conversation. Aborts
   * the turn's AbortController — the kernel finishes with
   * `finishReason: "aborted"`, partial messages are persisted, and the turn
   * seals normally (status transitions active → idle via the normal settle
   * path). Pending steering is cancelled (queue surface cleared); enqueue
   * while stopping is dropped. No automatic carry runs after Stop or Close.
   * Idempotent — stopping an idle/unknown conversation clears any stale queue.
   */
  stopTurn(conversationId: string): { readonly abortedTurn: boolean };
  /**
   * Stop ALL in-flight generations globally — the §8 forced-unload semantic:
   * unloading a plugin that is in use requires the swap to land immediately,
   * so every active turn in every workspace dies (plan-00 question 2: the
   * stop is global by design, not attributed per plugin). Iterates the
   * active conversations and applies the same per-conversation stop as
   * `stopTurn` — the kernel finishes each with `finishReason: "aborted"`,
   * partial messages persist, turns seal normally. Returns how many
   * conversations had an in-flight turn aborted.
   */
  stopAll(): { readonly stopped: number };
  handleMessage(input: {
    conversationId: string;
    text: string;
    onEvent: (event: AgentEvent) => void;
    modelName?: string;
    cwd?: string;
    computerId?: string;
    reasoningEffort?: ReasoningEffort;
    workspaceId?: string;
    /** Explicit system-prompt override — see {@link StartTurnInput.systemPrompt}. */
    systemPrompt?: string;
    /** Images attached to this turn — see {@link StartTurnInput.images}. */
    images?: readonly ImageInput[];
    /** Conversation tab title — see {@link StartTurnInput.title}. */
    title?: string;
    /** Parent conversation lineage — see {@link StartTurnInput.parentConversationId}. */
    parentConversationId?: string;
    /** Durable tool policy — see {@link StartTurnInput.toolPolicy}. */
    toolPolicy?: ConversationToolPolicy;
  }): Promise<void>;
}

export const sessionOrchestratorHandle = defineService<SessionOrchestrator>(
  "session-orchestrator/orchestrator",
);

export interface SessionOrchestratorDeps {
  readonly conversationStore: ConversationStore;
  readonly resolveProvider: () => ProviderContract;
  readonly resolveTools: () => readonly ToolContract[];
  readonly resolveDispatch?: () => ToolDispatchPolicy;
  readonly resolveModel?: (
    modelName: string,
  ) => { provider: ProviderContract; model: string } | undefined;
  /**
   * Resolve full `ModelInfo` (including `contextWindow`) for a model name.
   * Used by the compaction service to calculate the auto-compact threshold
   * as a percentage of the context window.
   */
  readonly resolveModelInfo?: (modelName: string) => Promise<ModelInfo | undefined>;
  readonly runTurn: (input: RunTurnInput) => Promise<RunTurnResult>;
  /**
   * Lazily resolves the message-queue service (the steering queue), or
   * `undefined` when the message-queue extension isn't loaded (the feature
   * degrades off: no `drainSteering`, no post-seal carry, `enqueue` drops
   * messages when active). host-bin wires this via `host.getService`; the
   * orchestrator calls it per-turn / per-enqueue so activation order with the
   * message-queue extension doesn't matter. Injected (not ambient) so a turn
   * stays reproducible from its inputs and tests use a fake queue.
   */
  readonly resolveQueue?: () => MessageQueueService | undefined;
  /**
   * Lazily resolves the compaction service, or `undefined` when not loaded.
   * Used for automatic compaction after a turn settles (if the compact
   * threshold is exceeded). Lazy so activation order doesn't matter.
   */
  readonly resolveCompaction?: () => CompactionService | undefined;
  /**
   * Lazily resolves the system-prompt service, or `undefined` when the
   * system-prompt extension isn't loaded. Used to construct the per-
   * conversation system prompt once (first turn) and reuse it (cache-safe) on
   * subsequent turns, and to reconstruct it on compaction. Lazy so activation
   * order doesn't matter.
   */
  readonly resolveSystemPrompt?: () => SystemPromptService | undefined;
  /**
   * Lazily resolves the concurrency limiter, or `undefined` when the
   * provider-concurrency extension isn't loaded (no concurrency limiting —
   * feature degrades off). When present, each resolved provider is wrapped so
   * that a concurrency slot is acquired before the stream starts and released
   * when the stream completes. Lazy so activation order doesn't matter.
   */
  readonly resolveConcurrencyLimiter?: () => ConcurrencyLimiter | undefined;
  /**
   * Lazily resolves the vision-handoff service, or `undefined` when the
   * vision-handoff extension isn't loaded. Used to transcribe image chunks to
   * text for non-vision models before they reach the provider (so a text-only
   * model can still reason about pasted/code images). When `undefined`, images
   * pass through unchanged (correct for vision-capable models; a text-only model
   * would then receive image content its API may reject — the feature degrades
   * off cleanly for text-only turns since there are no images). Lazy so
   * activation order doesn't matter; called per-turn.
   */
  readonly resolveVisionHandoff?: () => VisionHandoffService | undefined;
  /** Apply the per-turn tools filter chain. Injected for testability. */
  readonly applyToolsFilter: (assembly: ToolAssembly) => Promise<ToolAssembly>;
  /**
   * Per-workspace tool gate (plan 06 §6.3). Applied AFTER the entire
   * `applyToolsFilter` chain (so no injection filter can re-add a dropped
   * tool) and BEFORE `applyToolPolicy` (the persisted conversation policy
   * stays the final word). Injected by the extension (which resolves the
   * ledger ownership + workspace-plugin-config services reactively);
   * omitted/absent → no workspace gating (degrade open, e.g. tests).
   */
  readonly applyWorkspaceGate?: (assembly: ToolAssembly) => Promise<ToolAssembly>;
  /**
   * Per-workspace model-usability check (plan 06 §6.5): whether the named
   * model is usable in the given workspace — its provider is loaded AND
   * usable there. `false` → the turn errors immediately and explicitly
   * ("model X unavailable — pick another", §8) — NEVER a silent fallback.
   * Injected by the extension; omitted → no workspace model check (the
   * unknown-model error path is unchanged).
   */
  readonly resolveModelUsability?: (modelName: string, workspaceId: string) => Promise<boolean>;
  /** Base logger (auto-scoped to this extension); childed per turn for span capture. */
  readonly logger?: Logger;
  /** Injected monotonic-ish clock (ms) forwarded to RunTurnInput for timing events. */
  readonly now?: () => number;
  /**
   * Optional process.memoryUsage() sampler, injected for testability. When
   * present, the orchestrator captures a sample immediately before and after
   * each turn's stream completes (`deps.runTurn`) and logs the per-turn delta
   * tagged with conversationId + turnId — correlating RSS growth with the
   * streaming path (the prime leak suspect). When absent (undefined), no
   * per-turn memory telemetry is emitted (feature degrades off cleanly).
   * Pure decision logic stays unchanged; this is additive observability.
   */
  readonly sampleMemory?: () => MemorySample;
  /** Emit a lifecycle event hook to subscribers. Injected from host. */
  readonly emit?: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
}

export interface SessionOrchestratorBundle {
  readonly orchestrator: SessionOrchestrator;
  /** The shared active-conversations set, for use by createWarmService. */
  readonly activeConversations: ReadonlySet<string>;
  /** Shared manual/post-seal compaction completion barriers. */
  readonly compacting: Map<string, Promise<void>>;
}

/**
 * The concrete retry strategy wired into every turn's `RunTurnInput.retry`.
 *
 * `delayFor` is the pure schedule (`5s, 10s, 30s, 60s, 5m, 10m, 15m, 30m`,
 * then repeat 30m until 8h cumulative scheduled sleep) — no I/O, no clock.
 * `sleep` is the abortable I/O effect: a `setTimeout`-based promise that
 * rejects when the turn's abort signal fires (so a retry in flight seals the
 * turn `aborted`). The kernel imports no timer; this is the shell-provided I/O.
 */
export function createRetryStrategy(): RetryStrategy {
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  return { delayFor, sleep };
}

export function createSessionOrchestrator(
  deps: SessionOrchestratorDeps,
): SessionOrchestratorBundle {
  const activeConversations = new Set<string>();
  const compacting = new Map<string, Promise<void>>();
  const compactionQueueWaiters = new Set<string>();
  const subscribers = new Map<string, Set<TurnEventListener>>();
  const activeTurns = new Map<string, ActiveTurn>();
  // Serialize image storage/insertion per conversation; Stop invalidates in-flight work.
  const pendingEnqueues = new Map<string, { cancelled: boolean; tail?: Promise<EnqueueResult> }>();
  // One stateless retry strategy shared by every turn (delayFor is pure; sleep
  // is a stateless setTimeout closure). Wired into each RunTurnInput.retry.
  const retryStrategy = createRetryStrategy();

  function logFailure(conversationId: string, operation: string, turnId?: string) {
    return (err: unknown): void => {
      deps.logger
        ?.child({ conversationId, ...(turnId !== undefined ? { turnId } : {}) })
        .debug(`orchestrator: ${operation} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
    };
  }

  function publishStatus(
    conversationId: string,
    status: "active" | "idle" | "closed" | "queued",
    turnId?: string,
  ): void {
    void deps.conversationStore
      .getWorkspaceId(conversationId)
      .then((workspaceId) => {
        deps.emit?.(conversationStatusChanged, { conversationId, status, workspaceId });
      })
      .catch(logFailure(conversationId, `${status} workspace`, turnId));
  }

  function emitToHub(conversationId: string, event: AgentEvent): void {
    const turn = activeTurns.get(conversationId);
    if (turn !== undefined) {
      turn.buffer = appendCompacted(turn.buffer, event);
    }
    const listeners = subscribers.get(conversationId);
    if (listeners !== undefined) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  function queuedInput(messages: readonly QueuedMessage[]) {
    const computerId = messages.findLast((message) => message.computerId !== undefined)?.computerId;
    return {
      text: messages.map((message) => message.text).join("\n\n"),
      images: messages.flatMap((message) => message.images ?? []),
      // One turn has one computer. The last explicit queued override wins.
      ...(computerId !== undefined ? { computerId } : {}),
    };
  }

  /**
   * Post-turn carry: if a steering queue is available and non-empty, drain it,
   * combine, and start a NEW detached turn whose opening `user-message` carries
   * the combined text (no `steering` event — that's only for mid-turn drain).
   * Returns true iff a new turn was started. Called from `runTurnDetached`'s
   * finally AFTER `activeTurns.delete` (so the new turn's single-flight guard
   * passes) and BEFORE `activeConversations.delete` (skipped when carried, since
   * the new turn re-adds it). May chain — the new turn's own finally re-checks.
   */
  function tryCarryQueue(conversationId: string): boolean {
    const queue = deps.resolveQueue?.();
    if (queue === undefined) return false;
    if (queue.getQueue(conversationId).length === 0) return false;
    const drained = queue.drain(conversationId);
    const result = orchestrator.startTurn({ conversationId, ...queuedInput(drained) });
    return result.started;
  }

  function runTurnDetached({
    conversationId,
    text,
    modelName,
    cwd,
    computerId,
    reasoningEffort: reasoningEffortOverride,
    workspaceId: requestedWorkspaceId,
    systemPrompt: systemPromptOverride,
    images,
    title,
    parentConversationId,
    toolPolicy,
  }: StartTurnInput): void {
    const workspaceId = requestedWorkspaceId ?? "default";
    const turnId = generateTurnId();
    const promptStartedAt = deps.now?.() ?? Date.now();
    const controller = new AbortController();
    activeTurns.set(conversationId, { buffer: [], turnId, controller });
    const pendingCompaction = compacting.get(conversationId);
    // A waiting turn owns the single-flight slot, but must not invalidate the
    // compactor's generating-state recheck until the barrier has completed.
    if (pendingCompaction === undefined) activeConversations.add(conversationId);

    emitToHub(conversationId, { type: "user-message", conversationId, turnId, text });

    // For a NEW conversation the workspace MUST be assigned (persisted)
    // BEFORE getEffectiveCwd runs, so the effective cwd resolves against
    // the intended workspace's defaultCwd rather than the stale "default"
    // workspace returned by getWorkspaceId for a not-yet-persisted
    // conversation. Detect newness via getConversationMeta === null
    // (equivalent to history.length === 0 in practice). Existing
    // conversations keep their assigned workspace — never overwritten.
    // The newness flag is also reused to decide whether to construct
    // (first turn) or get (subsequent turn) the system prompt — see the
    // providerOpts assembly below.
    //
    // An explicit `title` (e.g. the CLI `--title` flag) is persisted HERE,
    // AFTER the workspace setup resolves — deliberately NOT before the turn.
    // Setting it earlier (e.g. in the HTTP route) would pre-create the meta
    // row, make `meta !== null`, and fool this newness check into skipping
    // `ensureWorkspace` / `setWorkspaceId` / first-turn system-prompt
    // construction. By deferring it to here, the title lands after the
    // workspace is assigned but BEFORE the first message append (so the
    // append's auto-title sees a non-"Untitled" title and preserves it).
    //
    // Lineage (`parentConversationId`) and the durable `toolPolicy` follow
    // the EXACT same hazard avoidance as `title`: persisted HERE, after the
    // newness check, using SEPARATE store keys (`conv:{id}:parent` and
    // `conv:{id}:toolpolicy`) that do NOT touch the meta row — so they never
    // pre-create metadata and never skip workspace assignment / title /
    // first-turn system-prompt construction (plan §10.4). The agent-management
    // extension ALSO persists these BEFORE calling startTurn (plan §5 step 3,
    // so the toolsFilter can read the policy during the first turn); re-stamping
    // the same value here is idempotent — the orchestrator never overwrites with
    // a different value and never invents one (only persists what the caller
    // explicitly passed). Legacy/ordinary conversations omit both → no-op.
    const workspaceSetupPromise = (async (): Promise<boolean> => {
      if (pendingCompaction !== undefined) {
        await pendingCompaction;
        activeConversations.add(conversationId);
      }
      const meta = await deps.conversationStore.getConversationMeta(conversationId);
      if (meta === null) {
        await deps.conversationStore.ensureWorkspace(workspaceId);
        await deps.conversationStore.setWorkspaceId(conversationId, workspaceId);
      }
      if (title !== undefined) {
        // Best-effort: a title-set failure must NOT break the turn (the
        // workspace setup above already succeeded). Log and continue — the
        // append's auto-derived title applies instead.
        try {
          await deps.conversationStore.setConversationTitle(conversationId, title);
        } catch (err) {
          deps.logger?.child({ conversationId }).warn("orchestrator: title set failure", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Persist lineage + tool policy AFTER the newness check (separate
      // keys — never pre-create the meta row). Best-effort like `title`: a
      // failure must not break the turn. Only persisted when explicitly
      // provided; omitted = leave whatever agent-management pre-persisted
      // (or nothing for a legacy conversation) untouched.
      if (parentConversationId !== undefined) {
        try {
          await deps.conversationStore.setParentConversationId(
            conversationId,
            parentConversationId,
          );
        } catch (err) {
          deps.logger?.child({ conversationId }).warn("orchestrator: parent set failure", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (toolPolicy !== undefined) {
        try {
          await deps.conversationStore.setToolPolicy(conversationId, toolPolicy);
        } catch (err) {
          deps.logger?.child({ conversationId }).warn("orchestrator: toolPolicy set failure", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return meta === null;
    })();

    // ALWAYS resolve the effective cwd through getEffectiveCwd, passing the
    // per-turn cwd as the overrideCwd when present. A relative per-turn cwd
    // (e.g. "arch-rewrite") must be resolved against the workspace's
    // defaultCwd via the same workspace-relative algorithm the persisted cwd
    // uses — NOT used raw (which would resolve against process.cwd() and
    // break). When cwd is undefined, getEffectiveCwd reads the persisted cwd.
    // Chained after workspaceSetupPromise so the workspace is assigned
    // first for new conversations (the timing invariant this enforces).
    const effectiveCwdPromise = workspaceSetupPromise.then(() =>
      deps.conversationStore.getEffectiveCwd(conversationId, cwd).then((c) => c ?? undefined),
    );

    // Resolve the effective computer the SAME way cwd resolves — pass the
    // per-turn computerId as the overrideAlias. When computerId is
    // undefined, getEffectiveComputer reads the persisted per-conversation
    // computerId → workspace defaultComputerId → null (LOCAL). Chained
    // after workspaceSetupPromise (same timing invariant as cwd). The
    // orchestrator never interprets the alias — it forwards the string
    // verbatim (like cwd forwards a path). Mirrors effectiveCwdPromise.
    const effectiveComputerIdPromise = workspaceSetupPromise.then(() =>
      deps.conversationStore
        .getEffectiveComputer(conversationId, computerId)
        .then((c) => c ?? undefined),
    );

    const storedEffortPromise =
      pendingCompaction === undefined
        ? deps.conversationStore.getReasoningEffort(conversationId)
        : workspaceSetupPromise.then(() =>
            deps.conversationStore.getReasoningEffort(conversationId),
          );
    // Resolve the persisted model (if any) in parallel with the other
    // per-conversation reads. The effective model name is
    // per-turn override → persisted → (undefined → default provider), the
    // same resolution chain as `resolveReasoningEffort`.
    const storedModelPromise =
      pendingCompaction === undefined
        ? deps.conversationStore.getModel(conversationId)
        : workspaceSetupPromise.then(() => deps.conversationStore.getModel(conversationId));

    const payloadPromise = Promise.all([
      effectiveCwdPromise,
      effectiveComputerIdPromise,
      storedEffortPromise,
      storedModelPromise,
    ]).then(([effectiveCwd, effectiveComputerId, _storedEffort, storedModel]) => {
      const effectiveModelName = resolveModelName(modelName, storedModel);
      return {
        conversationId,
        ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
        ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
        ...(effectiveModelName !== undefined ? { modelName: effectiveModelName } : {}),
      };
    });

    // Observe setup failures in lifecycle branches; the turn catch reports them.
    const lifecyclePayloadPromise = payloadPromise.catch((err) => {
      logFailure(conversationId, "lifecycle payload", turnId)(err);
      return undefined;
    });
    void (async () => {
      const payload = await lifecyclePayloadPromise;
      if (payload === undefined) return;
      deps.emit?.(turnStarted, payload);
      // Resolve the persisted workspace id (not the per-turn start option)
      // before emitting so the broadcast carries the correct workspace.
      publishStatus(conversationId, "active", turnId);
      void deps.conversationStore
        .setConversationStatus(conversationId, "active")
        .catch(logFailure(conversationId, "set active status", turnId));
    })().catch(logFailure(conversationId, "turn started hook", turnId));

    void (async () => {
      let endReason: TurnEndedEvent["reason"] = "error";
      // Per-turn metrics accumulator. Hoisted out of the try so a turn that
      // THROWS (e.g. a store failure mid-turn) still persists the metrics it
      // accumulated — every turn that produced steps gets a metrics row, so
      // client-side turn placement / numbering never has a hole.
      const metrics = createMetricsAccumulator();
      let metricsPersisted = false;
      try {
        const [effectiveCwd, effectiveComputerId, storedEffort, isNewConversation, storedModel] =
          await Promise.all([
            effectiveCwdPromise,
            effectiveComputerIdPromise,
            storedEffortPromise,
            workspaceSetupPromise,
            storedModelPromise,
          ]);

        if (cwd !== undefined) {
          await deps.conversationStore.setCwd(conversationId, cwd);
        }

        // Persist the per-turn computer override, mirroring the cwd
        // persistence above. Only stamped when a computerId was actually
        // provided — NOT when it resolved to undefined (LOCAL) via the
        // workspace default. Idempotent when the value is unchanged.
        if (computerId !== undefined) {
          await deps.conversationStore.setComputerId(conversationId, computerId);
        }

        const resolvedEffort = resolveReasoningEffort(reasoningEffortOverride, storedEffort);
        // Effective model name: per-turn override → persisted → undefined
        // (→ default provider). Resolved here so every downstream consumer
        // (resolveModel, system prompt, payload) sees the same model as if
        // the caller had passed it explicitly.
        const effectiveModelName = resolveModelName(modelName, storedModel);

        // The conversation's PERSISTED workspace (§6.3) — the enforcement
        // context for this turn. getWorkspaceId synthesizes "default" for
        // conversations with no persisted workspace, so this is always
        // known once the workspace setup has run.
        const turnWorkspaceId = await deps.conversationStore.getWorkspaceId(conversationId);

        const history = await deps.conversationStore.load(conversationId);

        // Store images to tmp files (compact URLs) BEFORE building the user
        // message so the persisted chunks hold tiny URL references, not
        // megabytes of base64 data URLs. When the vision-handoff service isn't
        // loaded, images pass through unchanged (backward compatible).
        const visionHandoffForStore = deps.resolveVisionHandoff?.();
        const storedImages =
          visionHandoffForStore !== undefined && images !== undefined
            ? await visionHandoffForStore.storeImages(conversationId, images)
            : images;

        const userMsg = buildUserMessage(text, storedImages);
        // Make input durable before model validation or any provider/prompt work.
        await deps.conversationStore.append(conversationId, [userMsg], { turnId });

        const turnLogger = deps.logger?.child({ conversationId, turnId });
        const request = await assembleTurnRequest(deps, {
          conversationId,
          signal: controller.signal,
          messages: [...history, userMsg],
          isNewConversation,
          context: {
            effectiveCwd,
            effectiveComputerId,
            effectiveModelName,
            resolvedEffort,
            turnWorkspaceId,
          },
          ...(systemPromptOverride !== undefined ? { systemPrompt: systemPromptOverride } : {}),
          ...(turnLogger !== undefined ? { logger: turnLogger } : {}),
        });
        let { provider } = request;
        const { providerOpts, providerMessages } = request;
        const limiter = deps.resolveConcurrencyLimiter?.();
        if (limiter !== undefined) {
          provider = wrapProviderWithConcurrency(
            provider,
            limiter,
            conversationId,
            turnWorkspaceId,
            promptStartedAt,
            () => publishStatus(conversationId, "queued", turnId),
            () => publishStatus(conversationId, "active", turnId),
          );
        }

        const dispatch = deps.resolveDispatch?.() ?? defaultDispatchPolicy();
        const emitAndAccumulate = (event: AgentEvent): void => {
          metrics.ingest(event);
          emitToHub(conversationId, event);
        };

        // Resolve the steering queue once for this turn. When present, wire
        // `drainSteering`: the kernel calls it at the tool-result boundary and
        // appends whatever it returns as user-role messages alongside the tool
        // results (mid-turn steering). The wrapper emits a `steering` AgentEvent
        // into the hub (buffered for late-join like `user-message`) so a
        // frontend can place a user bubble in the transcript live; the kernel
        // only appends the returned messages — it does NOT emit the event.
        const queue = deps.resolveQueue?.();
        const drainSteering =
          queue === undefined
            ? undefined
            : async (): Promise<readonly ChatMessage[]> => {
                if (controller.signal.aborted) return [];
                const queued = queue.drain(conversationId);
                if (queued.length === 0) return [];
                const steerText = queued.map((q) => q.text).join("\n\n");
                const combined = queuedInput(queued);
                const steeringMessage: ChatMessage = {
                  role: "user",
                  chunks: queued.some((message) => message.images?.length)
                    ? queued.flatMap(
                        (message) => buildUserMessage(message.text, message.images).chunks,
                      )
                    : buildUserMessage(steerText).chunks,
                };
                // Steering does not switch an in-flight tool context; persist for the next turn.
                if (combined.computerId !== undefined) {
                  await deps.conversationStore.setComputerId(conversationId, combined.computerId);
                }
                // Persist the injected steering message to the store as part
                // of the SAME critical section as the injection, so it is
                // never lost. Without this, the message would live only in
                // the kernel's in-memory messages array (never persisted),
                // so a user could never see it — and in-flight compaction
                // (which loads the store) would scrub it. A fire-and-forget
                // append would race with the next step's `onStepComplete`
                // append and collide on the store's seq counter, so we
                // `await` it (the kernel awaits drainSteering). Errors
                // propagate (a DB failure ends the turn, matching
                // `onStepComplete`'s behavior).
                await deps.conversationStore.append(conversationId, [steeringMessage], { turnId });
                emitToHub(conversationId, {
                  type: "steering",
                  conversationId,
                  turnId,
                  text: steerText,
                  ...(combined.images.length ? { images: combined.images } : {}),
                });
                const vision = deps.resolveVisionHandoff?.();
                return vision === undefined
                  ? [steeringMessage]
                  : vision.prepareForProvider([steeringMessage], effectiveModelName, {
                      conversationId,
                      signal: controller.signal,
                    });
              };

        const opts: RunTurnInput = {
          provider,
          messages: providerMessages,
          tools: request.tools,
          dispatch,
          emit: emitAndAccumulate,
          conversationId,
          turnId,
          signal: controller.signal,
          providerOpts,
          retry: retryStrategy,
          ...(turnLogger !== undefined ? { logger: turnLogger } : {}),
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
          ...(drainSteering !== undefined ? { drainSteering } : {}),
          // In-flight compaction: at every tool-result boundary the kernel
          // calls this with the step's usage + the running messages. When the
          // context size exceeds the compact-percent threshold (percent of the
          // model's context window), the old history is summarized and
          // replaced with [summary, ...recent] — mid-turn, without stopping —
          // so a long-running turn (e.g. left overnight) does not run out of
          // context. This is DISTINCT from the post-seal auto-compact below:
          // that one runs AFTER the turn ends (preparing the next turn) and
          // refuses while the conversation is active; this one runs DURING the
          // turn (saving the running turn) and uses the live step usage (not
          // persisted metrics, which are only written at turn end). When the
          // threshold is not exceeded, compaction is disabled (percent 0), or
          // the model's context window is unknown, it returns void and the
          // kernel keeps its history unchanged (a strict no-op).
          onStepBoundary: async ({ stepUsage, messages }) => {
            // Abort before any compaction reads/summarization work starts, so
            // Stop prevents a new provider call (and the reads that precede it).
            if (controller.signal.aborted) return;
            const stored = await deps.conversationStore.getCompactPercent(conversationId);
            const percent = stored ?? DEFAULT_COMPACT_PERCENT;
            if (percent <= 0) return; // auto-compact disabled
            // contextSize mirrors the persisted definition: this step's
            // inputTokens + outputTokens (the prompt the NEXT step would
            // inherit, grown by this step's output).
            const contextSize = stepUsage.inputTokens + stepUsage.outputTokens;
            if (effectiveModelName === undefined || deps.resolveModelInfo === undefined) return;
            // Abort may have fired during the compact-percent read.
            if (controller.signal.aborted) return;
            const info = await deps.resolveModelInfo(effectiveModelName);
            if (info?.contextWindow === undefined) return;
            const threshold = Math.floor(info.contextWindow * (percent / 100));
            if (contextSize < threshold) return; // threshold not exceeded
            // Abort may have fired during the model-info read.
            if (controller.signal.aborted) return;

            const keepLastN = DEFAULT_KEEP_LAST_N;
            turnLogger?.info("compaction:in-flight", {
              conversationId,
              turnId,
              contextSize,
              threshold,
              percent,
            });
            const outcome = await performCompaction(
              {
                conversationStore: deps.conversationStore,
                resolveProvider: deps.resolveProvider,
                ...(deps.resolveModel !== undefined ? { resolveModel: deps.resolveModel } : {}),
                ...(deps.resolveSystemPrompt !== undefined
                  ? { resolveSystemPrompt: deps.resolveSystemPrompt }
                  : {}),
                ...(deps.resolveConcurrencyLimiter !== undefined
                  ? { resolveConcurrencyLimiter: deps.resolveConcurrencyLimiter }
                  : {}),
                ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
                ...(deps.now !== undefined ? { now: deps.now } : {}),
                // Cancellation signal for the in-flight path — abort while
                // compacting removes the concurrency waiter / stops the
                // summarization stream / skips replace.
                signal: controller.signal,
                // emit is required by performCompaction; fall back to a no-op
                // when the orchestrator was constructed without one (tests).
                emit: deps.emit ?? noopEmit,
              },
              conversationId,
              // Pass the kernel's LIVE messages array (not a store reload):
              // it includes mid-turn steering messages (now persisted by
              // drainSteering) and is the authoritative prompt state. Using it
              // for the split keeps the store write and the kernel's
              // replacement aligned (same recent slice) — no DB↔LLM divergence.
              { keepLastN, modelName: effectiveModelName, messages },
            );
            if ("error" in outcome) {
              turnLogger?.warn("compaction:in-flight:skipped", {
                conversationId,
                turnId,
                error: outcome.error,
              });
              return; // too short / empty summary / unknown model → no replacement
            }
            // Return the compacted history the kernel should adopt. This is
            // EXACTLY what performCompaction wrote to the store
            // ([summary, ...recent-from-live]), so the kernel's working
            // history and the store stay byte-aligned.
            return outcome.compactedMessages;
          },
        };

        // Per-turn memory telemetry: capture a sample immediately BEFORE the
        // stream starts. Paired with the post-stream sample below, this
        // measures the streaming path's memory footprint per turn (the prime
        // leak suspect — AI-SDK streaming buffers + per-turn message arrays).
        // Tagged with conversationId + turnId via the turnLogger's correlation
        // context. Additive observability only — does not alter the stream.
        const sampleMem = deps.sampleMemory;
        const memBefore = sampleMem?.();
        if (memBefore !== undefined) {
          turnLogger?.debug("memory:turn:before", memorySampleAttributes(memBefore));
        }

        let stepsPersisted = false;
        const result = await deps.runTurn({
          ...opts,
          // Incremental persistence: persist each step's messages
          // as they are finalized. Seq numbers are assigned during
          // generation, so the FE can GET /conversations/:id?sinceSeq=N
          // mid-turn and pick up committed chunks (CR-6).
          onStepComplete: async (stepMessages) => {
            await deps.conversationStore.append(conversationId, stepMessages, { turnId });
            stepsPersisted = true;
          },
        });

        endReason =
          result.finishReason === "error"
            ? "error"
            : result.finishReason === "aborted"
              ? "aborted"
              : "sealed";

        // Per-turn memory telemetry: capture a sample immediately AFTER the
        // stream completes and log the per-turn delta vs `memBefore`. A
        // positive rss delta on a sealed turn flags memory retained by the
        // streaming path (the leak we are localizing). No I/O beyond the
        // injected sampler; pure delta computation via memoryDelta(). The
        // delta attributes carry a `delta` prefix so the absolute "after"
        // values and the per-turn delta coexist without key collision.
        if (memBefore !== undefined) {
          const memAfter = sampleMem?.();
          if (memAfter !== undefined) {
            turnLogger?.info("memory:turn:after", {
              ...memorySampleAttributes(memAfter),
              ...memorySampleAttributes(memoryDelta(memBefore, memAfter), "delta"),
            });
          }
        }

        // Fallback: if onStepComplete was never called (e.g., a fake
        // runTurn in tests), persist all result messages as a batch.
        if (!stepsPersisted && result.messages.length > 0) {
          await deps.conversationStore.append(conversationId, result.messages, { turnId });
        }

        const turnMetrics = metrics.build(turnId);
        metricsPersisted = true;
        await deps.conversationStore.appendMetrics(conversationId, turnMetrics);

        emitToHub(conversationId, { type: "turn-sealed", conversationId, turnId });
      } catch (err) {
        endReason = err instanceof TurnRequestRejected ? "rejected" : "error";
        // Persist whatever metrics the failed turn accumulated (steps that
        // ran before the failure), so its row exists like any other turn's.
        // Best-effort: a store that is failing may fail again — never mask
        // the original error.
        if (!metricsPersisted && metrics.hasSteps()) {
          metricsPersisted = true;
          try {
            await deps.conversationStore.appendMetrics(conversationId, metrics.build(turnId));
          } catch {
            // Swallow — the turn's own error is what gets reported.
          }
        }
        // Deliberate Stop is not an error; finally reports the terminal abort.
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          emitToHub(conversationId, {
            type: "error",
            conversationId,
            turnId,
            message,
          });
        }
      } finally {
        activeTurns.delete(conversationId);
        emitToHub(conversationId, {
          type: "turn-ended",
          conversationId,
          turnId,
          reason: controller.signal.aborted ? "aborted" : endReason,
        });
        // Abort-specific observability: log the deliberate cancellation with its
        // latency from turn start to the abort, tagged by conversation + turn.
        if (controller.signal.aborted) {
          const abortLatencyMs =
            deps.now?.() !== undefined ? (deps.now() ?? 0) - promptStartedAt : undefined;
          deps.logger?.child({ conversationId, turnId }).info("turn:aborted", {
            conversationId,
            turnId,
            ...(abortLatencyMs !== undefined ? { abortLatencyMs } : {}),
          });
        }
        // Post-turn carry: if the turn ended with a non-empty steering queue
        // (no tool call fired → drainSteering never drained it), start a NEW
        // detached turn whose opening user-message carries the combined text.
        // The new turn re-adds to activeTurns + activeConversations, so skip
        // the activeConversations.delete when carried. May chain (user keeps
        // steering) — each carried turn's own finally re-checks the queue.
        // Stop/Close cancels pending intent; only non-aborted outcomes carry.
        const carried =
          !controller.signal.aborted && endReason !== "aborted" && tryCarryQueue(conversationId);
        if (!carried) {
          activeConversations.delete(conversationId);
        }
        void (async () => {
          const payload = await lifecyclePayloadPromise;
          if (payload === undefined) return;
          deps.emit?.(turnSettled, payload);
          if (!carried) {
            // Resolve the persisted workspace id before emitting so the
            // broadcast carries the correct workspace.
            publishStatus(conversationId, "idle", turnId);
            void deps.conversationStore
              .setConversationStatus(conversationId, "idle")
              .catch(logFailure(conversationId, "set idle status", turnId));
            // Fire-and-forget auto-compaction: check threshold and
            // compact if exceeded. Non-blocking — the next turn
            // starts fresh either way.
            const compaction = deps.resolveCompaction?.();
            if (compaction !== undefined) {
              void compaction
                .compact(conversationId, {
                  auto: true,
                  ...(payload.modelName !== undefined ? { modelName: payload.modelName } : {}),
                })
                .catch(logFailure(conversationId, "auto-compaction", turnId));
            }
          }
        })().catch(logFailure(conversationId, "turn settled hook", turnId));
      }
    })().catch(logFailure(conversationId, "detached turn", turnId));
  }

  const orchestrator: SessionOrchestrator = {
    startTurn(input) {
      const { conversationId } = input;
      if (activeTurns.has(conversationId)) {
        return { started: false, reason: "already-active" };
      }
      if (compacting.has(conversationId) && deps.resolveQueue?.() !== undefined) {
        void orchestrator.enqueue(input).catch(logFailure(conversationId, "compaction enqueue"));
        return { started: false, reason: "already-active" };
      }
      runTurnDetached(input);
      const turn = activeTurns.get(conversationId);
      const turnId = turn !== undefined ? turn.turnId : "";
      return { started: true, turnId };
    },

    enqueue(input) {
      const { conversationId } = input;
      let pending = pendingEnqueues.get(conversationId);
      if (pending === undefined || pending.cancelled) {
        pending = { cancelled: false };
        pendingEnqueues.set(conversationId, pending);
      }
      const state = pending;
      const deliver = async (): Promise<EnqueueResult> => {
        const dropped: EnqueueResult = { startedTurn: false, queue: [] };
        if (state.cancelled || activeTurns.get(conversationId)?.controller.signal.aborted)
          return dropped;
        const vision = deps.resolveVisionHandoff?.();
        const images =
          input.images?.length && vision !== undefined
            ? await vision.storeImages(conversationId, input.images)
            : input.images;
        // Storage can outlive Stop/Close or the original turn. Recheck before delivery.
        if (state.cancelled || activeTurns.get(conversationId)?.controller.signal.aborted)
          return dropped;
        const stored = { ...input, ...(images !== undefined ? { images } : {}) };
        const queue = deps.resolveQueue?.();
        const barrier = compacting.get(conversationId);
        if (barrier === undefined || queue === undefined) {
          if (orchestrator.startTurn(stored).started) return { startedTurn: true, queue: [] };
        }
        if (queue === undefined) return dropped;
        const snapshot = queue.enqueue(conversationId, input.text, stored);
        if (barrier !== undefined && !compactionQueueWaiters.has(conversationId)) {
          compactionQueueWaiters.add(conversationId);
          void barrier
            .then(() => {
              compactionQueueWaiters.delete(conversationId);
              if (activeTurns.has(conversationId) || !queue.getQueue(conversationId).length) return;
              const { images: _images, computerId: _computerId, ...options } = stored;
              orchestrator.startTurn({ ...options, ...queuedInput(queue.drain(conversationId)) });
            })
            .catch((error) => {
              compactionQueueWaiters.delete(conversationId);
              logFailure(conversationId, "compaction queue carry")(error);
            });
        }
        return { startedTurn: false, queue: snapshot };
      };
      const previous = state.tail;
      let complete!: (value: EnqueueResult | PromiseLike<EnqueueResult>) => void;
      let fail!: (error: unknown) => void;
      const result = new Promise<EnqueueResult>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      state.tail = result;
      void (previous === undefined ? deliver() : previous.then(deliver, deliver)).then(
        complete,
        fail,
      );
      const cleanup = () => {
        if (pendingEnqueues.get(conversationId) === state && state.tail === result) {
          pendingEnqueues.delete(conversationId);
        }
      };
      void result.then(cleanup, cleanup);
      return result;
    },

    cancelQueuedMessage({ conversationId, messageId }) {
      // When the message-queue extension isn't loaded this degrades: nothing to
      // cancel, empty snapshot (feature off). Mirrors `enqueue`'s degraded path.
      const queue = deps.resolveQueue?.();
      if (queue === undefined) {
        return { cancelled: false, queue: [] };
      }
      const beforeLen = queue.getQueue(conversationId).length;
      const snapshot = queue.cancel(conversationId, messageId);
      const cancelled = snapshot.length < beforeLen;
      return { cancelled, queue: snapshot };
    },

    subscribe(conversationId, listener) {
      let listeners = subscribers.get(conversationId);
      if (listeners === undefined) {
        listeners = new Set();
        subscribers.set(conversationId, listeners);
      }
      const turn = activeTurns.get(conversationId);
      if (turn !== undefined) {
        // Already compacted on arrival. The immutable snapshot stays stable
        // even if a listener synchronously causes another event to be emitted.
        const snapshot = turn.buffer;
        listeners.add(listener);
        for (const event of snapshot) {
          listener(event);
        }
      } else {
        listeners.add(listener);
      }
      return () => {
        const set = subscribers.get(conversationId);
        if (set !== undefined) {
          set.delete(listener);
          if (set.size === 0) {
            subscribers.delete(conversationId);
          }
        }
      };
    },

    isActive(conversationId) {
      return activeTurns.has(conversationId);
    },

    getActiveConversationCount() {
      return activeConversations.size;
    },

    closeConversation(conversationId) {
      const { abortedTurn } = orchestrator.stopTurn(conversationId);
      deps.emit?.(conversationClosed, { conversationId });
      // Resolve the persisted workspace id before emitting so the
      // broadcast carries the correct workspace. The hook is
      // fire-and-forget; closeConversation stays synchronous (returns
      // immediately) while the status-changed emit resolves async.
      publishStatus(conversationId, "closed");
      void deps.conversationStore
        .setConversationStatus(conversationId, "closed")
        .catch(logFailure(conversationId, "set closed status"));
      return { abortedTurn };
    },

    stopTurn(conversationId) {
      const pending = pendingEnqueues.get(conversationId);
      if (pending !== undefined) pending.cancelled = true;
      const turn = activeTurns.get(conversationId);
      const abortedTurn = turn !== undefined;
      if (turn !== undefined) {
        // Record cancellation synchronously before clearing/notifying the queue.
        turn.controller.abort();
      }
      deps.resolveQueue?.()?.drain(conversationId);
      return { abortedTurn };
    },

    stopAll() {
      let stopped = 0;
      for (const conversationId of new Set([...activeConversations, ...pendingEnqueues.keys()])) {
        if (orchestrator.stopTurn(conversationId).abortedTurn) stopped++;
      }
      return { stopped };
    },

    async handleMessage({
      conversationId,
      text,
      onEvent,
      modelName,
      cwd,
      computerId,
      reasoningEffort,
      workspaceId,
      systemPrompt,
      images,
      title,
      parentConversationId,
      toolPolicy,
    }) {
      const turnInput: StartTurnInput = {
        conversationId,
        text,
        ...(modelName !== undefined ? { modelName } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(computerId !== undefined ? { computerId } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(parentConversationId !== undefined ? { parentConversationId } : {}),
        ...(toolPolicy !== undefined ? { toolPolicy } : {}),
      };
      // Compaction deferral may await image storage. Wait for insertion before
      // checking the carry waiter, otherwise an image-only request looks rejected.
      const result =
        compacting.has(conversationId) &&
        !activeTurns.has(conversationId) &&
        deps.resolveQueue?.() !== undefined
          ? { started: (await orchestrator.enqueue(turnInput)).startedTurn }
          : orchestrator.startTurn(turnInput);
      if (!result.started && !compactionQueueWaiters.has(conversationId)) {
        const errorTurnId = generateTurnId();
        onEvent({
          type: "error",
          conversationId,
          turnId: errorTurnId,
          message: "turn already active for this conversation",
        });
        return;
      }

      await new Promise<void>((resolve) => {
        let ended = false;
        let unsubscribe: (() => void) | undefined;
        unsubscribe = orchestrator.subscribe(conversationId, (event) => {
          onEvent(event);
          if (event.type === "turn-ended") {
            ended = true;
            unsubscribe?.();
            resolve();
          }
        });
        if (ended) unsubscribe();
      });
    },
  };

  return { orchestrator, activeConversations, compacting };
}

/**
 * No-op emit used as a fallback when the orchestrator is constructed without an
 * `emit` (some tests). `performCompaction` requires a non-optional `emit` (it
 * emits `conversationCompacted`); the in-flight path degrades to emitting
 * nothing rather than skipping compaction entirely. Generic-typed so it
 * satisfies `PerformCompactionDeps["emit"]` for any hook payload type.
 */
const noopEmit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void =
  () => {};
