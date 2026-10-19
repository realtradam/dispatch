/**
 * Background diagnostics check queue — the non-blocking half of the LSP
 * extension.
 *
 * An edit only ENQUEUES a check (`queueCheck` returns immediately); the check
 * runs concurrently against every matching language server, and when it lands
 * the queue:
 *
 *  1. caches the full result (the `lsp` tool's `diagnostics` operation serves
 *     it without a second round-trip),
 *  2. diffs the errors/warnings against what this conversation was already
 *     TOLD (`notices.ts`, position-insensitive multiset identity), and
 *  3. delivers ONE coalesced notice per conversation through the
 *     session-orchestrator — mid-turn as steering, or by starting a turn when
 *     the conversation is idle (with Stop / loop-cap guards).
 *
 * Per (conversation, file) only the LATEST content matters: a check that was
 * superseded while in flight is re-run once with the newest content, and a
 * superseded result is never cached or announced.
 *
 * All effects — the aggregation `check`, time-free delivery, and logging — are
 * injected, so the queue is unit-testable with no servers, no timers, and no
 * mocks of our own modules.
 */

import type { AgentEvent } from "@dispatch/kernel";
import type { Diagnostic } from "./diagnostics.js";
import {
  baselineFromIssues,
  diffNewIssues,
  type FileIssueCounts,
  formatNotice,
  type IssueBaseline,
} from "./notices.js";
import type { DiagnosticsResult, QueueCheckOpts } from "./types.js";

/** Run the concurrent multi-server aggregation for one file. */
export type CheckRunner = (opts: {
  readonly filePath: string;
  readonly text?: string;
  readonly cwd: string;
}) => Promise<CheckOutcome>;

export interface CheckOutcome {
  /** Full formatted report (all errors + warnings), same format as the tool. */
  readonly formatted: string;
  /** At least one server exceeded its cap (silent for notices, shown in reports). */
  readonly timedOut: boolean;
  /** Structured errors/warnings behind `formatted`, for the new-issue diff. */
  readonly issues: readonly Diagnostic[];
}

/** What `enqueue` did. `messageId` is the queued steering message when active. */
export interface NoticeEnqueueResult {
  readonly startedTurn: boolean;
  readonly messageId: string | undefined;
}

/**
 * The delivery seam (implemented by the extension over the session-orchestrator
 * service). Lazy on purpose: the orchestrator may not be loaded, and lsp must
 * degrade off rather than fail activation.
 */
export interface NoticeDelivery {
  readonly isActive: (conversationId: string) => boolean;
  readonly enqueue: (input: {
    readonly conversationId: string;
    readonly text: string;
  }) => NoticeEnqueueResult;
  /** True when a still-queued message was removed (i.e. it was NOT delivered). */
  readonly cancel: (input: {
    readonly conversationId: string;
    readonly messageId: string;
  }) => boolean;
  /** Turn events for a conversation, or undefined when no orchestrator is available. */
  readonly subscribe: (
    conversationId: string,
    listener: (event: AgentEvent) => void,
  ) => (() => void) | undefined;
}

export interface CheckQueueLogger {
  readonly warn: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
}

export interface CheckQueueDeps {
  readonly check: CheckRunner;
  readonly delivery: NoticeDelivery;
  readonly logger?: CheckQueueLogger | undefined;
  /** Tracked-file LRU per conversation (mirrors MAX_OPEN_DOCUMENTS). Default 50. */
  readonly maxFilesPerConversation?: number | undefined;
  /** Max consecutive LSP-initiated turns without an intervening user message. Default 3. */
  readonly maxAutoTurns?: number | undefined;
}

export type WaitForResultOpts = QueueCheckOpts;

/** One file's cached report (for the path-less `diagnostics` operation). */
export interface FileReport {
  readonly filePath: string;
  readonly cwd: string;
  readonly formatted: string;
}

interface PendingFile {
  readonly errors: number;
  readonly warnings: number;
  /** Issue snapshot the counts were computed from — committed on delivery. */
  readonly issues: readonly Diagnostic[];
}

interface PendingNotice {
  text: string;
  messageId: string | undefined;
  files: Map<string, PendingFile>;
}

interface FileState {
  readonly filePath: string;
  cwd: string;
  text: string | undefined;
  /** Monotonic request sequence: the latest requested content wins. */
  seq: number;
  /** Sequence of the last applied (non-superseded) run. */
  processedSeq: number;
  inFlight: Promise<void> | null;
  /** Issues this conversation has been TOLD are present (delivered notices). */
  baseline: IssueBaseline;
  /** Latest observed issues (background check OR on-demand report read). */
  lastIssues: readonly Diagnostic[] | null;
  lastResult: {
    readonly seq: number;
    readonly formatted: string;
    readonly timedOut: boolean;
  } | null;
}

interface ConversationState {
  readonly id: string;
  closed: boolean;
  cwd: string;
  files: Map<string, FileState>;
  pending: PendingNotice | null;
  /** Consecutive turns this queue auto-started with no user message between. */
  autoTurns: number;
  /** The most recent turn was stopped/aborted by the user — respect Stop. */
  lastTurnAborted: boolean;
  /** Text of an auto-started turn we are about to observe as its opening message. */
  expectedAutoText: string | null;
  unsubscribe: (() => void) | null;
}

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_AUTO_TURNS = 3;

export class DiagnosticsCheckQueue {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly deps: CheckQueueDeps;

  constructor(deps: CheckQueueDeps) {
    this.deps = deps;
  }

  /**
   * Fire-and-forget: register the latest content for (conversation, file) and
   * run a check. Never throws, never blocks the caller (the tool/edit path).
   */
  queueCheck(opts: QueueCheckOpts): void {
    // Called from the edit/write tool path: it must never throw into the tool.
    try {
      this.queueCheckInner(opts);
    } catch (error: unknown) {
      this.warn("failed to enqueue LSP diagnostics check", { error: errText(error) });
    }
  }

  private queueCheckInner(opts: QueueCheckOpts): void {
    if (opts.conversationId.length === 0) return;
    const conv = this.conversationState(opts.conversationId);
    const file = this.fileState(conv, opts.filePath, opts.cwd);
    conv.cwd = opts.cwd;
    file.text = opts.text;
    file.seq += 1;
    this.ensureSubscribed(conv);
    this.startRun(conv, file);
  }

  /**
   * The cached report for a file, when no newer edit has happened since the
   * check that produced it. `undefined` means "not fresh" — the caller should
   * wait for / run a check.
   */
  getFreshResult(opts: {
    readonly conversationId: string;
    readonly filePath: string;
  }): DiagnosticsResult | undefined {
    const conv = this.conversations.get(opts.conversationId);
    if (conv === undefined) return undefined;
    const file = conv.files.get(opts.filePath);
    if (file === undefined || file.lastResult === null) return undefined;
    if (file.lastResult.seq !== file.seq) return undefined;
    return toResult(file.lastResult);
  }

  /**
   * The `lsp diagnostics` report path: return the fresh cached result, else
   * wait for an in-flight check (or run one now — a READ: it never announces
   * anything and never moves the notified baseline).
   */
  async waitForResult(opts: WaitForResultOpts): Promise<DiagnosticsResult> {
    const conv = this.conversationState(opts.conversationId);
    const file = this.fileState(conv, opts.filePath, opts.cwd);
    conv.cwd = opts.cwd;

    if (file.inFlight !== null) {
      try {
        await file.inFlight;
      } catch {
        // The run logs its own failure; fall through to a fresh read.
      }
    }
    const fresh = this.getFreshResult(opts);
    if (fresh !== undefined) return fresh;

    const seq = file.seq;
    const text = opts.text ?? file.text;
    try {
      const outcome = await this.deps.check({
        filePath: opts.filePath,
        cwd: opts.cwd,
        ...(text !== undefined ? { text } : {}),
      });
      if (seq === file.seq) {
        // Same rule as the background run: a fully-skipped READ is not
        // evidence that the file is clean, so it must not move the baseline
        // (which the next check derives its "new issue" diff from).
        if (!outcome.timedOut || outcome.issues.length > 0) {
          file.lastIssues = outcome.issues;
        }
        file.lastResult = { seq, formatted: outcome.formatted, timedOut: outcome.timedOut };
      }
      return { formatted: outcome.formatted, slow: false, timedOut: outcome.timedOut };
    } catch (err: unknown) {
      this.deps.logger?.warn("LSP diagnostics report failed", { error: errText(err) });
      return { formatted: "", slow: false, timedOut: false };
    }
  }

  /**
   * Every tracked file in the conversation whose latest check found
   * errors/warnings. Waits for in-flight checks first so the report reflects
   * the current edit.
   */
  async listResults(conversationId: string): Promise<readonly FileReport[]> {
    const conv = this.conversations.get(conversationId);
    if (conv === undefined) return [];

    const inFlight: Promise<void>[] = [];
    for (const file of conv.files.values()) {
      if (file.inFlight !== null) inFlight.push(file.inFlight);
    }
    if (inFlight.length > 0) await Promise.allSettled(inFlight);

    const reports: FileReport[] = [];
    for (const file of conv.files.values()) {
      if (file.lastResult === null || file.lastResult.formatted === "") continue;
      reports.push({
        filePath: file.filePath,
        cwd: file.cwd,
        formatted: file.lastResult.formatted,
      });
    }
    reports.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return reports;
  }

  /**
   * Conversation closed: drop every queued check, cached result, baseline and
   * the turn subscription, and remove any still-queued notice. Never deliver
   * into a closed conversation.
   */
  purgeConversation(conversationId: string): void {
    const conv = this.conversations.get(conversationId);
    if (conv === undefined) return;
    conv.closed = true;
    this.discardPending(conv);
    this.unsubscribe(conv);
    conv.files.clear();
    this.conversations.delete(conversationId);
  }

  /** Extension unload: release every subscription and queued notice. */
  dispose(): void {
    for (const conv of this.conversations.values()) {
      conv.closed = true;
      this.discardPending(conv);
      this.unsubscribe(conv);
    }
    this.conversations.clear();
  }

  // --- run loop -----------------------------------------------------------

  private startRun(conv: ConversationState, file: FileState): void {
    if (file.inFlight !== null) {
      // Coalesce: only the latest content matters. `file.seq` has already been
      // bumped by the caller, so the in-flight run re-runs once with the
      // newest content when it finishes (and its own result is discarded).
      return;
    }
    const run = this.run(conv, file);
    file.inFlight = run;
    // `run` never rejects (see below), so this chain can only fail on a bug in
    // the cleanup itself — contain it so it cannot become an unhandled rejection.
    void run.finally(() => {
      try {
        if (file.inFlight === run) file.inFlight = null;
        // A request that landed after the loop's final sequence check must not
        // be lost in the gap between that check and this cleanup.
        if (!conv.closed && file.seq !== file.processedSeq && file.inFlight === null) {
          this.startRun(conv, file);
        }
      } catch (error: unknown) {
        this.warn("LSP check cleanup failed", { error: errText(error) });
      }
    });
  }

  /**
   * The background run loop. It must NEVER reject: the promise is stored in
   * `file.inFlight` and observed by `waitForResult`/`listResults`, and its
   * `.finally` chain is fire-and-forget — a rejection would be an unhandled
   * rejection (and on some runtimes a process-level fault).
   */
  private async run(conv: ConversationState, file: FileState): Promise<void> {
    let seq = file.seq;
    try {
      for (;;) {
        seq = file.seq;
        let outcome: CheckOutcome;
        try {
          outcome = await this.deps.check({
            filePath: file.filePath,
            cwd: file.cwd,
            ...(file.text !== undefined ? { text: file.text } : {}),
          });
        } catch (err: unknown) {
          this.warn("LSP background check failed", {
            filePath: file.filePath,
            error: errText(err),
          });
          // Mark the request processed: a failing check must not hot-retry.
          file.processedSeq = seq;
          return;
        }

        // Superseded while in flight: discard this result entirely (never cache
        // it, never announce it) and run once more with the latest content.
        if (seq !== file.seq) continue;

        file.processedSeq = seq;
        // A check that produced NOTHING because every server was skipped is
        // NOT evidence that the file is clean: keep the last known issues so a
        // skipped check can neither clear the notified baseline (which would
        // re-announce old issues later) nor suppress a real notice. The skip
        // notice is still cached in `lastResult` for the full report.
        if (!outcome.timedOut || outcome.issues.length > 0) {
          file.lastIssues = outcome.issues;
        }
        file.lastResult = { seq, formatted: outcome.formatted, timedOut: outcome.timedOut };
        if (conv.closed) return;
        if (outcome.timedOut) {
          // Silent for the agent (the notice only counts new issues); the full
          // report still carries the per-server skip line.
          this.warn("LSP background check skipped a slow server", {
            filePath: file.filePath,
          });
        }
        this.recomputePending(conv);
        return;
      }
    } catch (error: unknown) {
      // Anything thrown while applying/delivering the result (including a bug
      // in our own notice logic) stays inside the LSP extension.
      this.warn("LSP background check post-processing failed", {
        filePath: file.filePath,
        error: errText(error),
      });
      file.processedSeq = seq;
    }
  }

  // --- notice computation + delivery -------------------------------------

  /**
   * Delivery is an INJECTED dependency (the session-orchestrator adapter): it
   * can throw if the orchestrator's store or message queue is broken. Every
   * call is contained so a broken delivery path can never reject a background
   * run, throw into a timer, or break the turn-event subscription.
   */
  private deliveryIsActive(conversationId: string): boolean {
    try {
      return this.deps.delivery.isActive(conversationId);
    } catch (error: unknown) {
      this.warn("LSP notice delivery isActive failed", { error: errText(error) });
      return false;
    }
  }

  private deliveryEnqueue(input: {
    readonly conversationId: string;
    readonly text: string;
  }): NoticeEnqueueResult {
    try {
      const result = this.deps.delivery.enqueue(input);
      return {
        startedTurn: result?.startedTurn === true,
        messageId: typeof result?.messageId === "string" ? result.messageId : undefined,
      };
    } catch (error: unknown) {
      this.warn("LSP notice enqueue failed", { error: errText(error) });
      return { startedTurn: false, messageId: undefined };
    }
  }

  private deliveryCancel(input: {
    readonly conversationId: string;
    readonly messageId: string;
  }): boolean {
    try {
      return this.deps.delivery.cancel(input) === true;
    } catch (error: unknown) {
      this.warn("LSP notice cancel failed", { error: errText(error) });
      // Unknown state: assume it was delivered so the same issues are not
      // re-announced in a loop.
      return false;
    }
  }

  /** Log through the injected logger; logging must never break the queue. */
  private warn(message: string, attrs?: Record<string, string | number | boolean | null>): void {
    try {
      this.deps.logger?.warn(message, attrs);
    } catch {
      // A throwing logger must not defeat containment.
    }
  }

  /**
   * Recompute the conversation's single pending notice from the DELIVERED
   * baseline of every tracked file. If a newer check superseded what was
   * announced but not yet delivered, the file's issues are re-included —
   * nothing the agent was never told can be silently marked as told.
   */
  private recomputePending(conv: ConversationState): void {
    if (conv.closed) return;

    // Settle the previously queued notice BEFORE diffing. `cancelQueuedMessage`
    // is the delivery oracle available to us: a message that is no longer in
    // the queue was drained (delivered) — commit what it announced so it is
    // not repeated. A message still in the queue is removed and re-enqueued
    // below when the recomputed notice is non-empty (at most ONE pending
    // notice per conversation).
    const previous = conv.pending;
    conv.pending = null;
    if (previous !== null && previous.messageId !== undefined) {
      const stillQueued = this.deliveryCancel({
        conversationId: conv.id,
        messageId: previous.messageId,
      });
      if (!stillQueued) this.commit(conv, previous);
    }

    const counts: FileIssueCounts[] = [];
    const files = new Map<string, PendingFile>();

    for (const file of conv.files.values()) {
      if (file.lastIssues === null) continue;
      const diff = diffNewIssues(file.baseline, file.lastIssues);
      // Lower the baseline for issues that are gone so a reappearance is new.
      file.baseline = diff.nextBaseline;
      if (diff.newErrors + diff.newWarnings === 0) continue;
      files.set(file.filePath, {
        errors: diff.newErrors,
        warnings: diff.newWarnings,
        issues: file.lastIssues,
      });
      counts.push({
        filePath: file.filePath,
        newErrors: diff.newErrors,
        newWarnings: diff.newWarnings,
      });
    }

    const text = formatNotice(counts, conv.cwd);
    if (text === "") return;
    this.deliver(conv, text, files);
  }

  /** Record the pending notice's issues as TOLD (what the agent now knows). */
  private commit(conv: ConversationState, pending: PendingNotice): void {
    for (const [filePath, entry] of pending.files) {
      const file = conv.files.get(filePath);
      if (file !== undefined) file.baseline = baselineFromIssues(entry.issues);
    }
  }

  private deliver(conv: ConversationState, text: string, files: Map<string, PendingFile>): void {
    if (conv.closed) return;
    // The orchestrator may have become available since this conversation's
    // first check (subscriptions are resolved lazily).
    this.ensureSubscribed(conv);
    const pending: PendingNotice = { text, messageId: undefined, files };
    conv.pending = pending;

    if (this.deliveryIsActive(conv.id)) {
      // Mid-turn: the message-queue steering path — drained at the next tool-result
      // boundary (or carried into a new turn after seal).
      const result = this.deliveryEnqueue({ conversationId: conv.id, text });
      pending.messageId = result.messageId;
      if (result.startedTurn) this.markDelivered(conv, pending);
      return;
    }

    // Idle → starting a turn. Both guards drop the notice (v1): respect Stop,
    // and never ping-pong past the consecutive-turn cap.
    if (conv.lastTurnAborted) {
      conv.pending = null;
      return;
    }
    if (conv.autoTurns >= this.maxAutoTurns()) {
      conv.pending = null;
      return;
    }

    conv.expectedAutoText = text;
    const result = this.deliveryEnqueue({ conversationId: conv.id, text });
    if (result.startedTurn) {
      conv.autoTurns += 1;
      this.markDelivered(conv, pending);
      return;
    }
    // Lost the idle race (a turn started between isActive and enqueue): it
    // went to the steering queue instead.
    conv.expectedAutoText = null;
    pending.messageId = result.messageId;
  }

  private markDelivered(conv: ConversationState, pending: PendingNotice): void {
    this.commit(conv, pending);
    if (conv.pending === pending) conv.pending = null;
  }

  /** Drop a pending notice and remove it from the queue (Stop / close). */
  private discardPending(conv: ConversationState): void {
    const pending = conv.pending;
    conv.pending = null;
    conv.expectedAutoText = null;
    if (pending === null || pending.messageId === undefined) return;
    this.deliveryCancel({ conversationId: conv.id, messageId: pending.messageId });
  }

  // --- turn events (Stop guard, loop cap reset, delivery confirmation) ----

  private ensureSubscribed(conv: ConversationState): void {
    if (conv.unsubscribe !== null) return;
    try {
      const unsubscribe = this.deps.delivery.subscribe(conv.id, (event) =>
        this.onTurnEvent(conv, event),
      );
      if (unsubscribe !== undefined) conv.unsubscribe = unsubscribe;
    } catch (error: unknown) {
      // Retried on the next check/delivery; the feature degrades, the host does not.
      this.warn("LSP turn-event subscribe failed", { error: errText(error) });
    }
  }

  private onTurnEvent(conv: ConversationState, event: AgentEvent): void {
    // Invoked by the session-orchestrator's `emitToHub`, which does NOT catch
    // listener throws — a throw here would break event delivery for the whole
    // turn (including to the frontend) and could escape into the turn loop.
    try {
      this.handleTurnEvent(conv, event);
    } catch (error: unknown) {
      this.warn("LSP turn-event handling failed", { error: errText(error) });
    }
  }

  private handleTurnEvent(conv: ConversationState, event: AgentEvent): void {
    if (conv.closed) return;
    switch (event.type) {
      case "user-message": {
        const pending = conv.pending;
        const expected = conv.expectedAutoText;

        // Delivery confirmation for EVERY opening message that contains our
        // notice: our own auto-start, and — crucially — a turn the
        // orchestrator CARRIED out of the steering queue after seal
        // (`tryCarryQueue` opens a new turn with the queued text as its
        // user message).
        if (pending !== null && event.text.includes(pending.text)) {
          this.markDelivered(conv, pending);
        }

        if (expected !== null && event.text.includes(expected)) {
          // Our own auto-started turn. `deliver` counts it (it knows whether
          // `enqueue` started a turn); counting here too would halve the cap.
          conv.expectedAutoText = null;
          return;
        }

        // A carried LSP-ONLY turn arrives with no `expectedAutoText`. It IS an
        // LSP-initiated turn, so it must count against the cap — otherwise
        // edit → notice → turn → notice ping-pong never stops. A carry that
        // also contains user steering text is a real user message (below).
        if (pending !== null && event.text === pending.text) {
          conv.autoTurns += 1;
          return;
        }

        // A real user message resets both safety guards.
        conv.autoTurns = 0;
        conv.lastTurnAborted = false;
        conv.expectedAutoText = null;
        return;
      }
      case "steering": {
        // The queue drained our notice into the in-flight turn.
        const pending = conv.pending;
        if (pending !== null && event.text.includes(pending.text)) {
          this.markDelivered(conv, pending);
        }
        return;
      }
      case "done": {
        if (event.reason === "aborted") {
          // Respect Stop: drop the notice AND remove it from the queue, so
          // the orchestrator's post-seal carry can't start a turn either.
          conv.lastTurnAborted = true;
          this.discardPending(conv);
          return;
        }
        conv.lastTurnAborted = false;
        // `done` is emitted BEFORE the turn seals and before the orchestrator's
        // post-seal carry. At the cap, a queued notice would be carried into a
        // NEW turn (a carry does not go through `enqueue`, so `deliver`'s cap
        // check never sees it). Drop it now so the carry has nothing to start.
        if (conv.pending !== null && conv.autoTurns >= this.maxAutoTurns()) {
          this.discardPending(conv);
        }
        return;
      }
      default:
        return;
    }
  }

  private maxAutoTurns(): number {
    return this.deps.maxAutoTurns ?? DEFAULT_MAX_AUTO_TURNS;
  }

  // --- state helpers ------------------------------------------------------

  private conversationState(conversationId: string): ConversationState {
    let conv = this.conversations.get(conversationId);
    if (conv === undefined || conv.closed) {
      conv = {
        id: conversationId,
        closed: false,
        cwd: "",
        files: new Map(),
        pending: null,
        autoTurns: 0,
        lastTurnAborted: false,
        expectedAutoText: null,
        unsubscribe: null,
      };
      this.conversations.set(conversationId, conv);
    }
    return conv;
  }

  /** Release a turn-event subscription, containing an unsubscribe failure. */
  private unsubscribe(conv: ConversationState): void {
    const unsubscribe = conv.unsubscribe;
    conv.unsubscribe = null;
    if (unsubscribe === null) return;
    try {
      unsubscribe();
    } catch (error: unknown) {
      this.warn("LSP turn-event unsubscribe failed", { error: errText(error) });
    }
  }

  /** Get-or-create a file's state, maintaining the insertion-order LRU. */
  private fileState(conv: ConversationState, filePath: string, cwd: string): FileState {
    const existing = conv.files.get(filePath);
    if (existing !== undefined) {
      conv.files.delete(filePath);
      conv.files.set(filePath, existing);
      existing.cwd = cwd;
      return existing;
    }

    const created: FileState = {
      filePath,
      cwd,
      text: undefined,
      seq: 0,
      processedSeq: 0,
      inFlight: null,
      baseline: new Map(),
      lastIssues: null,
      lastResult: null,
    };
    conv.files.set(filePath, created);

    // Bound memory per conversation: evict the least-recently-used entry,
    // preferring one that is not in flight so its result can still land.
    const max = this.deps.maxFilesPerConversation ?? DEFAULT_MAX_FILES;
    while (conv.files.size > max) {
      let victim: string | undefined;
      for (const [key, state] of conv.files) {
        if (state.inFlight === null) {
          victim = key;
          break;
        }
      }
      victim ??= conv.files.keys().next().value;
      if (victim === undefined) break;
      conv.files.delete(victim);
    }
    return created;
  }
}

function toResult(result: { formatted: string; timedOut: boolean }): DiagnosticsResult {
  return { formatted: result.formatted, slow: false, timedOut: result.timedOut };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
