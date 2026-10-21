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
  WorkspaceSetMessage,
  WsClientMessage,
} from "@dispatch/transport-contract";
import { parseConversationId } from "@dispatch/transport-contract";
import type { SurfaceCatalog, SurfaceServerMessage } from "@dispatch/ui-contract";

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
  readonly requestId?: string;
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
  readonly requestId?: string;
  readonly images?: ChatQueueMessage["images"];
  readonly computerId?: string;
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

/**
 * The effect a validated `workspace.set` should produce (plan 06 §6.4): the
 * shell records THIS connection's active workspace and RE-PUSHES the surface
 * catalog filtered to it. No reply is sent on an invalid payload — a
 * malformed `workspace.set` is a client bug, logged server-side (the shell
 * owns the log); the connection keeps its previous workspace.
 */
export interface WorkspaceSetRouteResult {
  readonly kind: "workspace-set";
  readonly workspaceId: string;
}

/**
 * The effect a malformed `workspace.set` should produce: NO reply, NO state
 * change — the shell logs the reason. Mirrors the fire-and-forget style of
 * the chat-queue results (there is no workspace-scoped error message type).
 */
export interface WorkspaceSetRouteError {
  readonly kind: "workspace-error";
  readonly errorMessage: string;
}

/** The effect any client WS message should produce. */
export type RouteResult =
  | SurfaceRouteResult
  | ChatRouteResult
  | ChatRouteError
  | ChatSubscribeRouteResult
  | ChatUnsubscribeRouteResult
  | ChatQueueRouteResult
  | ChatQueueCancelRouteResult
  | WorkspaceSetRouteResult
  | WorkspaceSetRouteError;

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

/**
 * Pure per-workspace catalog filter (plan 06 §6.4): omit surfaces whose
 * CONTRIBUTING plugin is not in the usable set. Entries WITHOUT a
 * `pluginId` are KEPT (fail-open — a runtime-loaded plugin compiled against
 * an older contract may omit the field; global loaded/unloaded state already
 * gates those elsewhere). Pure — the usable set is resolved by the caller
 * (the shell resolves it via the workspace-plugin-config service).
 */
export function filterCatalogForWorkspace(
  catalog: SurfaceCatalog,
  usablePluginIds: ReadonlySet<string>,
): SurfaceCatalog {
  return catalog.filter(
    (entry) => entry.pluginId === undefined || usablePluginIds.has(entry.pluginId),
  );
}

/**
 * Build the catalog message, optionally workspace-filtered. `usablePluginIds`
 * omitted → the unfiltered (global) catalog — the connect-time default and
 * the degrade path when no workspace context / config service exists.
 */
export function catalogMessageFiltered(
  registry: SurfaceRegistry,
  usablePluginIds: ReadonlySet<string> | undefined,
): SurfaceServerMessage {
  const catalog = registry.getCatalog();
  return {
    type: "catalog",
    catalog:
      usablePluginIds !== undefined ? filterCatalogForWorkspace(catalog, usablePluginIds) : catalog,
  };
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
  if (msg.type !== "workspace.set") {
    const optional = msg.type === "chat.send" || !msg.type.startsWith("chat.");
    if (msg.conversationId !== undefined || !optional) {
      const parsed = parseConversationId(msg.conversationId);
      if (typeof parsed !== "string") {
        if (msg.type === "subscribe" || msg.type === "unsubscribe" || msg.type === "invoke") {
          return {
            kind: "surface",
            replies: [{ type: "error", surfaceId: msg.surfaceId, message: parsed.error }],
          };
        }
        return {
          kind: "chat-error",
          conversationId: typeof msg.conversationId === "string" ? msg.conversationId : undefined,
          errorMessage: parsed.error,
        };
      }
    }
  }
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
    case "workspace.set":
      return handleWorkspaceSet(msg);
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

function parseImages(
  input: unknown,
  conversationId: string | undefined,
  operation: string,
): readonly { url: string; mimeType?: string }[] | ChatRouteError | undefined {
  let images: readonly { url: string; mimeType?: string }[] | undefined;
  if (input !== undefined) {
    if (!Array.isArray(input)) {
      return {
        kind: "chat-error",
        conversationId,
        errorMessage: `${operation}: 'images' must be an array`,
      };
    }
    const parsed: { url: string; mimeType?: string }[] = [];
    for (const entry of input) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.url !== "string" ||
        entry.url.length === 0
      ) {
        return {
          kind: "chat-error",
          conversationId,
          errorMessage: `${operation}: each image must have a non-empty string 'url'`,
        };
      }
      const p: { url: string; mimeType?: string } = { url: entry.url };
      if (entry.mimeType !== undefined) {
        if (typeof entry.mimeType !== "string")
          return {
            kind: "chat-error",
            conversationId,
            errorMessage: "image mimeType must be a string",
          };
        p.mimeType = entry.mimeType;
      }
      parsed.push(p);
    }
    if (parsed.length > 0) images = parsed;
  }
  return images;
}

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
  if (msg.requestId !== undefined && typeof msg.requestId !== "string") {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.send: requestId must be a string",
    };
  }
  const images = parseImages(msg.images, msg.conversationId, "chat.send");
  if (images !== undefined && "kind" in images) return images;
  return {
    kind: "chat",
    ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
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
 * Validate queue content: non-empty text or at least one image (images-only text
 * is the empty string). Invalid → `chat-error` (the shell replies with
 * `chat.error`, same style as a malformed `chat.send`; the orchestrator is never
 * called). Valid → `chat-queue` (the shell calls `orchestrator.enqueue`).
 */
function handleChatQueue(msg: ChatQueueMessage): ChatQueueRouteResult | ChatRouteError {
  if (msg.requestId !== undefined && typeof msg.requestId !== "string") {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.queue: requestId must be a string",
    };
  }
  const images = parseImages(msg.images, msg.conversationId, "chat.queue");
  if (images !== undefined && "kind" in images) return images;
  if (msg.computerId !== undefined && typeof msg.computerId !== "string") {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.queue: 'computerId' must be a string",
    };
  }
  if (typeof msg.text !== "string" || (!msg.text.trim() && !images?.length)) {
    return {
      kind: "chat-error",
      conversationId: msg.conversationId,
      errorMessage: "chat.queue requires a non-empty string `text` or images",
    };
  }
  return {
    kind: "chat-queue",
    ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
    conversationId: msg.conversationId,
    text: msg.text,
    ...(msg.workspaceId !== undefined ? { workspaceId: msg.workspaceId } : {}),
    ...(msg.computerId !== undefined ? { computerId: msg.computerId } : {}),
    ...(images !== undefined ? { images } : {}),
  };
}

/**
 * Validate a chat.queue.cancel: the router validates `conversationId`;
 * `messageId` must be a non-empty string. Invalid → `chat-error` (the shell replies with `chat.error`,
 * same style as a malformed `chat.queue`; the orchestrator is never called).
 * Valid → `chat-queue-cancel` (the shell calls `orchestrator.cancelQueuedMessage`).
 */
function handleChatQueueCancel(
  msg: ChatQueueCancelMessage,
): ChatQueueCancelRouteResult | ChatRouteError {
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

/**
 * Validate a `workspace.set` (plan 06 §6.4): `workspaceId` must be a
 * non-empty string. Invalid → `workspace-error` (the shell logs and sends
 * NOTHING — there is no workspace-scoped error message type); valid →
 * `workspace-set` (the shell records the connection's workspace and re-pushes
 * the filtered catalog).
 */
function handleWorkspaceSet(
  msg: WorkspaceSetMessage,
): WorkspaceSetRouteResult | WorkspaceSetRouteError {
  if (typeof msg.workspaceId !== "string" || msg.workspaceId.length === 0) {
    return {
      kind: "workspace-error",
      errorMessage: "workspace.set requires a non-empty string `workspaceId`",
    };
  }
  return { kind: "workspace-set", workspaceId: msg.workspaceId };
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
