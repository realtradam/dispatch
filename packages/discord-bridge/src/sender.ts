/**
 * The per-thread paced sender: ONE ordered queue of Discord operations per
 * chat thread, executed serially with a minimum spacing (live ~1.1 s,
 * replay ~1.5 s), retried on transport failures / 5xx / `429 backlogged`.
 *
 * It consumes formatter UPSERTS, so edits coalesce for free: a message whose
 * post is still queued is posted with its LATEST content (no post-then-edit),
 * and at most one edit per message is ever pending. Under a large backlog it
 * merges a step's queued tool messages into one combined message (§3.5) so
 * the thread degrades gracefully instead of falling minutes behind.
 *
 * Effects (the Felicity client, the clock, the logger) are injected.
 */

import type { Logger } from "@dispatch/kernel";
import { type FelicityClient, FelicityError } from "./client.js";
import { DISCORD_MESSAGE_LIMIT, middleTruncate } from "./format.js";
import type { UpsertOp } from "./formatter.js";

/** Time, injected (tests drive a manual clock). `sleep` resolves early on abort. */
export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const LIVE_SPACING_MS = 1100;
export const REPLAY_SPACING_MS = 1500;
export const MERGE_THRESHOLD = 50;
const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 30_000;

export interface SenderOptions {
  readonly channelId: string;
  readonly client: Pick<FelicityClient, "postMessage" | "editMessage" | "addReaction">;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Prefix for idempotency keys — unique per relay attachment. `[A-Za-z0-9._:-]`. */
  readonly idPrefix: string;
  readonly liveSpacingMs?: number;
  readonly replaySpacingMs?: number;
  readonly mergeThreshold?: number;
  /** Called whenever the queue goes from non-empty to empty. */
  readonly onDrain?: () => void;
}

interface Rec {
  content: string;
  compact: string | undefined;
  readonly group: string | undefined;
  messageId: string | undefined;
  mergedId: string | undefined;
  posted: boolean;
  failed: boolean;
}

type Entry =
  | { readonly kind: "post"; readonly key: string; readonly spacing: number }
  | { readonly kind: "edit"; readonly target: string; readonly spacing: number }
  | {
      readonly kind: "react";
      readonly messageId: string;
      readonly emoji: string;
      readonly spacing: number;
    };

/** Join merged members: full content, else compact forms, else middle-cut. */
export function combineContents(
  members: readonly { readonly content: string; readonly compact?: string | undefined }[],
): string {
  const full = members.map((m) => m.content).join("\n");
  if (full.length <= DISCORD_MESSAGE_LIMIT) return full;
  const compact = members.map((m) => m.compact ?? m.content).join("\n");
  return middleTruncate(compact, DISCORD_MESSAGE_LIMIT);
}

export class ThreadSender {
  private readonly recs = new Map<string, Rec>();
  private readonly merged = new Map<string, { keys: string[]; messageId: string | undefined }>();
  private readonly queue: Entry[] = [];
  private readonly pendingEdits = new Set<string>();
  private readonly abort = new AbortController();
  private running = false;
  private lastOpAt = Number.NEGATIVE_INFINITY;
  private mergeCount = 0;
  private drainWaiters: (() => void)[] = [];
  private readonly live: number;
  private readonly replay: number;
  private readonly threshold: number;

  constructor(private readonly opts: SenderOptions) {
    this.live = opts.liveSpacingMs ?? LIVE_SPACING_MS;
    this.replay = opts.replaySpacingMs ?? REPLAY_SPACING_MS;
    this.threshold = opts.mergeThreshold ?? MERGE_THRESHOLD;
  }

  /** Operations waiting (including the one in flight). */
  get pending(): number {
    return this.queue.length + (this.running && this.inFlight ? 1 : 0);
  }

  private inFlight = false;

  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  /** Apply a formatter upsert: first sight → post, later → (coalesced) edit. */
  upsert(op: UpsertOp, mode: { readonly replay?: boolean } = {}): void {
    if (this.closed) return;
    const spacing = mode.replay === true ? this.replay : this.live;
    const rec = this.recs.get(op.key);
    if (rec === undefined) {
      this.recs.set(op.key, {
        content: op.content,
        compact: op.compact,
        group: op.group,
        messageId: undefined,
        mergedId: undefined,
        posted: false,
        failed: false,
      });
      this.push({ kind: "post", key: op.key, spacing });
      return;
    }
    rec.content = op.content;
    rec.compact = op.compact;
    if (!rec.posted || rec.failed) return; // the queued post reads the latest content
    const target = rec.mergedId ?? op.key;
    if (this.pendingEdits.has(target)) return;
    this.pendingEdits.add(target);
    this.push({ kind: "edit", target, spacing });
  }

  /** Queue a reaction on an existing Discord message (e.g. the user's prompt). */
  react(messageId: string, emoji: string): void {
    if (this.closed) return;
    this.push({ kind: "react", messageId, emoji, spacing: this.live });
  }

  /** The Discord message id for a formatter key, once posted. */
  messageIdOf(key: string): string | undefined {
    return this.recs.get(key)?.messageId;
  }

  /** Resolves when the queue is empty (immediately if it already is). */
  drained(): Promise<void> {
    if (this.queue.length === 0 && !this.running) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Drop everything queued and stop. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.abort.abort();
    this.queue.length = 0;
    this.pendingEdits.clear();
    this.settleDrain();
  }

  // ── loop ────────────────────────────────────────────────────────────────

  private push(entry: Entry): void {
    this.queue.push(entry);
    if (!this.running) {
      this.running = true;
      void this.run();
    }
  }

  private settleDrain(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  private async run(): Promise<void> {
    // Yield once so a synchronous burst of upserts (one event can update a
    // message several times) coalesces before the first request goes out.
    await Promise.resolve();
    try {
      while (this.queue.length > 0 && !this.closed) {
        const head = this.queue[0] as Entry;
        const wait = this.lastOpAt + head.spacing - this.opts.clock.now();
        if (wait > 0) await this.opts.clock.sleep(wait, this.abort.signal);
        if (this.closed) break;
        const entry = this.queue.shift();
        if (entry === undefined) break;
        this.inFlight = true;
        this.lastOpAt = this.opts.clock.now();
        await this.execute(entry);
        this.inFlight = false;
      }
    } finally {
      this.inFlight = false;
      this.running = false;
      if (this.queue.length > 0 && !this.closed) {
        this.running = true;
        void this.run();
      } else {
        this.settleDrain();
        if (!this.closed) this.opts.onDrain?.();
      }
    }
  }

  private async execute(entry: Entry): Promise<void> {
    switch (entry.kind) {
      case "post":
        return this.post(entry.key);
      case "edit":
        return this.edit(entry.target);
      case "react":
        await this.attempt("react", () =>
          this.opts.client.addReaction(this.opts.channelId, entry.messageId, entry.emoji),
        );
        return;
    }
  }

  private async post(key: string): Promise<void> {
    const rec = this.recs.get(key);
    if (rec === undefined) return;
    const members = this.takeMergeable(key, rec);
    if (members.length > 1) {
      const mergedId = `g${++this.mergeCount}`;
      this.merged.set(mergedId, { keys: members, messageId: undefined });
      for (const k of members) {
        const r = this.recs.get(k);
        if (r !== undefined) r.mergedId = mergedId;
      }
      const id = await this.attempt("post", () =>
        this.opts.client.postMessage(this.opts.channelId, this.mergedContent(mergedId), {
          idempotencyKey: `${this.opts.idPrefix}-${mergedId}`,
        }),
      );
      const group = this.merged.get(mergedId);
      if (group !== undefined) group.messageId = id;
      for (const k of members) {
        const r = this.recs.get(k);
        if (r === undefined) continue;
        r.posted = true;
        r.failed = id === undefined;
        r.messageId = id;
      }
      return;
    }
    const id = await this.attempt("post", () =>
      this.opts.client.postMessage(this.opts.channelId, rec.content, {
        idempotencyKey: `${this.opts.idPrefix}-${key}`,
      }),
    );
    rec.posted = true;
    rec.failed = id === undefined;
    rec.messageId = id;
  }

  /**
   * Under backlog, the run of queued posts right behind `key` in the same
   * group (one step's tool messages) that still fit one message together.
   */
  private takeMergeable(key: string, rec: Rec): string[] {
    if (rec.group === undefined || this.queue.length < this.threshold) return [key];
    const members = [key];
    const parts = [{ content: rec.content, compact: rec.compact }];
    while (this.queue.length > 0) {
      const next = this.queue[0] as Entry;
      if (next.kind !== "post") break;
      const r = this.recs.get(next.key);
      if (r === undefined || r.group !== rec.group) break;
      const compactLen =
        parts.reduce((n, p) => n + (p.compact ?? p.content).length + 1, 0) +
        (r.compact ?? r.content).length;
      if (compactLen > DISCORD_MESSAGE_LIMIT) break;
      this.queue.shift();
      members.push(next.key);
      parts.push({ content: r.content, compact: r.compact });
    }
    return members;
  }

  private mergedContent(mergedId: string): string {
    const group = this.merged.get(mergedId);
    if (group === undefined) return "";
    const parts = group.keys.map((k) => {
      const r = this.recs.get(k);
      return { content: r?.content ?? "", compact: r?.compact };
    });
    return combineContents(parts);
  }

  private async edit(target: string): Promise<void> {
    this.pendingEdits.delete(target);
    const group = this.merged.get(target);
    const messageId = group !== undefined ? group.messageId : this.recs.get(target)?.messageId;
    if (messageId === undefined) return;
    const content =
      group !== undefined ? this.mergedContent(target) : (this.recs.get(target)?.content ?? "");
    await this.attempt("edit", () =>
      this.opts.client.editMessage(this.opts.channelId, messageId, content),
    );
  }

  /** Run `fn` with retry on retryable failures; `undefined` when it finally failed. */
  private async attempt<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 1; ; attempt++) {
      if (this.closed) return undefined;
      try {
        return await fn();
      } catch (err) {
        const fe = err instanceof FelicityError ? err : undefined;
        const retryable = fe === undefined || fe.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS || this.closed) {
          this.opts.logger.warn("discord op dropped", {
            op: what,
            channelId: this.opts.channelId,
            status: fe?.status ?? null,
            code: fe?.code ?? null,
            attempts: attempt,
          });
          return undefined;
        }
        const delay =
          fe?.retryAfterSec !== undefined
            ? fe.retryAfterSec * 1000
            : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
        await this.opts.clock.sleep(delay, this.abort.signal);
      }
    }
  }
}
