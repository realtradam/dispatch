/**
 * In-memory test doubles for the bridge's OUTER edges: the Felicity HTTP
 * API (a fake server-side client), and plain in-memory implementations of
 * the orchestrator / store contract slices the bridge consumes. No module
 * mocking — these are real implementations of the injected interfaces.
 */

import type { EnqueueInput, EnqueueResult } from "@dispatch/session-orchestrator";
import type {
  AgentEvent,
  ConversationMeta,
  StoredChunk,
  TurnMetrics,
  Workspace,
} from "@dispatch/wire";
import type { BridgeOrchestrator, BridgeStore } from "./bridge.js";
import {
  type BindInput,
  type BindResult,
  type Chat,
  type ChatEvent,
  type FelicityClient,
  FelicityError,
  type PollResult,
} from "./client.js";

export type FakeCall =
  | { op: "post"; channelId: string; content: string; idempotencyKey?: string; id: string }
  | { op: "edit"; channelId: string; messageId: string; content: string }
  | { op: "react"; channelId: string; messageId: string; emoji: string }
  | { op: "typing"; channelId: string; active: boolean }
  | { op: "bind"; cursor: number; input: BindInput }
  | { op: "reject"; cursor: number; reason: string; extra?: unknown }
  | { op: "disconnect"; threadId: string; reason: string }
  | { op: "ack"; cursor: number };

export class FakeFelicity implements FelicityClient {
  readonly calls: FakeCall[] = [];
  openChats: Chat[] = [];
  /** Failures to throw on the next N write calls (posts/edits/reactions). */
  readonly failures: FelicityError[] = [];
  bindResult: (cursor: number, input: BindInput) => BindResult = (cursor, input) => ({
    kind: "bound",
    chat: chat(`thread-${cursor}`, input.conversationId),
  });
  private nextId = 1000;
  private readonly batches: ChatEvent[][] = [];
  private waiter: (() => void) | undefined;
  polls = 0;

  /** Queue a batch of events for the next poll. */
  pushEvents(...events: ChatEvent[]): void {
    this.batches.push(events);
    this.waiter?.();
  }

  get posts(): Extract<FakeCall, { op: "post" }>[] {
    return this.calls.filter((c): c is Extract<FakeCall, { op: "post" }> => c.op === "post");
  }

  ops(kind: FakeCall["op"]): FakeCall[] {
    return this.calls.filter((c) => c.op === kind);
  }

  private failNext(): void {
    const f = this.failures.shift();
    if (f !== undefined) throw f;
  }

  async listOpenChats(): Promise<readonly Chat[]> {
    return this.openChats;
  }

  async pollEvents(
    after: number | undefined,
    _waitSec: number,
    signal: AbortSignal,
  ): Promise<PollResult> {
    this.polls += 1;
    if (this.batches.length === 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.waiter = undefined;
    }
    if (signal.aborted) throw new Error("aborted");
    const events = this.batches.shift() ?? [];
    const last = events[events.length - 1];
    return { events, nextCursor: last?.cursor ?? after ?? 0 };
  }

  async ack(cursor: number): Promise<void> {
    this.calls.push({ op: "ack", cursor });
  }

  async bind(cursor: number, input: BindInput): Promise<BindResult> {
    this.calls.push({ op: "bind", cursor, input });
    return this.bindResult(cursor, input);
  }

  async reject(cursor: number, reason: string, extra?: unknown): Promise<void> {
    this.calls.push({ op: "reject", cursor, reason, ...(extra !== undefined ? { extra } : {}) });
  }

  async disconnect(threadId: string, reason: string): Promise<void> {
    this.calls.push({ op: "disconnect", threadId, reason });
  }

  async postMessage(
    channelId: string,
    content: string,
    opts?: { readonly idempotencyKey?: string },
  ): Promise<string> {
    this.failNext();
    const id = String(this.nextId++);
    this.calls.push({
      op: "post",
      channelId,
      content,
      ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      id,
    });
    return id;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    this.failNext();
    this.calls.push({ op: "edit", channelId, messageId, content });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.failNext();
    this.calls.push({ op: "react", channelId, messageId, emoji });
  }

  async setTyping(channelId: string, active: boolean): Promise<void> {
    this.calls.push({ op: "typing", channelId, active });
  }
}

export function chat(threadId: string, conversationId: string | null): Chat {
  return {
    threadId,
    guildId: "g1",
    parentChannelId: "p1",
    status: "open",
    conversationId,
  };
}

/** A 5xx the sender should retry. */
export function serverError(): FelicityError {
  return new FelicityError(503, "discord_unavailable", "503");
}

/** In-memory orchestrator slice: subscribe/emit, enqueue (idle→start, active→queue), stop. */
export class FakeOrchestrator implements BridgeOrchestrator {
  readonly listeners = new Map<string, Set<(ev: AgentEvent) => void>>();
  readonly active = new Set<string>();
  readonly enqueued: EnqueueInput[] = [];
  readonly stopped: string[] = [];
  /** Events replayed synchronously to a new subscriber (the in-flight buffer). */
  readonly buffer = new Map<string, AgentEvent[]>();
  private nextMsg = 1;

  subscribe(conversationId: string, listener: (ev: AgentEvent) => void): () => void {
    for (const ev of this.buffer.get(conversationId) ?? []) listener(ev);
    let set = this.listeners.get(conversationId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  subscriberCount(conversationId: string): number {
    return this.listeners.get(conversationId)?.size ?? 0;
  }

  emit(ev: AgentEvent): void {
    for (const l of this.listeners.get(ev.conversationId) ?? []) l(ev);
  }

  isActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    this.enqueued.push(input);
    if (this.active.has(input.conversationId)) {
      const id = `q${this.nextMsg++}`;
      return {
        messageId: id,
        startedTurn: false,
        queue: [{ id, text: input.text, queuedAt: 0 }],
      };
    }
    this.active.add(input.conversationId);
    return { messageId: `q${this.nextMsg++}`, startedTurn: true, queue: [] };
  }

  stopTurn(conversationId: string): { readonly abortedTurn: boolean } {
    this.stopped.push(conversationId);
    const abortedTurn = this.active.delete(conversationId);
    return { abortedTurn };
  }
}

export function meta(id: string, title = `title ${id}`, extra: Partial<ConversationMeta> = {}) {
  return {
    id,
    createdAt: 0,
    lastActivityAt: 0,
    title,
    status: "idle",
    workspaceId: "default",
    ...extra,
  } satisfies ConversationMeta;
}

/** In-memory store slice. */
export class FakeStore implements BridgeStore {
  readonly metas = new Map<string, ConversationMeta>();
  readonly chunks = new Map<string, StoredChunk[]>();
  readonly metrics = new Map<string, TurnMetrics[]>();
  readonly cwds = new Map<string, string>();
  readonly workspaces = new Map<string, Workspace>();

  async loadSince(conversationId: string): Promise<readonly StoredChunk[]> {
    return this.chunks.get(conversationId) ?? [];
  }
  async loadMetrics(conversationId: string): Promise<readonly TurnMetrics[]> {
    return this.metrics.get(conversationId) ?? [];
  }
  async listConversations(): Promise<readonly ConversationMeta[]> {
    return [...this.metas.values()];
  }
  async getConversationMeta(conversationId: string): Promise<ConversationMeta | null> {
    return this.metas.get(conversationId) ?? null;
  }
  async getModel(conversationId: string): Promise<string | null> {
    return this.metas.get(conversationId)?.model ?? null;
  }
  async getCwd(conversationId: string): Promise<string | null> {
    return this.cwds.get(conversationId) ?? null;
  }
  async getWorkspace(id: string): Promise<Workspace | null> {
    return this.workspaces.get(id) ?? null;
  }
}
