import type { ConversationStore } from "@dispatch/conversation-store";
import type {
  AgentEvent,
  ChatMessage,
  CompactionResult,
  ConversationStatus,
  EventHookDescriptor,
  ImageInput,
  Logger,
  ModelInfo,
  ProviderContract,
  ProviderEvent,
  ProviderStreamOptions,
  ReasoningEffort,
  RetryStrategy,
  RunTurnInput,
  RunTurnResult,
  ToolContract,
  ToolDispatchPolicy,
  UsageEvent,
} from "@dispatch/kernel";
import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import type { MessageQueueService, QueuedMessage } from "@dispatch/message-queue";
import type { ConcurrencyLimiter } from "@dispatch/provider-concurrency";
import { wrapProviderWithConcurrency } from "@dispatch/provider-concurrency";
import type { SystemPromptService } from "@dispatch/system-prompt";
import { createMetricsAccumulator } from "./metrics.js";
import {
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
   * `StartTurnInput.images`). Threaded to `startTurn` when the conversation is
   * idle (the message starts a turn). Additive optional.
   */
  readonly images?: readonly ImageInput[];
  /** Workspace to stamp on a new conversation. Defaults to `"default"`. */
  readonly workspaceId?: string;
  /**
   * Per-turn computer override (SSH alias), threaded to `startTurn` when the
   * conversation is idle (the message starts a turn). Additive optional —
   * mirrors `workspaceId` on this type (enqueue does not carry `cwd`).
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
  buffer: AgentEvent[];
  turnId: string;
  /** Aborts this turn's kernel runTurn (closeConversation). */
  controller: AbortController;
}

// --- Lifecycle event hooks ---

/** Context carried on turn-lifecycle events, enough to replicate the turn's request prefix. */
export interface TurnLifecyclePayload {
  readonly conversationId: string;
  readonly cwd?: string;
  /** The computer this turn executes on (SSH alias), mirroring `cwd`. */
  readonly computerId?: string;
  readonly modelName?: string;
}

/** Fired when a turn STARTS driving a conversation (consumers cancel warming timers). */
export const turnStarted: EventHookDescriptor<TurnLifecyclePayload> =
  defineEventHook<TurnLifecyclePayload>("session-orchestrator/turn-started");

/** Fired when a turn SETTLES (sealed) for a conversation (consumers arm warming timers). */
export const turnSettled: EventHookDescriptor<TurnLifecyclePayload> =
  defineEventHook<TurnLifecyclePayload>("session-orchestrator/turn-settled");

/** Payload for the conversationClosed bus event. */
export interface ConversationClosedPayload {
  readonly conversationId: string;
}

/**
 * Fired when a client EXPLICITLY closes a conversation (tab close — NOT a mere
 * disconnect). Consumers stop per-conversation background work (e.g. cache-warming
 * disables its schedule). Emitted by `SessionOrchestrator.closeConversation`.
 */
export const conversationClosed: EventHookDescriptor<ConversationClosedPayload> =
  defineEventHook<ConversationClosedPayload>("session-orchestrator/conversation-closed");

/** Payload for the conversationOpened bus event. */
export interface ConversationOpenedPayload {
  readonly conversationId: string;
  /**
   * The conversation's actual persisted workspace id (resolved from the
   * store, not the per-turn start option), so a frontend can open/focus the
   * tab in the correct workspace. Falls back to `"default"`.
   */
  readonly workspaceId: string;
}

/**
 * Fired when a client requests to "open" a conversation (e.g. the CLI `--open`
 * flag). Transport-ws subscribes and broadcasts a `conversation.open` WS
 * message to all connected frontend clients. The frontend decides whether to
 * open/focus a tab — the backend just signals.
 */
export const conversationOpened: EventHookDescriptor<ConversationOpenedPayload> =
  defineEventHook<ConversationOpenedPayload>("session-orchestrator/conversation-opened");

/** Payload for the conversationStatusChanged bus event. */
export interface ConversationStatusChangedPayload {
  readonly conversationId: string;
  readonly status: ConversationStatus;
  /**
   * The conversation's actual persisted workspace id (resolved from the
   * store, not the per-turn start option), so a frontend can sync the tab
   * in the correct workspace. Falls back to `"default"`.
   */
  readonly workspaceId: string;
}

/**
 * Fired when a conversation's lifecycle status changes (active/idle/closed).
 * Transport-ws subscribes and broadcasts a `conversation.statusChanged` WS
 * message to all connected frontend clients so tabs sync across devices.
 */
export const conversationStatusChanged: EventHookDescriptor<ConversationStatusChangedPayload> =
  defineEventHook<ConversationStatusChangedPayload>(
    "session-orchestrator/conversation-status-changed",
  );

/** Payload for the conversationCompacted bus event. */
export interface ConversationCompactedPayload {
  readonly conversationId: string;
  readonly newConversationId: string;
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

/**
 * Fired when a conversation's history has been compacted (old messages
 * summarized, recent messages retained). Transport-ws subscribes and
 * broadcasts a `conversation.compacted` WS message so the FE reloads history.
 */
export const conversationCompacted: EventHookDescriptor<ConversationCompactedPayload> =
  defineEventHook<ConversationCompactedPayload>("session-orchestrator/conversation-compacted");

/** Payload for the warmCompleted bus event. */
export interface WarmCompletedPayload {
  readonly conversationId: string;
  readonly usage: WarmResult;
}

/** Fired when a warm probe succeeds (both automatic and manual paths). */
export const warmCompleted: EventHookDescriptor<WarmCompletedPayload> =
  defineEventHook<WarmCompletedPayload>("session-orchestrator/warm-completed");

// --- Warm service ---

export interface WarmResult {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface WarmService {
  readonly warm: (
    conversationId: string,
    opts?: { readonly cwd?: string; readonly modelName?: string },
  ) => Promise<WarmResult | { readonly error: string }>;
}

export const cacheWarmHandle: ServiceHandle<WarmService> = defineService<WarmService>(
  "session-orchestrator/warm",
);

// --- Compaction service ---

export interface CompactionService {
  /**
   * Compact a conversation: summarize old messages and replace history with
   * the summary + the most recent `keepLastN` messages. Returns the result
   * or an error object. No-ops if the conversation is too short (≤ keepLastN
   * messages). When `auto` is true, checks the compact-threshold setting and
   * only compacts if the last turn's input tokens exceeded it.
   */
  readonly compact: (
    conversationId: string,
    opts?: { readonly keepLastN?: number; readonly modelName?: string; readonly auto?: boolean },
  ) => Promise<CompactionResult | { readonly error: string }>;
}

export const compactionHandle: ServiceHandle<CompactionService> = defineService<CompactionService>(
  "session-orchestrator/compaction",
);

export interface SessionOrchestrator {
  startTurn(input: StartTurnInput): StartTurnResult;
  /**
   * The single entry transports call to deliver a user message. Owns the
   * idle→startTurn vs active→queue decision (no separate `isActive` race —
   * `startTurn`'s single-flight guard is authoritative). When the conversation
   * is idle, starts a turn (the message is the opening prompt). When active,
   * enqueues onto the steering queue (if the message-queue extension is
   * loaded); with no queue extension loaded the message is dropped and the
   * returned snapshot is empty (degraded — feature off).
   */
  enqueue(input: EnqueueInput): EnqueueResult;
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
   * path). Idempotent — stopping an idle/unknown conversation is a no-op.
   */
  stopTurn(conversationId: string): { readonly abortedTurn: boolean };
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

/** Deps for the warm service — emit is REQUIRED so warmCompleted is never silently dropped. */
export type WarmServiceDeps = SessionOrchestratorDeps & {
  readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
};

export interface SessionOrchestratorBundle {
  readonly orchestrator: SessionOrchestrator;
  /** The shared active-conversations set, for use by createWarmService. */
  readonly activeConversations: ReadonlySet<string>;
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
  const subscribers = new Map<string, Set<TurnEventListener>>();
  const activeTurns = new Map<string, ActiveTurn>();
  // One stateless retry strategy shared by every turn (delayFor is pure; sleep
  // is a stateless setTimeout closure). Wired into each RunTurnInput.retry.
  const retryStrategy = createRetryStrategy();

  function emitToHub(conversationId: string, event: AgentEvent): void {
    const turn = activeTurns.get(conversationId);
    if (turn !== undefined) {
      turn.buffer.push(event);
    }
    const listeners = subscribers.get(conversationId);
    if (listeners !== undefined) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  /**
   * Post-seal carry: if a steering queue is available and non-empty, drain it,
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
    const combined = drained.map((q) => q.text).join("\n\n");
    const result = orchestrator.startTurn({ conversationId, text: combined });
    return result.started;
  }

  function runTurnDetached(
    conversationId: string,
    text: string,
    modelName: string | undefined,
    cwd: string | undefined,
    computerId: string | undefined,
    reasoningEffortOverride: ReasoningEffort | undefined,
    workspaceId: string,
    systemPromptOverride: string | undefined,
    images: readonly ImageInput[] | undefined,
  ): void {
    const turnId = generateTurnId();
    const promptStartedAt = deps.now?.() ?? Date.now();
    const controller = new AbortController();
    activeTurns.set(conversationId, { buffer: [], turnId, controller });
    activeConversations.add(conversationId);

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
    const workspaceSetupPromise = (async (): Promise<boolean> => {
      const meta = await deps.conversationStore.getConversationMeta(conversationId);
      if (meta === null) {
        await deps.conversationStore.ensureWorkspace(workspaceId);
        await deps.conversationStore.setWorkspaceId(conversationId, workspaceId);
        return true;
      }
      return false;
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

    const storedEffortPromise = deps.conversationStore.getReasoningEffort(conversationId);
    // Resolve the persisted model (if any) in parallel with the other
    // per-conversation reads. The effective model name is
    // per-turn override → persisted → (undefined → default provider), the
    // same resolution chain as `resolveReasoningEffort`.
    const storedModelPromise = deps.conversationStore.getModel(conversationId);

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

    payloadPromise.then((payload) => {
      deps.emit?.(turnStarted, payload);
      // Resolve the persisted workspace id (not the per-turn start option)
      // before emitting so the broadcast carries the correct workspace.
      void deps.conversationStore.getWorkspaceId(conversationId).then((workspaceId) => {
        deps.emit?.(conversationStatusChanged, {
          conversationId,
          status: "active",
          workspaceId,
        });
      });
      void deps.conversationStore.setConversationStatus(conversationId, "active");
    });

    void (async () => {
      let sealed = false;
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

        // Workspace assignment for new conversations happens BEFORE
        // effective-cwd resolution (see workspaceSetupPromise above) so
        // getEffectiveCwd resolves against the intended workspace, not
        // the stale "default". The history-load + append flow below is
        // otherwise unchanged.

        let provider: ProviderContract;
        let modelOverride: string | undefined;

        if (effectiveModelName !== undefined && deps.resolveModel !== undefined) {
          const resolved = deps.resolveModel(effectiveModelName);
          if (resolved === undefined) {
            emitToHub(conversationId, {
              type: "error",
              conversationId,
              turnId,
              message: `unknown model: ${effectiveModelName}`,
            });
            return;
          }
          provider = resolved.provider;
          modelOverride = resolved.model;
          // Persist the resolved model so it sticks for future turns
          // and browser sessions (per-conversation model persistence).
          // Only stamped when a model was actually used — NOT on the
          // default-provider fallthrough (nothing to persist). Idempotent
          // when the value is unchanged (re-stamps the same persisted
          // model). The early `return` above means an unknown model is
          // never persisted.
          await deps.conversationStore.setModel(conversationId, effectiveModelName);
        } else {
          provider = deps.resolveProvider();
        }

        // Wrap the resolved provider with concurrency limiting when the
        // provider-concurrency extension is loaded. The slot is acquired
        // before the stream starts (before the HTTP request) and released
        // when the stream completes (after all tokens are generated). The
        // promptStartedAt (turn start time) is used for oldest-agent-first
        // scheduling when multiple agents are queued.
        //
        // Status lifecycle with concurrency: "active" is emitted early (in
        // payloadPromise.then, before this code runs). If acquire() blocks,
        // onQueued emits "queued" (broadcast-only — persisted status stays
        // "active"). When the slot is granted, onAcquired emits "active"
        // again, transitioning "queued" → "active" so the FE switches from
        // the loading ring back to dots. A request that gets a slot
        // immediately never emits "queued" — onAcquired fires right after
        // the early "active", which is a harmless no-op re-broadcast.
        const limiter = deps.resolveConcurrencyLimiter?.();
        if (limiter !== undefined) {
          const emitStatus = (status: "queued" | "active"): void => {
            void deps.conversationStore.getWorkspaceId(conversationId).then((workspaceId) => {
              deps.emit?.(conversationStatusChanged, {
                conversationId,
                status,
                workspaceId,
              });
            });
          };
          provider = wrapProviderWithConcurrency(
            provider,
            limiter,
            conversationId,
            workspaceId,
            promptStartedAt,
            () => emitStatus("queued"),
            () => emitStatus("active"),
          );
        }

        const baseTools = deps.resolveTools();
        const assembled = await deps.applyToolsFilter({
          tools: baseTools,
          conversationId,
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
        });
        const dispatch = deps.resolveDispatch?.() ?? defaultDispatchPolicy();
        const turnLogger = deps.logger?.child({ conversationId, turnId });
        const metrics = createMetricsAccumulator();

        const emitAndAccumulate = (event: AgentEvent): void => {
          metrics.ingest(event);
          emitToHub(conversationId, event);
        };

        // Resolve the system prompt for this turn (cache-safe). On the
        // FIRST turn of a new conversation, construct it once (resolves all
        // template variables + persists the result). On subsequent turns,
        // reuse the persisted prompt via `getWithMeta` — but ONLY when the
        // stored cwd matches the current effective cwd. If the cwd changed
        // since the prompt was constructed (or no prompt was ever stored),
        // reconstruct against the new cwd so the prompt is never stale.
        // This preserves the cache-safe design (construct once per cwd,
        // reuse on subsequent turns with the same cwd) while fixing the bug
        // where a cwd change left the prompt stale. When the system-prompt
        // service isn't loaded, no system prompt is sent (current behavior
        // preserved).
        //
        // EXPLICIT OVERRIDE: when `systemPromptOverride` is provided (a
        // string, incl. empty), it is sent to the provider AS-IS and the
        // system-prompt service is bypassed entirely (no construct/reuse).
        // This lets a caller that owns its own prompt (e.g. the heartbeat
        // extension) drive a turn without the templated workspace prompt.
        let systemPrompt: string | undefined;
        if (systemPromptOverride !== undefined) {
          systemPrompt = systemPromptOverride;
        } else {
          const systemPromptService = deps.resolveSystemPrompt?.();
          if (systemPromptService !== undefined) {
            if (isNewConversation) {
              systemPrompt = await systemPromptService.construct(
                conversationId,
                effectiveCwd ?? process.cwd(),
                {
                  ...(effectiveModelName !== undefined ? { model: effectiveModelName } : {}),
                  ...(workspaceId !== undefined ? { workspaceId } : {}),
                  ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
                },
              );
            } else {
              const meta = await systemPromptService.getWithMeta(conversationId);
              const currentCwd = effectiveCwd ?? process.cwd();
              const currentComputerId = effectiveComputerId ?? null;
              // Invalidate when cwd OR computerId changed (switching computers
              // must rebuild the prompt against the remote OS/hostname).
              if (
                meta.prompt !== null &&
                meta.cwd === currentCwd &&
                meta.computerId === currentComputerId
              ) {
                systemPrompt = meta.prompt;
              } else {
                systemPrompt = await systemPromptService.construct(conversationId, currentCwd, {
                  ...(effectiveModelName !== undefined ? { model: effectiveModelName } : {}),
                  ...(workspaceId !== undefined ? { workspaceId } : {}),
                  ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
                });
              }
            }
          }
        }

        const providerOpts: ProviderStreamOptions = {
          reasoningEffort: resolvedEffort,
          ...(modelOverride !== undefined ? { model: modelOverride } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
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
            : (): readonly ChatMessage[] => {
                const queued = queue.drain(conversationId);
                if (queued.length === 0) return [];
                const steerText = queued.map((q) => q.text).join("\n\n");
                emitToHub(conversationId, {
                  type: "steering",
                  conversationId,
                  turnId,
                  text: steerText,
                });
                return [{ role: "user", chunks: [{ type: "text", text: steerText }] }];
              };

        // Vision handoff: transform the message list for the provider. When the
        // active model is vision-capable, images pass through natively (no-op).
        // When it is NOT vision-capable, image chunks are transcribed to text
        // descriptions via a vision-capable model — so a text-only model can
        // still reason about images. The PERSISTED user message keeps the
        // original image chunks (appended below); only the provider's view is
        // transcribed. When the vision-handoff service isn't loaded, images pass
        // through unchanged (correct for vision models; text-only models would
        // then receive image content their API may reject — degrades off cleanly
        // for text-only turns with no images).
        const visionHandoff = deps.resolveVisionHandoff?.();
        let providerMessages: readonly ChatMessage[] = [...history, userMsg];
        if (visionHandoff !== undefined) {
          const visionSettings = await deps.conversationStore.getVisionSettings();
          providerMessages = await visionHandoff.prepareForProvider(
            providerMessages,
            effectiveModelName,
            {
              conversationId,
              imageLimit: visionSettings.imageLimit,
              signal: controller.signal,
              ...(turnLogger !== undefined ? { logger: turnLogger } : {}),
            },
          );
        }

        const opts: RunTurnInput = {
          provider,
          messages: providerMessages,
          tools: assembled.tools,
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
            const stored = await deps.conversationStore.getCompactPercent(conversationId);
            const percent = stored ?? DEFAULT_COMPACT_PERCENT;
            if (percent <= 0) return; // auto-compact disabled
            // contextSize mirrors the persisted definition: this step's
            // inputTokens + outputTokens (the prompt the NEXT step would
            // inherit, grown by this step's output).
            const contextSize = stepUsage.inputTokens + stepUsage.outputTokens;
            if (effectiveModelName === undefined || deps.resolveModelInfo === undefined) return;
            const info = await deps.resolveModelInfo(effectiveModelName);
            if (info?.contextWindow === undefined) return;
            const threshold = Math.floor(info.contextWindow * (percent / 100));
            if (contextSize < threshold) return; // threshold not exceeded

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
                // emit is required by performCompaction; fall back to a no-op
                // when the orchestrator was constructed without one (tests).
                emit: deps.emit ?? noopEmit,
              },
              conversationId,
              { keepLastN, modelName: effectiveModelName },
            );
            if ("error" in outcome) {
              turnLogger?.warn("compaction:in-flight:skipped", {
                conversationId,
                turnId,
                error: outcome.error,
              });
              return; // too short / empty summary / unknown model → no replacement
            }
            // Replace the kernel's running history with the summary + the
            // kernel's OWN most-recent N messages. Using the kernel's messages
            // (not the store's) preserves mid-turn steering messages and the
            // vision-transformed provider view the kernel already holds — no
            // re-transcription needed. The STORE was updated by performCompaction
            // with the canonical (un-transformed) recent messages.
            const recent = messages.slice(messages.length - keepLastN);
            return [outcome.summaryMessage, ...recent];
          },
        };

        // Persist the user message at turn start so it has a seq
        // number before the first step generates. This enables the
        // FE to syncTail during generation (CR-6).
        await deps.conversationStore.append(conversationId, [userMsg]);

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
            await deps.conversationStore.append(conversationId, stepMessages);
            stepsPersisted = true;
          },
        });

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
          await deps.conversationStore.append(conversationId, result.messages);
        }

        const turnMetrics = metrics.build(turnId);
        await deps.conversationStore.appendMetrics(conversationId, turnMetrics);

        emitToHub(conversationId, { type: "turn-sealed", conversationId, turnId });
        sealed = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitToHub(conversationId, {
          type: "error",
          conversationId,
          turnId,
          message,
        });
      } finally {
        activeTurns.delete(conversationId);
        // Post-seal carry: if the turn sealed with a non-empty steering queue
        // (no tool call fired → drainSteering never drained it), start a NEW
        // detached turn whose opening user-message carries the combined text.
        // The new turn re-adds to activeTurns + activeConversations, so skip
        // the activeConversations.delete when carried. May chain (user keeps
        // steering) — each carried turn's own finally re-checks the queue.
        const carried = sealed && tryCarryQueue(conversationId);
        if (!carried) {
          activeConversations.delete(conversationId);
        }
        void payloadPromise.then((payload) => {
          deps.emit?.(turnSettled, payload);
          if (!carried) {
            // Resolve the persisted workspace id before emitting so the
            // broadcast carries the correct workspace.
            void deps.conversationStore.getWorkspaceId(conversationId).then((workspaceId) => {
              deps.emit?.(conversationStatusChanged, {
                conversationId,
                status: "idle",
                workspaceId,
              });
            });
            void deps.conversationStore.setConversationStatus(conversationId, "idle");
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
                .catch(() => {});
            }
          }
        });
      }
    })();
  }

  const orchestrator: SessionOrchestrator = {
    startTurn({
      conversationId,
      text,
      modelName,
      cwd,
      computerId,
      reasoningEffort,
      workspaceId,
      systemPrompt,
      images,
    }) {
      if (activeTurns.has(conversationId)) {
        return { started: false, reason: "already-active" };
      }
      runTurnDetached(
        conversationId,
        text,
        modelName,
        cwd,
        computerId,
        reasoningEffort,
        workspaceId ?? "default",
        systemPrompt,
        images,
      );
      const turn = activeTurns.get(conversationId);
      const turnId = turn !== undefined ? turn.turnId : "";
      return { started: true, turnId };
    },

    enqueue({ conversationId, text, workspaceId, computerId, images }) {
      const result = orchestrator.startTurn({
        conversationId,
        text,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(computerId !== undefined ? { computerId } : {}),
        ...(images !== undefined ? { images } : {}),
      });
      if (result.started) {
        return { startedTurn: true, queue: [] };
      }
      // Already active → enqueue onto the steering queue. When the
      // message-queue extension isn't loaded this degrades: the message is
      // dropped and the snapshot is empty (feature off).
      const queue = deps.resolveQueue?.();
      const snapshot = queue !== undefined ? queue.enqueue(conversationId, text) : [];
      return { startedTurn: false, queue: snapshot };
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
        const snapshot = [...turn.buffer];
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
      const turn = activeTurns.get(conversationId);
      const abortedTurn = turn !== undefined;
      if (turn !== undefined) {
        turn.controller.abort();
      }
      deps.emit?.(conversationClosed, { conversationId });
      // Resolve the persisted workspace id before emitting so the
      // broadcast carries the correct workspace. The hook is
      // fire-and-forget; closeConversation stays synchronous (returns
      // immediately) while the status-changed emit resolves async.
      void deps.conversationStore.getWorkspaceId(conversationId).then((workspaceId) => {
        deps.emit?.(conversationStatusChanged, {
          conversationId,
          status: "closed",
          workspaceId,
        });
      });
      void deps.conversationStore.setConversationStatus(conversationId, "closed");
      // Purge tmp images for this conversation (best-effort, fire-and-forget).
      const vh = deps.resolveVisionHandoff?.();
      if (vh !== undefined) void vh.purgeConversationImages(conversationId);
      return { abortedTurn };
    },

    stopTurn(conversationId) {
      const turn = activeTurns.get(conversationId);
      const abortedTurn = turn !== undefined;
      if (turn !== undefined) {
        turn.controller.abort();
      }
      return { abortedTurn };
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
      };
      const result = orchestrator.startTurn(turnInput);
      if (!result.started) {
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
        const unsubscribe = orchestrator.subscribe(conversationId, (event) => {
          onEvent(event);
          if (event.type === "turn-sealed" || event.type === "error") {
            unsubscribe();
            resolve();
          }
        });
      });
    },
  };

  return { orchestrator, activeConversations };
}

export function createWarmService(
  deps: WarmServiceDeps,
  activeConversations: ReadonlySet<string>,
): WarmService {
  return {
    async warm(conversationId, opts) {
      if (activeConversations.has(conversationId)) {
        return { error: "conversation is generating" };
      }

      const history = await deps.conversationStore.load(conversationId);
      if (history.length === 0) {
        return { error: "no history" };
      }

      let provider: ProviderContract;
      let modelOverride: string | undefined;

      // Resolve the model the SAME way the real turn does: per-turn override
      // → persisted per-conversation model → default provider. A mismatch here
      // silently busts the prompt cache (the model block of the prompt prefix
      // diverges from the real turn's). Warm is a probe — it does NOT persist
      // (no setModel), it only reads so it sends the same model the next real
      // turn will. See notes/observability-design.md §3.1.
      const storedModel = await deps.conversationStore.getModel(conversationId);
      const effectiveModelName = resolveModelName(opts?.modelName, storedModel);

      if (effectiveModelName !== undefined && deps.resolveModel !== undefined) {
        const resolved = deps.resolveModel(effectiveModelName);
        if (resolved === undefined) {
          return { error: `unknown model: ${effectiveModelName}` };
        }
        provider = resolved.provider;
        modelOverride = resolved.model;
      } else {
        provider = deps.resolveProvider();
      }

      // Wrap with concurrency limiting (same as the main turn path).
      const warmLimiter = deps.resolveConcurrencyLimiter?.();
      if (warmLimiter !== undefined) {
        const warmWorkspaceId = await deps.conversationStore.getWorkspaceId(conversationId);
        provider = wrapProviderWithConcurrency(
          provider,
          warmLimiter,
          conversationId,
          warmWorkspaceId,
          deps.now?.() ?? Date.now(),
        );
      }

      const baseTools = deps.resolveTools();
      // Resolve cwd the SAME way handleMessage does — pass opts.cwd as the overrideCwd
      // The tools filter is cwd-sensitive (e.g. skill discovery rewrites the
      // `load_skill` description per-cwd). If the warm assembles tools under a
      // different cwd than the real turn, the tools block — the FIRST bytes of
      // the prompt-cache prefix — diverges and the cache misses entirely (0%).
      // A manual reheat sends no cwd, so without this fallback it would warm the
      // wrong prefix. See notes/observability-design.md §3.1.
      const cwd =
        (await deps.conversationStore.getEffectiveCwd(conversationId, opts?.cwd)) ?? undefined;
      const assembled = await deps.applyToolsFilter({
        tools: baseTools,
        conversationId,
        ...(cwd !== undefined ? { cwd } : {}),
      });

      // Resolve reasoning effort the SAME way the real turn does (stored → "high";
      // no per-turn override on warm). A mismatch here silently busts the prompt cache.
      const storedEffort = await deps.conversationStore.getReasoningEffort(conversationId);
      const resolvedEffort = resolveReasoningEffort(undefined, storedEffort);

      const probeMsg: ChatMessage = {
        role: "user",
        chunks: [{ type: "text", text: "reply with just a ." }],
      };
      const messages = [...history, probeMsg];

      // Capture the warm send as a `provider.request` span, flagged `warm: true`
      // so it can be diffed against the corresponding real turn's request (the
      // prompt-cache 0%-hit debugging workflow — see notes/observability-design.md
      // §3.1). Without this the warm body is invisible and the cache bust is
      // undebuggable. The child-bound `warm` attribute flows into the span the
      // provider opens (kernel logger merges child attrs into span attributes).
      const warmLogger = deps.logger?.child({ conversationId, attrs: { warm: true } });
      const providerOpts: ProviderStreamOptions = {
        maxTokens: 1,
        reasoningEffort: resolvedEffort,
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        ...(warmLogger !== undefined ? { logger: warmLogger } : {}),
      };

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;

      for await (const event of provider.stream(messages, assembled.tools, providerOpts)) {
        if ((event as ProviderEvent).type === "usage") {
          const usageEvent = event as UsageEvent;
          inputTokens = usageEvent.usage.inputTokens;
          outputTokens = usageEvent.usage.outputTokens;
          cacheReadTokens = usageEvent.usage.cacheReadTokens ?? 0;
          cacheWriteTokens = usageEvent.usage.cacheWriteTokens ?? 0;
        }
      }

      const result: WarmResult = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
      deps.emit(warmCompleted, { conversationId, usage: result });
      return result;
    },
  };
}

const DEFAULT_KEEP_LAST_N = 10;
const DEFAULT_COMPACT_PERCENT = 85;

/**
 * No-op emit used as a fallback when the orchestrator is constructed without an
 * `emit` (some tests). `performCompaction` requires a non-optional `emit` (it
 * emits `conversationCompacted`); the in-flight path degrades to emitting
 * nothing rather than skipping compaction entirely. Generic-typed so it
 * satisfies `PerformCompactionDeps["emit"]` for any hook payload type.
 */
const noopEmit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void =
  () => {};

const COMPACTION_SYSTEM_PROMPT =
  "You are a conversation summarizer. Summarize the following conversation concord concisely but comprehensively. " +
  "Focus on key decisions, context, file paths, and any unresolved questions. " +
  "The summary must preserve enough detail for the conversation to continue with full context.";

function formatMessagesForSummary(messages: readonly ChatMessage[]): string {
  return messages
    .map((msg) => {
      const text = msg.chunks
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "tool-call") return `[tool: ${c.toolName}]`;
          if (c.type === "tool-result") return `[tool result: ${c.content.slice(0, 200)}]`;
          return "";
        })
        .join("");
      return `${msg.role}: ${text}`;
    })
    .join("\n\n");
}

/**
 * Deps for {@link performCompaction} — the subset of `SessionOrchestratorDeps`
 * needed to summarize old history, fork it to an archive, and replace it with
 * a summary + recent messages. Structural so both the compaction SERVICE
 * (`compact`, manual + post-seal auto) and the IN-FLIGHT compaction path (the
 * turn loop's `onStepBoundary`) can call the same shared core without duplicating
 * the summarization/fork/replace/emit logic. The active-conversation guard and
 * the threshold check are the CALLERS' policy (they differ between the two
 * paths) and are NOT performed here.
 */
interface PerformCompactionDeps {
  readonly conversationStore: ConversationStore;
  readonly resolveProvider: () => ProviderContract;
  readonly resolveModel?: (
    modelName: string,
  ) => { provider: ProviderContract; model: string } | undefined;
  readonly resolveSystemPrompt?: () => SystemPromptService | undefined;
  readonly resolveConcurrencyLimiter?: () => ConcurrencyLimiter | undefined;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
}

/** Result of a successful {@link performCompaction}. */
interface PerformCompactionResult {
  readonly summary: string;
  readonly newConversationId: string;
  readonly messagesSummarized: number;
  readonly messagesKept: number;
  /**
   * The system-role summary message that heads the compacted history
   * (`[summaryMessage, ...recentKept]`). Returned so the in-flight caller can
   * build the kernel's replacement history with the SAME summary object.
   */
  readonly summaryMessage: ChatMessage;
}

/**
 * The shared compaction core: load the conversation history from the store,
 * summarize the oldest `history.length - keepLastN` messages via a provider
 * stream, fork the full pre-compaction history to an archive (non-destructive),
 * and replace the live history with `[summaryMessage, ...recentKept]`. Emits
 * `conversationCompacted`. Returns the result (incl. the `summaryMessage`) or an
 * error object.
 *
 * Performs NO active-conversation guard and NO threshold check — those are the
 * callers' policy. No-ops (returns an error) when the conversation is too
 * short to compact (≤ keepLastN messages) or the summary is empty.
 */
async function performCompaction(
  deps: PerformCompactionDeps,
  conversationId: string,
  opts: { readonly keepLastN?: number; readonly modelName?: string },
): Promise<PerformCompactionResult | { readonly error: string }> {
  const history = await deps.conversationStore.load(conversationId);
  const keepLastN = opts?.keepLastN ?? DEFAULT_KEEP_LAST_N;

  if (history.length <= keepLastN) {
    return { error: "conversation too short to compact" };
  }

  // Split: old messages to summarize + recent messages to keep.
  const toSummarize = history.slice(0, history.length - keepLastN);
  const toKeep = history.slice(history.length - keepLastN);

  // Resolve provider
  let provider: ProviderContract;
  let modelOverride: string | undefined;
  if (opts?.modelName !== undefined && deps.resolveModel !== undefined) {
    const resolved = deps.resolveModel(opts.modelName);
    if (resolved === undefined) return { error: `unknown model: ${opts.modelName}` };
    provider = resolved.provider;
    modelOverride = resolved.model;
  } else {
    provider = deps.resolveProvider();
  }

  // Wrap with concurrency limiting (same as the main turn path).
  const compactionLimiter = deps.resolveConcurrencyLimiter?.();
  if (compactionLimiter !== undefined) {
    const compactionWorkspaceId = await deps.conversationStore.getWorkspaceId(conversationId);
    provider = wrapProviderWithConcurrency(
      provider,
      compactionLimiter,
      conversationId,
      compactionWorkspaceId,
      deps.now?.() ?? Date.now(),
    );
  }

  // Build the summarization request: system prompt + conversation text + instruction
  const conversationText = formatMessagesForSummary(toSummarize);
  const summaryRequest: ChatMessage = {
    role: "user",
    chunks: [
      {
        type: "text",
        text: `Please summarize the following conversation:\n\n${conversationText}`,
      },
    ],
  };

  const providerOpts: ProviderStreamOptions = {
    maxTokens: 2000,
    ...(modelOverride !== undefined ? { model: modelOverride } : {}),
    ...(deps.logger !== undefined
      ? { logger: deps.logger.child({ conversationId, attrs: { compaction: true } }) }
      : {}),
  };

  // Reconstruct the system prompt on compaction (fresh variable
  // resolution — files/cwd/time may have changed since construction).
  // The construct call also persists the result for future turns. When
  // the system-prompt service is unavailable, fall back to the
  // compaction-only system prompt (current behavior, no regression).
  const systemPromptService = deps.resolveSystemPrompt?.();
  let compactionSystemPrompt: string;
  if (systemPromptService !== undefined) {
    const cwd = (await deps.conversationStore.getEffectiveCwd(conversationId)) ?? process.cwd();
    const workspaceId = await deps.conversationStore.getWorkspaceId(conversationId);
    const computerId = await deps.conversationStore.getEffectiveComputer(conversationId);
    const constructed = await systemPromptService.construct(conversationId, cwd, {
      ...(opts?.modelName !== undefined ? { model: opts.modelName } : {}),
      workspaceId,
      ...(computerId !== null ? { computerId } : {}),
    });
    compactionSystemPrompt = `${constructed}\n\n${COMPACTION_SYSTEM_PROMPT}`;
  } else {
    compactionSystemPrompt = COMPACTION_SYSTEM_PROMPT;
  }

  // Call the provider and accumulate the summary
  let summary = "";
  for await (const event of provider.stream([summaryRequest], [], {
    ...providerOpts,
    systemPrompt: compactionSystemPrompt,
  })) {
    if ((event as ProviderEvent).type === "text-delta") {
      summary += (event as { delta: string }).delta;
    } else if ((event as ProviderEvent).type === "error") {
      return { error: (event as { message: string }).message };
    }
  }

  if (summary.trim().length === 0) {
    return { error: "model produced empty summary" };
  }

  // Non-destructive: fork the full pre-compaction history to a new
  // archive conversation. The original conversation keeps its ID
  // (so messaging between agents still works) and gets the compacted
  // content. The archive inherits the original's compactedFrom,
  // creating a chain: A → Y → X → ...
  const archiveId = crypto.randomUUID();
  await deps.conversationStore.forkHistory(conversationId, archiveId);

  // Replace history: [system: summary] + recent messages
  const summaryMessage: ChatMessage = {
    role: "system",
    chunks: [
      {
        type: "text",
        text: `The following is a summary of the previous conversation:\n\n${summary}`,
      },
    ],
  };

  await deps.conversationStore.replaceHistory(conversationId, [summaryMessage, ...toKeep]);
  await deps.conversationStore.setCompactedFrom(conversationId, archiveId);

  deps.emit(conversationCompacted, {
    conversationId,
    newConversationId: archiveId,
    messagesSummarized: toSummarize.length,
    messagesKept: toKeep.length,
  });

  return {
    summary,
    newConversationId: archiveId,
    messagesSummarized: toSummarize.length,
    messagesKept: toKeep.length,
    summaryMessage,
  };
}

export function createCompactionService(
  deps: SessionOrchestratorDeps & {
    readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
  },
  activeConversations: ReadonlySet<string>,
): CompactionService {
  return {
    async compact(conversationId, opts) {
      if (activeConversations.has(conversationId)) {
        return { error: "conversation is generating" };
      }

      // Auto mode: check if contextSize exceeds percent of contextWindow.
      // The threshold check is the caller's policy (uses persisted turn
      // metrics) and is NOT performed by the shared `performCompaction` core.
      if (opts?.auto === true) {
        const stored = await deps.conversationStore.getCompactPercent(conversationId);
        const percent = stored ?? DEFAULT_COMPACT_PERCENT;
        if (percent <= 0) return { error: "auto-compact disabled" };
        const metrics = await deps.conversationStore.loadMetrics(conversationId);
        const lastTurn = metrics[metrics.length - 1];
        if (lastTurn === undefined) return { error: "no metrics" };
        const contextSize = lastTurn.contextSize;
        if (contextSize === undefined) return { error: "no context size" };

        // Resolve the model's context window.
        const modelName = opts.modelName;
        if (modelName === undefined || deps.resolveModelInfo === undefined) {
          return { error: "cannot resolve model info" };
        }
        const info = await deps.resolveModelInfo(modelName);
        if (info?.contextWindow === undefined) {
          return { error: "model context window unknown" };
        }
        const threshold = Math.floor(info.contextWindow * (percent / 100));
        if (contextSize < threshold) return { error: "threshold not exceeded" };
      }

      // Shared summarize + fork + replace + emit core (no active guard, no
      // threshold — those are this caller's policy above). The length check
      // ("conversation too short to compact") lives inside the core.
      const outcome = await performCompaction(deps, conversationId, {
        ...(opts?.keepLastN !== undefined ? { keepLastN: opts.keepLastN } : {}),
        ...(opts?.modelName !== undefined ? { modelName: opts.modelName } : {}),
      });
      if ("error" in outcome) return { error: outcome.error };

      const { summary, newConversationId, messagesSummarized, messagesKept } = outcome;
      const result: CompactionResult = {
        summary,
        newConversationId,
        messagesSummarized,
        messagesKept,
      };
      return result;
    },
  };
}
