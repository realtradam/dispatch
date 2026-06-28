/**
 * Pure core for message-queue — zero I/O, zero ambient state.
 *
 * Every function is input → output; testable without mocks. State is a plain
 * `Map<conversationId, QueuedMessage[]>` OWNED by the caller (the service
 * shell); the pure functions mutate it in place and return snapshots (fresh
 * array copies), so a caller can never reach into or mutate live state through
 * a returned value. The id factory + clock are injected (`QueueDeps`) so tests
 * are deterministic.
 */

import type { CustomField, SurfaceSpec } from "@dispatch/ui-contract";
import type { QueuedMessage, QueuePayload } from "@dispatch/wire";

/** The queue state: a per-conversation map of queued messages. */
export type MessageQueueState = Map<string, QueuedMessage[]>;

/** Injected effectful factories kept out of the pure core. */
export interface QueueDeps {
  /** Stable (client-visible) id factory for UI keying + dedup. */
  readonly id: () => string;
  /** Clock returning epoch-ms for `queuedAt`. */
  readonly now: () => number;
}

/** Surface id this extension contributes (also the manifest + catalog id). */
export const MESSAGE_QUEUE_SURFACE_ID = "message-queue";
/** The custom renderer id a frontend switches on to render the queue. */
export const MESSAGE_QUEUE_RENDERER_ID = "message-queue";

/**
 * Append a message to a conversation's queue. Mutates `state` and returns the
 * CURRENT snapshot (post-append) — a fresh array copy, so callers cannot mutate
 * live state through the returned value.
 */
export function enqueue(
  state: MessageQueueState,
  conversationId: string,
  text: string,
  deps: QueueDeps,
): QueuedMessage[] {
  const message: QueuedMessage = { id: deps.id(), text, queuedAt: deps.now() };
  const existing = state.get(conversationId);
  if (existing === undefined) {
    state.set(conversationId, [message]);
  } else {
    existing.push(message);
  }
  return getQueue(state, conversationId);
}

/**
 * Current queue snapshot for a conversation — a fresh array copy. Empty array
 * if the conversation has no queue / is unknown.
 */
export function getQueue(state: MessageQueueState, conversationId: string): QueuedMessage[] {
  const existing = state.get(conversationId);
  if (existing === undefined) return [];
  return [...existing];
}

/**
 * Drain: return all queued messages for a conversation and CLEAR its queue.
 * Returns a fresh array copy of the drained messages (empty array if the queue
 * was empty or unknown). The caller (session-orchestrator) combines these into
 * a steering ChatMessage; this returns the raw `QueuedMessage[]`, NOT a
 * ChatMessage.
 */
export function drain(state: MessageQueueState, conversationId: string): QueuedMessage[] {
  const existing = state.get(conversationId);
  if (existing === undefined || existing.length === 0) return [];
  const drained = [...existing];
  state.delete(conversationId);
  return drained;
}

/**
 * Cancel: remove a SINGLE queued message by id from a conversation's queue so
 * it never runs (never delivered as steering, never carried into a new turn).
 * Returns the post-cancel queue snapshot (a fresh array copy). Idempotent — if
 * no message with `messageId` exists in the conversation's queue (already
 * drained/delivered, never existed, unknown conversation) the queue is
 * unchanged and the returned snapshot simply does not contain it; the caller
 * distinguishes "removed" from "not found" via the `cancelWithFlag` helper
 * (this returns the snapshot only, like the other pure ops).
 *
 * The cancelled message is dropped entirely — it is NOT returned (the caller
 * does not need it; the surface re-renders from the snapshot). Mutates `state`
 * in place (splices the message out of the conversation's array).
 */
export function cancel(
  state: MessageQueueState,
  conversationId: string,
  messageId: string,
): QueuedMessage[] {
  const existing = state.get(conversationId);
  if (existing === undefined || existing.length === 0) {
    return getQueue(state, conversationId);
  }
  const idx = existing.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    return getQueue(state, conversationId);
  }
  existing.splice(idx, 1);
  // If the queue is now empty, drop the key so `getQueue` stays a clean empty
  // array (mirrors `drain` deleting the key on empty).
  if (existing.length === 0) {
    state.delete(conversationId);
  }
  return getQueue(state, conversationId);
}

/**
 * Combine drained messages' texts into a single steering string, joined by a
 * blank line (`\n\n`). Pure — the session-orchestrator builds the final
 * ChatMessage from this.
 */
export function combine(messages: readonly QueuedMessage[]): string {
  return messages.map((m) => m.text).join("\n\n");
}

/**
 * Build the per-conversation surface spec: a single `custom` field whose
 * payload is the current queue snapshot (`QueuePayload`). An empty `messages`
 * array (idle conversation / post-drain) renders as an empty list. Pure — no
 * I/O; the surface-registry re-fetches this on every notify.
 */
export function buildQueueSpec(messages: readonly QueuedMessage[]): SurfaceSpec {
  const payload: QueuePayload = { messages };
  const field: CustomField = {
    kind: "custom",
    rendererId: MESSAGE_QUEUE_RENDERER_ID,
    payload,
  };
  return {
    id: MESSAGE_QUEUE_SURFACE_ID,
    region: "side",
    title: "Message Queue",
    fields: [field],
  };
}
