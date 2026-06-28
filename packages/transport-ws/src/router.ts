/**
 * Pure core — routes a client WS message into an effect description.
 *
 * Zero I/O, zero ambient state. Every function is `input → output`:
 * it decides what to do but does NOT do it. The shell (extension.ts)
 * interprets the result: sends WS messages, mutates connSubs, calls
 * provider.invoke, drives the orchestrator.
 */

import type { SurfaceContext, SurfaceRegistry } from "@dispatch/surface-registry";
import type {
  ChatQueueCancelMessage,
  ChatQueueMessage,
  ChatSendMessage,
  ChatSubscribeMessage,
  ChatUnsubscribeMessage,
  ReasoningEffort,
  WsClientMessage,
} from "@dispatch/transport-contract";
import type { SurfaceServerMessage } from "@dispatch/ui-contract";

// ── Result types ────────────────────────────────────────────────────────────

/** The effect a surface client message should produce. */
export interface SurfaceRouteResult {
  readonly kind: "surface";
  /** Server messages to send back to this connection. */
  readonly replies: readonly SurfaceServerMessage[];
  /** Whether to add or remove the surface id from connSubs. */
  readonly subChange?: {
    readonly op: "add" | "remove";
    readonly surfaceId: string;
    readonly conversationId?: string;
  };
  /** If set, the shell must call `provider.invoke(actionId, payload, context)`. */
  readonly invoke?: {
    readonly surfaceId: string;
    readonly actionId: string;
    readonly payload?: unknown;
    readonly conversationId?: string;
  };
}

/** The effect a validated chat.send should produce. */
export interface ChatRouteResult {
  readonly kind: "chat";
  readonly conversationId: string | undefined;
  readonly message: string;
  readonly model: string | undefined;
  readonly cwd: string | undefined;
  readonly reasoningEffort?: ReasoningEffort;
  readonly workspaceId?: string;
  /**
   * The computer (SSH config alias) to run this turn's tools on — forwarded
   * verbatim to the orchestrator's `startTurn` (which resolves it via
   * `getEffectiveComputer`). Mirrors `cwd`/`workspaceId`: an opaque per-turn
   * override, unvalidated here (validation happens at SSH connect time).
   * Absent when the client omits it (the orchestrator then inherits the
   * conversation → workspace → local chain).
   */
  readonly computerId?: string;
  /**
   * Images attached to this turn (data URLs or http URLs), forwarded verbatim to
   * the orchestrator. Absent when the client omits it. Each entry must have a
   * non-empty string `url`; `mimeType` is optional.
   */
  readonly images?: readonly { readonly url: string; readonly mimeType?: string }[];
}

/** A malformed chat.send that should yield a chat.error reply. */
export interface ChatRouteError {
  readonly kind: "chat-error";
  readonly conversationId: string | undefined;
  readonly errorMessage: string;
}

/** The effect a chat.subscribe should produce. */
export interface ChatSubscribeRouteResult {
  readonly kind: "chat-subscribe";
  readonly conversationId: string;
}

/** The effect a chat.unsubscribe should produce. */
export interface ChatUnsubscribeRouteResult {
  readonly kind: "chat-unsubscribe";
  readonly conversationId: string;
}

/**
 * The effect a validated chat.queue should produce. The shell calls
 * `orchestrator.enqueue({ conversationId, text })` and emits NOTHING back on
 * either path (fire-and-forget): success is confirmed by the message-queue
 * SURFACE updating (startedTurn:false) or by streaming chat.deltas
 * (startedTurn:true — the shell auto-subscribes the sender, same as chat.send).
 */
export interface ChatQueueRouteResult {
  readonly kind: "chat-queue";
  readonly conversationId: string;
  readonly text: string;
  readonly workspaceId?: string;
}

/**
 * The effect a validated chat.queue.cancel should produce. The shell calls
 * `orchestrator.cancelQueuedMessage({ conversationId, messageId })` and emits
 * NOTHING back (fire-and-forget): success is confirmed by the message-queue
 * SURFACE updating (the cancelled message leaves the snapshot). Cancelling a
 * message that is no longer queued is a silent no-op (no surface update, no
 * error). Mirrors `ChatQueueRouteResult`'s fire-and-forget style.
 */
export interface ChatQueueCancelRouteResult {
  readonly kind: "chat-queue-cancel";
  readonly conversationId: string;
  readonly messageId: string;
}

/** The effect any client WS message should produce. */
export type RouteResult =
  | SurfaceRouteResult
  | ChatRouteResult
  | ChatRouteError
  | ChatSubscribeRouteResult
  | ChatUnsubscribeRouteResult
  | ChatQueueRouteResult
  | ChatQueueCancelRouteResult;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a subscription key from a surface id and optional conversation id.
 * The shell uses this same function so both layers agree on key format.
 */
export function subKey(surfaceId: string, conversationId?: string): string {
  return conversationId !== undefined ? `${surfaceId}::${conversationId}` : `${surfaceId}::`;
}

/** Build the catalog `SurfaceServerMessage` from the registry. */
export function catalogMessage(registry: SurfaceRegistry): SurfaceServerMessage {
  return { type: "catalog", catalog: registry.getCatalog() };
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Route a single client message into a pure effect description.
 *
 * @param registry  The surface registry (looked up once, injected).
 * @param connSubs  This connection's current subscription keys (via `subKey`).
 * @param msg       The parsed client message (surface or chat).
 */
export function routeClientMessage(
  registry: SurfaceRegistry,
  connSubs: ReadonlySet<string>,
  msg: WsClientMessage,
): RouteResult {
  switch (msg.type) {
    case "subscribe":
      return handleSubscribe(registry, connSubs, msg.surfaceId, msg.conversationId);
    case "unsubscribe":
      return handleUnsubscribe(msg.surfaceId, msg.conversationId);
    case "invoke":
      return handleInvoke(registry, msg.surfaceId, msg.actionId, msg.payload, msg.conversationId);
    case "chat.send":
      return handleChatSend(msg);
    case "chat.subscribe":
      return handleChatSubscribe(msg);
    case "chat.unsubscribe":
      return handleChatUnsubscribe(msg);
    case "chat.queue":
      return handleChatQueue(msg);
    case "chat.queue.cancel":
      return handleChatQueueCancel(msg);
  }
}

// ── Chat validation ─────────────────────────────────────────────────────────

const VALID_REASONING_EFFORT: ReadonlySet<string> = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function handleChatSend(msg: ChatSendMessage): ChatRouteResult | ChatRouteError {
  if (typeof msg.message !== "string" || msg.message.length === 0) {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.send requires a non-empty string `message`",
    };
  }
  if (msg.reasoningEffort !== undefined && !VALID_REASONING_EFFORT.has(msg.reasoningEffort)) {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: `chat.send: invalid reasoningEffort "${msg.reasoningEffort}" — must be one of: low, medium, high, xhigh, max`,
    };
  }
  // Validate images (if present): each must be an object with a non-empty url.
  let images: readonly { url: string; mimeType?: string }[] | undefined;
  if (msg.images !== undefined) {
    if (!Array.isArray(msg.images)) {
      return {
        kind: "chat-error",
        conversationId: msg.conversationId,
        errorMessage: "chat.send: 'images' must be an array",
      };
    }
    const parsed: { url: string; mimeType?: string }[] = [];
    for (const entry of msg.images) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.url !== "string" ||
        entry.url.length === 0
      ) {
        return {
          kind: "chat-error",
          conversationId: msg.conversationId,
          errorMessage: "chat.send: each image must have a non-empty string 'url'",
        };
      }
      const p: { url: string; mimeType?: string } = { url: entry.url };
      if (entry.mimeType !== undefined) p.mimeType = entry.mimeType;
      parsed.push(p);
    }
    if (parsed.length > 0) images = parsed;
  }
  return {
    kind: "chat",
    conversationId: msg.conversationId,
    message: msg.message,
    model: msg.model,
    cwd: msg.cwd,
    ...(msg.reasoningEffort !== undefined ? { reasoningEffort: msg.reasoningEffort } : {}),
    ...(msg.workspaceId !== undefined ? { workspaceId: msg.workspaceId } : {}),
    ...(msg.computerId !== undefined ? { computerId: msg.computerId } : {}),
    ...(images !== undefined ? { images } : {}),
  };
}

function handleChatSubscribe(msg: ChatSubscribeMessage): ChatSubscribeRouteResult {
  return { kind: "chat-subscribe", conversationId: msg.conversationId };
}

function handleChatUnsubscribe(msg: ChatUnsubscribeMessage): ChatUnsubscribeRouteResult {
  return { kind: "chat-unsubscribe", conversationId: msg.conversationId };
}

/**
 * Validate a chat.queue: `text` must be a non-empty string AFTER TRIM (matches
 * the HTTP `QueueRequest` rule). Invalid → `chat-error` (the shell replies with
 * `chat.error`, same style as a malformed `chat.send`; the orchestrator is never
 * called). Valid → `chat-queue` (the shell calls `orchestrator.enqueue`).
 */
function handleChatQueue(msg: ChatQueueMessage): ChatQueueRouteResult | ChatRouteError {
  if (typeof msg.text !== "string" || msg.text.trim().length === 0) {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.queue requires a non-empty string `text`",
    };
  }
  return {
    kind: "chat-queue",
    conversationId: msg.conversationId,
    text: msg.text,
    ...(msg.workspaceId !== undefined ? { workspaceId: msg.workspaceId } : {}),
  };
}

/**
 * Validate a chat.queue.cancel: both `conversationId` and `messageId` must be
 * non-empty strings. Invalid → `chat-error` (the shell replies with `chat.error`,
 * same style as a malformed `chat.queue`; the orchestrator is never called).
 * Valid → `chat-queue-cancel` (the shell calls `orchestrator.cancelQueuedMessage`).
 */
function handleChatQueueCancel(
  msg: ChatQueueCancelMessage,
): ChatQueueCancelRouteResult | ChatRouteError {
  if (typeof msg.conversationId !== "string" || msg.conversationId.length === 0) {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.queue.cancel requires a non-empty string `conversationId`",
    };
  }
  if (typeof msg.messageId !== "string" || msg.messageId.length === 0) {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.queue.cancel requires a non-empty string `messageId`",
    };
  }
  return {
    kind: "chat-queue-cancel",
    conversationId: msg.conversationId,
    messageId: msg.messageId,
  };
}

// ── Per-message handlers ────────────────────────────────────────────────────

function handleSubscribe(
  registry: SurfaceRegistry,
  connSubs: ReadonlySet<string>,
  surfaceId: string,
  conversationId?: string,
): SurfaceRouteResult {
  const provider = registry.getSurface(surfaceId);
  if (!provider) {
    return {
      kind: "surface",
      replies: [{ type: "error", surfaceId, message: `Unknown surface: ${surfaceId}` }],
    };
  }

  const context: SurfaceContext | undefined =
    conversationId !== undefined ? { conversationId } : undefined;
  const spec = provider.getSpec(context);

  // getSpec may be sync or async — the pure core treats it as a value the
  // shell will resolve. We return the spec directly (it's a SurfaceSpec).
  // If it's a Promise the shell awaits it; if it's sync it's already the value.
  // For the pure core we just pass it through — the shell handles the resolution.
  const specValue = spec as import("@dispatch/ui-contract").SurfaceSpec;

  const replies: import("@dispatch/ui-contract").SurfaceServerMessage[] = [
    {
      type: "surface",
      spec: specValue,
      ...(conversationId !== undefined ? { conversationId } : {}),
    },
  ];

  // Idempotent: only emit subChange if not already subscribed.
  const key = subKey(surfaceId, conversationId);
  if (!connSubs.has(key)) {
    return {
      kind: "surface",
      replies,
      subChange: {
        op: "add",
        surfaceId,
        ...(conversationId !== undefined ? { conversationId } : {}),
      },
    };
  }
  return { kind: "surface", replies };
}

function handleUnsubscribe(surfaceId: string, conversationId?: string): SurfaceRouteResult {
  return {
    kind: "surface",
    replies: [],
    subChange: {
      op: "remove",
      surfaceId,
      ...(conversationId !== undefined ? { conversationId } : {}),
    },
  };
}

function handleInvoke(
  registry: SurfaceRegistry,
  surfaceId: string,
  actionId: string,
  payload?: unknown,
  conversationId?: string,
): SurfaceRouteResult {
  const provider = registry.getSurface(surfaceId);
  if (!provider) {
    return {
      kind: "surface",
      replies: [{ type: "error", surfaceId, message: `Unknown surface: ${surfaceId}` }],
    };
  }
  return {
    kind: "surface",
    replies: [],
    invoke: {
      surfaceId,
      actionId,
      payload,
      ...(conversationId !== undefined ? { conversationId } : {}),
    },
  };
}
