/**
 * One relay: a Discord chat thread mirrored with one Dispatch conversation.
 *
 * Owns, for its thread: the orchestrator subscription, the live formatter,
 * the paced sender, the typing lease, and the record of prompts it submitted
 * itself (so Discord-originated prompts aren't echoed back, and their 📥 can
 * be followed by ✅ when delivered).
 */

import type { ConversationStore } from "@dispatch/conversation-store";
import type { Logger } from "@dispatch/kernel";
import type { EnqueueResult, SessionOrchestrator } from "@dispatch/session-orchestrator";
import type { AgentEvent, ImageInput } from "@dispatch/wire";
import type { FelicityClient } from "./client.js";
import { RelayFormatter } from "./formatter.js";
import { historyToEvents, planReplay, renderMessages } from "./replay.js";
import { type Clock, type SenderOptions, ThreadSender } from "./sender.js";

/** Typing lease length and renewal cadence (§3.7). */
export const TYPING_TTL_MS = 30_000;
export const TYPING_RENEW_MS = 10_000;

/** Acknowledgement reactions on the user's Discord message. */
export const REACT_STARTED = "▶️";
export const REACT_QUEUED = "📥";
export const REACT_DELIVERED = "✅";
export const REACT_STOPPED = "⏹️";
export const REACT_DROPPED = "⚠️";

const MAX_OWN_ENTRIES = 50;

export type RelayOrchestrator = Pick<SessionOrchestrator, "subscribe" | "isActive" | "enqueue">;
export type RelayStore = Pick<ConversationStore, "loadSince" | "loadMetrics">;

export interface RelayDeps {
  readonly threadId: string;
  readonly conversationId: string;
  readonly orchestrator: RelayOrchestrator;
  readonly store: RelayStore;
  readonly client: FelicityClient;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Unique per attachment; prefixes idempotency keys. */
  readonly idPrefix: string;
  /** Test/ops overrides for the sender's pacing. */
  readonly sender?: Pick<SenderOptions, "liveSpacingMs" | "replaySpacingMs" | "mergeThreshold">;
}

export interface ReplayRequest {
  readonly count: number;
  readonly requestedCount?: number;
}

/** A prompt this relay submitted from Discord. */
interface OwnEntry {
  readonly text: string;
  readonly sourceMessageId: string | null;
  state: "submitting" | "queued" | "started";
  consumed: boolean;
}

export class Relay {
  readonly threadId: string;
  readonly conversationId: string;
  private readonly sender: ThreadSender;
  private formatter = new RelayFormatter();
  private unsubscribe: (() => void) | undefined;
  private readonly own: OwnEntry[] = [];
  private sealedTurns = new Set<string>();
  private turnActive = false;
  private replaying = false;
  private stopped = false;
  private typingOn = false;
  private typingAbort: AbortController | undefined;

  constructor(private readonly deps: RelayDeps) {
    this.threadId = deps.threadId;
    this.conversationId = deps.conversationId;
    this.sender = new ThreadSender({
      channelId: deps.threadId,
      client: deps.client,
      clock: deps.clock,
      logger: deps.logger,
      idPrefix: deps.idPrefix,
      ...deps.sender,
      onDrain: () => this.updateTyping(),
    });
  }

  /** Operations still waiting in this thread's sender. */
  get pending(): number {
    return this.sender.pending;
  }

  /** Resolves when everything queued so far has been sent. */
  drained(): Promise<void> {
    return this.sender.drained();
  }

  /**
   * Attach: subscribe first (buffering), load persisted metrics then
   * history, queue the replay, then go live. Turns already persisted come
   * from history; the in-flight (or freshly sealed, unpersisted) turn comes
   * from the live stream — never both.
   */
  async start(replay?: ReplayRequest): Promise<void> {
    const buffered: AgentEvent[] = [];
    let live = false;
    this.unsubscribe = this.deps.orchestrator.subscribe(this.conversationId, (ev) => {
      if (this.stopped) return;
      if (live) this.onEvent(ev);
      else buffered.push(ev);
    });
    this.turnActive = this.deps.orchestrator.isActive(this.conversationId);
    const wantReplay = replay !== undefined && replay.count > 0;
    if (wantReplay) {
      this.replaying = true;
      this.updateTyping();
    }
    try {
      const metrics = await this.deps.store.loadMetrics(this.conversationId);
      this.sealedTurns = new Set(metrics.map((m) => m.turnId));
      this.formatter = new RelayFormatter({ initialTurnCount: metrics.length });
      if (wantReplay && replay !== undefined) {
        const chunks = await this.deps.store.loadSince(this.conversationId);
        const seenLive = new Set(buffered.map((e) => ("turnId" in e ? e.turnId : "")));
        const history = chunks.filter(
          (c) =>
            c.turnId === undefined || this.sealedTurns.has(c.turnId) || !seenLive.has(c.turnId),
        );
        const all = renderMessages(historyToEvents(this.conversationId, history, metrics));
        const plan = planReplay(all, replay.count, replay.requestedCount);
        if (!this.stopped) {
          if (plan.header !== null) {
            this.sender.upsert(
              { type: "upsert", key: "replay-header", content: plan.header },
              {
                replay: true,
              },
            );
          }
          for (const msg of plan.messages) {
            this.sender.upsert(
              { type: "upsert", key: `replay-${msg.key}`, content: msg.content },
              { replay: true },
            );
          }
        }
        this.deps.logger.info("relay replay queued", {
          threadId: this.threadId,
          conversationId: this.conversationId,
          replayed: plan.messages.length,
          total: plan.total,
        });
      }
    } finally {
      this.replaying = false;
      live = true;
      for (const ev of buffered) this.onEvent(ev);
      this.updateTyping();
    }
  }

  /**
   * Submit a Discord prompt: `enqueue` (idle → new turn, active → steering
   * queue), then acknowledge with ▶️ or 📥 (→ ✅ once delivered).
   */
  async submit(input: {
    readonly text: string;
    readonly images: readonly ImageInput[];
    readonly sourceMessageId: string | null;
  }): Promise<EnqueueResult> {
    const entry: OwnEntry = {
      text: input.text,
      sourceMessageId: input.sourceMessageId,
      state: "submitting",
      consumed: false,
    };
    this.own.push(entry);
    if (this.own.length > MAX_OWN_ENTRIES) this.own.shift();
    let result: EnqueueResult;
    try {
      result = await this.deps.orchestrator.enqueue({
        conversationId: this.conversationId,
        text: input.text,
        ...(input.images.length > 0 ? { images: input.images } : {}),
      });
    } catch (err) {
      this.forget(entry);
      throw err;
    }
    if (result.startedTurn) {
      entry.state = "started";
      this.ack(entry, REACT_STARTED);
      if (entry.consumed) this.forget(entry);
    } else if (result.messageId === undefined && result.queue.length === 0) {
      // Degraded: no message-queue extension — the message was dropped.
      this.forget(entry);
      this.ack(entry, REACT_DROPPED);
    } else {
      entry.state = "queued";
      this.ack(entry, REACT_QUEUED);
      if (entry.consumed) {
        this.ack(entry, REACT_DELIVERED);
        this.forget(entry);
      }
    }
    return result;
  }

  /** React on a Discord message in this thread, in order with the relay's output. */
  react(messageId: string, emoji: string): void {
    this.sender.react(messageId, emoji);
  }

  /** Detach: unsubscribe, drop queued output, release the typing lease. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sender.close();
    await this.releaseTyping();
  }

  // ── live events ─────────────────────────────────────────────────────────

  private onEvent(ev: AgentEvent): void {
    if (this.stopped) return;
    if ("turnId" in ev && this.sealedTurns.has(ev.turnId)) return; // already in history
    let input: AgentEvent | null = ev;
    switch (ev.type) {
      case "user-message": {
        this.turnActive = true;
        const rest = this.filterOwn(ev.text);
        input =
          rest === null
            ? { type: "turn-start", conversationId: ev.conversationId, turnId: ev.turnId }
            : { ...ev, text: rest };
        break;
      }
      case "steering": {
        this.turnActive = true;
        const rest = this.filterOwn(ev.text);
        input = rest === null ? null : { ...ev, text: rest };
        break;
      }
      case "turn-start":
        this.turnActive = true;
        break;
      case "turn-ended":
        this.turnActive = false;
        break;
      default:
        break;
    }
    if (input !== null) {
      for (const op of this.formatter.push(input)) this.sender.upsert(op);
    }
    this.updateTyping();
  }

  /**
   * Strip the prompts this relay submitted from an echoed input. Returns the
   * text still to echo, or null when it was entirely ours. Matched entries
   * that were queued get their ✅.
   */
  private filterOwn(text: string): string | null {
    const open = this.own.filter((e) => !e.consumed);
    const exact =
      open.find((e) => e.text === text) ??
      open.find((e) => e.text.length > 0 && text.startsWith(e.text));
    if (exact !== undefined) {
      this.consume(exact);
      return null;
    }
    let rest = text;
    let matched = false;
    for (const e of open) {
      if (e.text.length === 0) continue;
      const at = rest.indexOf(e.text);
      if (at < 0) continue;
      rest = rest.slice(0, at) + rest.slice(at + e.text.length);
      matched = true;
      this.consume(e);
    }
    if (!matched) return text;
    const trimmed = rest.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private consume(entry: OwnEntry): void {
    entry.consumed = true;
    if (entry.state === "queued") {
      this.ack(entry, REACT_DELIVERED);
      this.forget(entry);
    } else if (entry.state === "started") {
      this.forget(entry);
    }
  }

  private forget(entry: OwnEntry): void {
    const i = this.own.indexOf(entry);
    if (i >= 0) this.own.splice(i, 1);
  }

  private ack(entry: OwnEntry, emoji: string): void {
    if (entry.sourceMessageId !== null) this.sender.react(entry.sourceMessageId, emoji);
  }

  // ── typing lease ────────────────────────────────────────────────────────

  private updateTyping(): void {
    const want = !this.stopped && (this.turnActive || this.replaying || this.sender.pending > 0);
    if (want && !this.typingOn) {
      this.typingOn = true;
      const abort = new AbortController();
      this.typingAbort = abort;
      void this.renewTyping(abort.signal);
    } else if (!want && this.typingOn) {
      void this.releaseTyping();
    }
  }

  private async renewTyping(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.deps.client.setTyping(this.threadId, true, TYPING_TTL_MS);
      } catch (err) {
        this.deps.logger.debug("typing lease renewal failed", {
          threadId: this.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await this.deps.clock.sleep(TYPING_RENEW_MS, signal);
    }
  }

  private async releaseTyping(): Promise<void> {
    if (!this.typingOn) return;
    this.typingOn = false;
    this.typingAbort?.abort();
    this.typingAbort = undefined;
    try {
      await this.deps.client.setTyping(this.threadId, false);
    } catch (err) {
      this.deps.logger.debug("typing lease release failed", {
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
