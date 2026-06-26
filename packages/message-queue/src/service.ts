/**
 * Message-queue service — the typed handle the session-orchestrator obtains
 * (lazily) to enqueue / read / drain a conversation's steering queue.
 *
 * The queue is transient + per-conversation (in-memory, only meaningful during
 * generation). `drain` returns + clears AND pushes a surface update (empty).
 * The orchestrator owns the delivery (drain → combine → inject → carry-to-new-
 * turn); this service owns only the queue state, the surface, and the
 * drain-and-clear.
 */
import { defineService, type Logger, type ServiceHandle } from "@dispatch/kernel";
import type { QueuedMessage } from "@dispatch/wire";
import type { MessageQueueState, QueueDeps } from "./pure.js";
import { drain as drainQueue, enqueue as enqueueMessage, getQueue as readQueue } from "./pure.js";

/**
 * The message-queue service interface. Obtained via
 * `host.getService(messageQueueHandle)`.
 */
export interface MessageQueueService {
  /** Append a message; return the CURRENT queue snapshot (post-append). */
  enqueue(conversationId: string, text: string): QueuedMessage[];
  /** Current queue snapshot (empty array if none / unknown conversation). */
  getQueue(conversationId: string): QueuedMessage[];
  /**
   * Drain: return all queued messages, CLEAR the queue, and push a surface
   * update (empty). Returns the raw `QueuedMessage[]` (NOT a ChatMessage —
   * the caller combines + builds the ChatMessage). Empty array if the queue
   * was empty (and then NO surface update is pushed — no change).
   */
  drain(conversationId: string): QueuedMessage[];
}

/**
 * Typed handle anchoring the message-queue service. The single symbol the
 * session-orchestrator imports to reach the queue — no string-keyed lookup.
 */
export const messageQueueHandle: ServiceHandle<MessageQueueService> =
  defineService<MessageQueueService>("message-queue");

/** Deps for the service shell — the pure core's deps plus the surface notifier. */
export interface MessageQueueDeps extends QueueDeps {
  /**
   * Notify the surface-registry that the queue changed, so the transport
   * re-fetches + pushes a full new SurfaceUpdate. Called ONLY on a real
   * change (enqueue → grew; drain-non-empty → emptied); a no-op drain of an
   * already-empty queue does NOT notify (no change → no surface push).
   */
  readonly notify: () => void;
  /** Injected host logger (optional in tests). Logs counts/lengths at debug, never bodies. */
  readonly logger?: Logger;
}

/**
 * Create a MessageQueueService backed by an in-memory per-conversation Map.
 * Pure decision logic (enqueue/getQueue/drain) lives in ./pure.js; this shell
 * owns the state + the notify edge. State is owned (not ambient): the Map lives
 * in this closure, reachable only through the returned service.
 */
export function createMessageQueueService(deps: MessageQueueDeps): MessageQueueService {
  const state: MessageQueueState = new Map();

  return {
    enqueue(conversationId, text) {
      const snapshot = enqueueMessage(state, conversationId, text, deps);
      deps.logger?.debug("message-queue: enqueued", {
        conversationId,
        queueLen: snapshot.length,
        textLen: text.length,
      });
      deps.notify();
      return snapshot;
    },
    getQueue(conversationId) {
      return readQueue(state, conversationId);
    },
    drain(conversationId) {
      const drained = drainQueue(state, conversationId);
      if (drained.length === 0) return drained;
      deps.logger?.debug("message-queue: drained", {
        conversationId,
        count: drained.length,
      });
      deps.notify();
      return drained;
    },
  };
}
