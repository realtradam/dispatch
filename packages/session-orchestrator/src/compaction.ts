import type { ConversationStore } from "@dispatch/conversation-store";
import {
  abortableIteration,
  type ChatMessage,
  type CompactionResult,
  defineService,
  type EventHookDescriptor,
  type Logger,
  type ProviderContract,
  type ProviderEvent,
  type ProviderStreamOptions,
  type ServiceHandle,
} from "@dispatch/kernel";
import {
  type ConcurrencyLimiter,
  wrapProviderWithConcurrency,
} from "@dispatch/provider-concurrency";
import type { SystemPromptService } from "@dispatch/system-prompt";
import { conversationCompacted } from "./hooks.js";
import type { SessionOrchestratorDeps } from "./orchestrator.js";

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

export const DEFAULT_KEEP_LAST_N = 10;
export const DEFAULT_COMPACT_PERCENT = 85;

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
  /**
   * Optional cancellation signal for the in-flight path. When provided, an
   * abort prevents compaction from starting new work (provider stream,
   * fork/replace), and causes the provider consumption to be raced against the
   * signal. Manual / post-seal / background callers omit it — cancellation is
   * only supplied by the active-turn caller.
   */
  readonly signal?: AbortSignal;
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
  /**
   * The full compacted history `[summaryMessage, ...recentKept]` exactly as
   * written to the store. The in-flight caller returns this to the kernel so
   * the kernel's working history and the store stay byte-aligned (the same
   * `recentKept` slice — taken from the caller-supplied live `messages` — is
   * used for BOTH the store write and this return value).
   */
  readonly compactedMessages: readonly ChatMessage[];
}

/**
 * The shared compaction core: summarize the oldest `history.length -
 * keepLastN` messages via a provider stream, fork the full pre-compaction
 * history to an archive (non-destructive), and replace the live history with
 * `[summaryMessage, ...recentKept]`. Emits `conversationCompacted`. Returns the
 * result (incl. the `summaryMessage` + the `compactedMessages`) or an error.
 *
 * History source: when `opts.messages` is provided (the in-flight path), it is
 * used as the authoritative history — this is the kernel's LIVE messages array,
 * which includes mid-turn steering messages (and the vision-transformed
 * provider view) that a store reload could miss (the steering persist may not
 * have completed, or — before this fix — was never done at all). Using the live
 * array keeps the store write and the kernel's replacement aligned (same
 * `recentKept` slice), avoiding the DB↔LLM structural divergence where
 * independent slices dropped different messages. When `opts.messages` is
 * omitted (the post-seal/manual `compact()` path — the turn has ended, so the
 * store is stable), the history is loaded from the store.
 *
 * Performs NO active-conversation guard and NO threshold check — those are the
 * callers' policy. No-ops (returns an error) when the conversation is too
 * short to compact (≤ keepLastN messages) or the summary is empty.
 */
export async function performCompaction(
  deps: PerformCompactionDeps,
  conversationId: string,
  opts: {
    readonly keepLastN?: number;
    readonly modelName?: string;
    /** The kernel's live messages array (in-flight path). Omit to load the store (post-seal/manual). */
    readonly messages?: readonly ChatMessage[];
  },
): Promise<PerformCompactionResult | { readonly error: string }> {
  const { signal } = deps;
  // Use the caller-supplied live messages (in-flight) or load the store
  // (post-seal/manual — the store is stable once the turn has ended).
  const history = opts.messages ?? (await deps.conversationStore.load(conversationId));
  const keepLastN = opts?.keepLastN ?? DEFAULT_KEEP_LAST_N;

  if (history.length <= keepLastN) {
    return { error: "conversation too short to compact" };
  }

  // Abort before any summarization work: don't start a provider call or WOTE
  // fork/replace after cancellation.
  if (signal?.aborted) {
    return { error: "aborted" };
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

  // Call the provider and accumulate the summary. Thread the signal into the
  // ProviderStreamOptions (so the concurrency wrapper's acquire is cancellable)
  // AND race the iterator consumption against it (defensive barrier).
  const compactionOpts: ProviderStreamOptions = {
    ...providerOpts,
    systemPrompt: compactionSystemPrompt,
    ...(signal !== undefined ? { signal } : {}),
  };
  let summary = "";
  if (signal !== undefined) {
    const stream = provider.stream([summaryRequest], [], compactionOpts);
    const iterator = stream[Symbol.asyncIterator]();
    for await (const event of abortableIteration(iterator, signal)) {
      if ((event as ProviderEvent).type === "text-delta") {
        summary += (event as { delta: string }).delta;
      } else if ((event as ProviderEvent).type === "error") {
        // A deliberate abort is cancellation, not a provider error.
        if (signal.aborted) return { error: "aborted" };
        return { error: (event as { message: string }).message };
      }
    }
  } else {
    for await (const event of provider.stream([summaryRequest], [], compactionOpts)) {
      if ((event as ProviderEvent).type === "text-delta") {
        summary += (event as { delta: string }).delta;
      } else if ((event as ProviderEvent).type === "error") {
        return { error: (event as { message: string }).message };
      }
    }
  }

  // Abort after summarization but before fork/replace: do not fork or replace
  // history (the archive would be orphaned and the live history untouched,
  // which is safe, but skipping is cleaner — nothing was modified yet). Checked
  // BEFORE the empty-summary check so a deliberate abort is never misreported
  // as "model produced empty summary" (which can happen when the abort fires
  // before any summary text is streamed).
  if (signal?.aborted) {
    return { error: "aborted" };
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

  // Commit boundary: if the signal fires after forkHistory starts, let the
  // fork settle (it writes to a NEW archive ID, not the live conversation —
  // harmless if orphaned), then skip replaceHistory/setCompactedFrom. The
  // archive is orphaned but the LIVE history is untouched, which is safe.
  if (signal?.aborted) {
    return { error: "aborted" };
  }

  // Replace history: [system: summary] + the recent kept messages. `toKeep`
  // is sliced from the caller-supplied live `messages` (in-flight) — the SAME
  // slice returned below as `compactedMessages` — so the store and the kernel's
  // working history stay byte-aligned (same messages kept/dropped).
  const summaryMessage: ChatMessage = {
    role: "system",
    chunks: [
      {
        type: "text",
        text: `The following is a summary of the previous conversation:\n\n${summary}`,
      },
    ],
  };

  const compactedMessages: readonly ChatMessage[] = [summaryMessage, ...toKeep];
  await deps.conversationStore.replaceHistory(conversationId, compactedMessages);
  const historyEpoch = await deps.conversationStore.getHistoryEpoch(conversationId);
  await deps.conversationStore.setCompactedFrom(conversationId, archiveId);

  deps.emit(conversationCompacted, {
    conversationId,
    historyEpoch,
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
    compactedMessages,
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
