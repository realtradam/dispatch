/**
 * The bridge controller: long-polls Felicity's chat-event feed, routes each
 * event (open → resolve + bind + attach with replay; message → enqueue;
 * stop → stopTurn; close → detach), re-attaches to open chats on boot, and
 * disconnects relays whose conversation was closed or deleted in Dispatch.
 *
 * Every effect (Felicity client, orchestrator, store, clock, logger) is
 * injected; the bridge never creates conversations (D21).
 */

import type { ConversationStore } from "@dispatch/conversation-store";
import type { Logger } from "@dispatch/kernel";
import type { ImageInput } from "@dispatch/wire";
import {
  type Chat,
  type ChatAuthor,
  type ChatEvent,
  type ChatMessageEvent,
  type FelicityClient,
  FelicityError,
} from "./client.js";
import {
  REACT_STOPPED,
  Relay,
  type RelayDeps,
  type RelayOrchestrator,
  type RelayStore,
} from "./relay.js";
import { clampReplayCount } from "./replay.js";
import type { Clock } from "./sender.js";

/** Long-poll wait (seconds) — Felicity counts the bridge online within ~35 s of a poll. */
export const POLL_WAIT_SEC = 25;
/** Events older than this are never delivered late (D18). */
export const STALE_EVENT_MS = 60_000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_CANDIDATES = 10;
/** Minimum short-id prefix length (agent-management's rule). */
export const MIN_SHORT_ID_LEN = 4;

export type BridgeOrchestrator = RelayOrchestrator & {
  readonly stopTurn: (conversationId: string) => { readonly abortedTurn: boolean };
};
export type BridgeStore = RelayStore &
  Pick<
    ConversationStore,
    "listConversations" | "getConversationMeta" | "getModel" | "getCwd" | "getWorkspace"
  >;

export interface BridgeDeps {
  readonly client: FelicityClient;
  readonly orchestrator: BridgeOrchestrator;
  readonly store: BridgeStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Unique attachment ids (idempotency-key prefixes). */
  readonly newId: () => string;
  readonly relaySender?: RelayDeps["sender"];
}

export type ConversationRefResolution =
  | { readonly kind: "unique"; readonly id: string }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

/**
 * Resolve a conversation reference: an exact id, else a ≥ 4-character
 * prefix (the agent-management short-id rule, duplicated per isolation-over-DRY).
 */
export function resolveConversationRef(
  ids: readonly string[],
  ref: string,
): ConversationRefResolution {
  const r = ref.trim();
  if (ids.includes(r)) return { kind: "unique", id: r };
  if (r.length < MIN_SHORT_ID_LEN) return { kind: "none" };
  const matched = ids.filter((id) => id.startsWith(r));
  if (matched.length === 0) return { kind: "none" };
  if (matched.length === 1) return { kind: "unique", id: matched[0] as string };
  return { kind: "ambiguous", candidates: matched };
}

/** `[Discord: Alice (@alice, 111)]` — the attribution line for a non-owner participant. */
export function attributionLine(author: ChatAuthor): string {
  return `[Discord: ${author.displayName} (@${author.username}, ${author.id})]`;
}

/**
 * A `chat.message` → the prompt text + images. Image attachments become
 * `ImageInput`s (Discord CDN URLs); other attachments become text links.
 * Non-owner participants get an attribution line (their content is untrusted).
 */
export function promptFromMessage(ev: ChatMessageEvent): {
  readonly text: string;
  readonly images: readonly ImageInput[];
} {
  const images: ImageInput[] = [];
  const links: string[] = [];
  for (const a of ev.data.attachments) {
    if (a.isImage) {
      images.push(
        a.contentType !== null ? { url: a.url, mimeType: a.contentType } : { url: a.url },
      );
    } else {
      links.push(`[attachment: ${a.filename}](${a.url})`);
    }
  }
  const body = [ev.data.content, ...links].filter((s) => s.length > 0).join("\n");
  const text = ev.data.author.isOwner ? body : `${attributionLine(ev.data.author)}\n${body}`;
  return { text, images };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Bridge {
  private readonly relays = new Map<string, Relay>();
  private readonly abort = new AbortController();
  private loopDone: Promise<void> = Promise.resolve();
  private lastCursor = 0;

  constructor(private readonly deps: BridgeDeps) {}

  /** Start the re-attach + long-poll loop (returns immediately). */
  start(): void {
    this.loopDone = this.loop();
  }

  /** Stop polling, detach every relay (unsubscribe, release typing). */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loopDone;
    const relays = [...this.relays.values()];
    this.relays.clear();
    await Promise.all(relays.map((r) => r.stop()));
  }

  /** Threads currently relayed (for tests / diagnostics). */
  relayFor(threadId: string): Relay | undefined {
    return this.relays.get(threadId);
  }

  get relayCount(): number {
    return this.relays.size;
  }

  /** The Dispatch tab was closed: end the relay and tell Felicity (D24). */
  onConversationClosed(conversationId: string): Promise<void> {
    return this.disconnectConversation(conversationId, "conversation_closed");
  }

  /** The conversation was deleted: it is no longer available (§3.1a). */
  onConversationDeleted(conversationId: string): Promise<void> {
    return this.disconnectConversation(conversationId, "conversation_unavailable");
  }

  // ── loop ────────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    let backoff = MIN_BACKOFF_MS;
    let attached = false;
    let after: number | undefined;
    while (!signal.aborted) {
      try {
        if (!attached) {
          await this.reattach(signal);
          attached = true;
          if (signal.aborted) return;
        }
        const res = await this.deps.client.pollEvents(after, POLL_WAIT_SEC, signal);
        backoff = MIN_BACKOFF_MS;
        for (const ev of res.events) {
          if (signal.aborted) return;
          if (ev.cursor <= this.lastCursor) continue; // at-least-once: dedupe
          await this.handleEvent(ev);
          this.lastCursor = ev.cursor;
        }
        after = res.nextCursor;
        if (res.events.length > 0 && !signal.aborted) {
          await this.deps.client.ack(res.nextCursor).catch((err: unknown) => {
            this.deps.logger.warn("chat event ack failed", { error: errText(err) });
          });
        }
      } catch (err) {
        if (signal.aborted) return;
        this.deps.logger.warn("felicity poll failed; backing off", {
          error: errText(err),
          status: err instanceof FelicityError ? err.status : null,
          backoffMs: backoff,
        });
        await this.deps.clock.sleep(backoff, signal);
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      }
    }
  }

  /** Re-attach to Felicity's open chats; disconnect the ones whose conversation is gone. */
  private async reattach(signal: AbortSignal): Promise<void> {
    const chats = await this.deps.client.listOpenChats(signal);
    const open = new Set(chats.map((c) => c.threadId));
    for (const [threadId, relay] of this.relays) {
      if (!open.has(threadId)) {
        this.relays.delete(threadId);
        await relay.stop();
      }
    }
    for (const chat of chats) {
      if (signal.aborted) return;
      if (chat.conversationId === null || this.relays.has(chat.threadId)) continue;
      await this.attachExisting(chat.threadId, chat.conversationId);
    }
    this.deps.logger.info("discord bridge attached", { openChats: chats.length });
  }

  /** Attach (no replay) to a chat Felicity already has, or disconnect it when unavailable. */
  private async attachExisting(threadId: string, conversationId: string): Promise<void> {
    const meta = await this.deps.store.getConversationMeta(conversationId).catch(() => null);
    if (meta === null) {
      await this.deps.client
        .disconnect(threadId, "conversation_unavailable")
        .catch((err: unknown) =>
          this.deps.logger.warn("disconnect failed", { threadId, error: errText(err) }),
        );
      return;
    }
    await this.attach(threadId, conversationId);
  }

  private async attach(
    threadId: string,
    conversationId: string,
    replay?: { readonly count: number; readonly requestedCount?: number },
  ): Promise<Relay> {
    const existing = this.relays.get(threadId);
    if (existing !== undefined) await existing.stop();
    const relay = new Relay({
      threadId,
      conversationId,
      orchestrator: this.deps.orchestrator,
      store: this.deps.store,
      client: this.deps.client,
      clock: this.deps.clock,
      logger: this.deps.logger,
      idPrefix: `dsp-${threadId}-${this.deps.newId()}`,
      ...(this.deps.relaySender !== undefined ? { sender: this.deps.relaySender } : {}),
    });
    this.relays.set(threadId, relay);
    try {
      await relay.start(replay);
    } catch (err) {
      this.deps.logger.warn("relay history load failed; relaying live only", {
        threadId,
        conversationId,
        error: errText(err),
      });
    }
    return relay;
  }

  private async disconnectConversation(
    conversationId: string,
    reason: "conversation_closed" | "conversation_unavailable",
  ): Promise<void> {
    for (const [threadId, relay] of [...this.relays]) {
      if (relay.conversationId !== conversationId) continue;
      this.relays.delete(threadId);
      await relay.stop();
      await this.deps.client
        .disconnect(threadId, reason)
        .catch((err: unknown) =>
          this.deps.logger.warn("disconnect failed", { threadId, reason, error: errText(err) }),
        );
      this.deps.logger.info("relay disconnected", { threadId, conversationId, reason });
    }
  }

  // ── events ──────────────────────────────────────────────────────────────

  /** Route one chat event. Never throws (failures are logged / rejected). */
  async handleEvent(ev: ChatEvent): Promise<void> {
    try {
      if (ev.kind !== "chat.close" && this.isStale(ev)) {
        this.deps.logger.info("stale chat event rejected", { cursor: ev.cursor, kind: ev.kind });
        await this.deps.client.reject(ev.cursor, "offline");
        return;
      }
      switch (ev.kind) {
        case "chat.open":
          await this.onOpen(ev);
          return;
        case "chat.message":
          await this.onMessage(ev);
          return;
        case "chat.stop":
          await this.onStop(ev);
          return;
        case "chat.close":
          await this.onClose(ev);
          return;
      }
    } catch (err) {
      this.deps.logger.warn("chat event failed", {
        cursor: ev.cursor,
        kind: ev.kind,
        error: errText(err),
      });
      if (ev.kind !== "chat.close") {
        await this.deps.client
          .reject(ev.cursor, "error", { detail: errText(err).slice(0, 300) })
          .catch(() => {});
      }
    }
  }

  private isStale(ev: ChatEvent): boolean {
    const at = Date.parse(ev.createdAt);
    return Number.isFinite(at) && this.deps.clock.now() - at > STALE_EVENT_MS;
  }

  private async onOpen(ev: Extract<ChatEvent, { kind: "chat.open" }>): Promise<void> {
    const ref = ev.data.conversationRef;
    const metas = await this.deps.store.listConversations();
    const resolution = resolveConversationRef(
      metas.map((m) => m.id),
      ref,
    );
    if (resolution.kind === "none") {
      await this.deps.client.reject(ev.cursor, "not_found");
      return;
    }
    if (resolution.kind === "ambiguous") {
      const titles = new Map(metas.map((m) => [m.id, m.title]));
      await this.deps.client.reject(ev.cursor, "ambiguous", {
        candidates: resolution.candidates
          .slice(0, MAX_CANDIDATES)
          .map((id) => ({ id, title: titles.get(id) ?? "" })),
      });
      return;
    }
    const conversationId = resolution.id;
    const meta = await this.deps.store.getConversationMeta(conversationId);
    if (meta === null) {
      await this.deps.client.reject(ev.cursor, "unavailable");
      return;
    }
    const model = meta.model ?? (await this.deps.store.getModel(conversationId)) ?? undefined;
    let cwd = (await this.deps.store.getCwd(conversationId)) ?? undefined;
    if (cwd === undefined) {
      const ws = await this.deps.store.getWorkspace(meta.workspaceId).catch(() => null);
      cwd = ws?.defaultCwd ?? undefined;
    }
    const bound = await this.deps.client.bind(ev.cursor, {
      conversationId,
      ...(meta.title.length > 0 ? { title: meta.title.slice(0, 200) } : {}),
      ...(model !== undefined ? { model: model.slice(0, 200) } : {}),
      ...(cwd !== undefined ? { cwd: cwd.slice(0, 1000) } : {}),
    });
    if (bound.kind !== "bound") {
      this.deps.logger.info("chat open not bound", {
        cursor: ev.cursor,
        conversationId,
        outcome: bound.kind,
        code: bound.kind === "unbindable" ? bound.code : null,
      });
      return;
    }
    const chat: Chat = bound.chat;
    if (this.relays.get(chat.threadId)?.conversationId === conversationId) return; // retry
    await this.attach(chat.threadId, conversationId, {
      count: clampReplayCount(ev.data.count),
      ...(ev.data.requestedCount !== undefined ? { requestedCount: ev.data.requestedCount } : {}),
    });
    this.deps.logger.info("chat opened", { threadId: chat.threadId, conversationId });
  }

  /** The relay for an event's thread, attaching on demand (no replay) if needed. */
  private async relayForEvent(ev: ChatEvent): Promise<Relay | undefined> {
    if (ev.threadId === null) return undefined;
    const existing = this.relays.get(ev.threadId);
    if (existing !== undefined) return existing;
    if (ev.conversationId === null) return undefined;
    await this.attachExisting(ev.threadId, ev.conversationId);
    return this.relays.get(ev.threadId);
  }

  private async onMessage(ev: ChatMessageEvent): Promise<void> {
    const relay = await this.relayForEvent(ev);
    if (relay === undefined) {
      await this.deps.client.reject(ev.cursor, "unavailable");
      return;
    }
    const prompt = promptFromMessage(ev);
    if (prompt.text.trim().length === 0 && prompt.images.length === 0) return;
    await relay.submit({ ...prompt, sourceMessageId: ev.sourceMessageId });
  }

  private async onStop(ev: Extract<ChatEvent, { kind: "chat.stop" }>): Promise<void> {
    const relay = await this.relayForEvent(ev);
    if (relay === undefined) {
      await this.deps.client.reject(ev.cursor, "unavailable");
      return;
    }
    const { abortedTurn } = this.deps.orchestrator.stopTurn(relay.conversationId);
    if (abortedTurn && ev.sourceMessageId !== null) relay.react(ev.sourceMessageId, REACT_STOPPED);
  }

  private async onClose(ev: Extract<ChatEvent, { kind: "chat.close" }>): Promise<void> {
    if (ev.threadId === null) return;
    const relay = this.relays.get(ev.threadId);
    if (relay === undefined) return;
    this.relays.delete(ev.threadId);
    await relay.stop();
    this.deps.logger.info("relay closed from discord", {
      threadId: ev.threadId,
      reason: ev.data.reason,
    });
  }
}
