/**
 * The Felicity agent-API client (contract 1.1, owned by Felicity:
 * `felicity/docs/agent-api.md`). Only the endpoints the bridge uses.
 *
 * `fetch` is injected (the outermost edge); the bearer token never appears in
 * a log line or an error message.
 */

// ─── Contract shapes ─────────────────────────────────────────────────────────

/** `data.author` on every event except a deletion-caused `chat.close`. */
export interface ChatAuthor {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly isOwner: boolean;
}

export interface ChatAttachment {
  readonly id: string;
  readonly filename: string;
  readonly url: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly isImage: boolean;
}

/** A Felicity chat: one Discord thread bound to one Dispatch conversation. */
export interface Chat {
  readonly threadId: string;
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly status: "open" | "closed";
  readonly conversationId: string | null;
  readonly title?: string | null;
  readonly model?: string | null;
  readonly cwd?: string | null;
  readonly url?: string;
}

interface EventBase {
  readonly cursor: number;
  readonly createdAt: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly conversationId: string | null;
  readonly sourceMessageId: string | null;
}

export interface ChatOpenEvent extends EventBase {
  readonly kind: "chat.open";
  readonly data: {
    readonly author: ChatAuthor;
    readonly conversationRef: string;
    readonly count: number;
    readonly requestedCount?: number;
    readonly clamped?: boolean;
  };
}

export interface ChatMessageEvent extends EventBase {
  readonly kind: "chat.message";
  readonly data: {
    readonly author: ChatAuthor;
    readonly content: string;
    readonly attachments: readonly ChatAttachment[];
    readonly replyTo: string | null;
  };
}

export interface ChatStopEvent extends EventBase {
  readonly kind: "chat.stop";
  readonly data: { readonly author: ChatAuthor };
}

export interface ChatCloseEvent extends EventBase {
  readonly kind: "chat.close";
  readonly data: { readonly reason: string; readonly author?: ChatAuthor };
}

/** The event-feed envelope (discriminated by `kind`). */
export type ChatEvent = ChatOpenEvent | ChatMessageEvent | ChatStopEvent | ChatCloseEvent;

export interface PollResult {
  readonly events: readonly ChatEvent[];
  readonly nextCursor: number;
}

export type RejectReason = "offline" | "not_found" | "ambiguous" | "unavailable" | "error";
export type DisconnectReason = "conversation_closed" | "conversation_unavailable" | "other";

export interface BindInput {
  readonly conversationId: string;
  readonly title?: string;
  readonly model?: string;
  readonly cwd?: string;
}

/** Outcome of binding a `chat.open` event. */
export type BindResult =
  | { readonly kind: "bound"; readonly chat: Chat }
  /** D23: already open elsewhere — Felicity replied with the link; drop the event. */
  | { readonly kind: "already-open"; readonly chat: Chat | null }
  /** Rejected / wrong kind / unknown / no permissions — Felicity has replied where relevant. */
  | { readonly kind: "unbindable"; readonly code: string };

/** What the bridge needs from Felicity. The REST client implements it. */
export interface FelicityClient {
  listOpenChats(signal?: AbortSignal): Promise<readonly Chat[]>;
  pollEvents(after: number | undefined, waitSec: number, signal: AbortSignal): Promise<PollResult>;
  ack(cursor: number): Promise<void>;
  bind(cursor: number, input: BindInput): Promise<BindResult>;
  reject(
    cursor: number,
    reason: RejectReason,
    extra?: {
      readonly candidates?: readonly { readonly id: string; readonly title: string }[];
      readonly detail?: string;
    },
  ): Promise<void>;
  disconnect(threadId: string, reason: DisconnectReason, detail?: string): Promise<void>;
  postMessage(
    channelId: string,
    content: string,
    opts?: { readonly idempotencyKey?: string; readonly suppressEmbeds?: boolean },
  ): Promise<string>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  setTyping(channelId: string, active: boolean, ttlMs?: number): Promise<void>;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** A non-2xx Felicity response (or a transport failure: `status` 0). */
export class FelicityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from `Retry-After`, when present. */
    readonly retryAfterSec?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "FelicityError";
  }

  /** Worth retrying: transport failure, 429 backlog, 5xx. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// ─── REST implementation ─────────────────────────────────────────────────────

export interface RestClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  /** Timeout for mutating calls (they wait in Felicity's pacing queue). Default 65 s. */
  readonly mutateTimeoutMs?: number;
}

type Json = Record<string, unknown>;

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Combine a caller signal with a timeout. */
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function createRestClient(opts: RestClientOptions): FelicityClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const mutateTimeout = opts.mutateTimeoutMs ?? 65_000;

  async function call(
    method: string,
    path: string,
    body: Json | undefined,
    signal: AbortSignal,
  ): Promise<{ status: number; json: Json }> {
    let res: Response;
    try {
      res = await opts.fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      if (signal.aborted && (signal.reason as Error | undefined)?.name !== "TimeoutError") {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new FelicityError(0, "network", `${method} ${path}: ${msg}`);
    }
    const text = res.status === 204 ? "" : await res.text();
    let json: Json = {};
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as Json;
      } catch {
        json = {};
      }
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json };
    const error = (json.error ?? {}) as { code?: unknown; message?: unknown };
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new FelicityError(
      res.status,
      typeof error.code === "string" ? error.code : `http_${res.status}`,
      `${method} ${path}: ${res.status} ${typeof error.message === "string" ? error.message : ""}`.trim(),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      json,
    );
  }

  const mutate = (method: string, path: string, body?: Json) =>
    call(method, path, body, withTimeout(mutateTimeout));

  return {
    async listOpenChats(signal) {
      const { json } = await call(
        "GET",
        "/v1/chats?status=open",
        undefined,
        withTimeout(30_000, signal),
      );
      return (json.chats ?? []) as Chat[];
    },
    async pollEvents(after, waitSec, signal) {
      const q = new URLSearchParams({ wait: String(waitSec), limit: "50" });
      if (after !== undefined) q.set("after", String(after));
      const { json } = await call(
        "GET",
        `/v1/chats/events?${q.toString()}`,
        undefined,
        withTimeout((waitSec + 15) * 1000, signal),
      );
      return {
        events: (json.events ?? []) as ChatEvent[],
        nextCursor: typeof json.nextCursor === "number" ? json.nextCursor : (after ?? 0),
      };
    },
    async ack(cursor) {
      await mutate("POST", "/v1/chats/events/ack", { cursor });
    },
    async bind(cursor, input) {
      try {
        const { json } = await mutate("POST", `/v1/chats/events/${cursor}/bind`, { ...input });
        return { kind: "bound", chat: json.chat as Chat };
      } catch (err) {
        if (err instanceof FelicityError && err.status === 409 && err.code === "already_open") {
          const chat = ((err.body as Json | undefined)?.chat ?? null) as Chat | null;
          return { kind: "already-open", chat };
        }
        if (err instanceof FelicityError && !err.retryable && err.status !== 401) {
          return { kind: "unbindable", code: err.code };
        }
        throw err;
      }
    },
    async reject(cursor, reason, extra) {
      await mutate("POST", `/v1/chats/events/${cursor}/reject`, { reason, ...extra });
    },
    async disconnect(threadId, reason, detail) {
      await mutate("POST", `/v1/chats/${enc(threadId)}/disconnect`, {
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    },
    async postMessage(channelId, content, o) {
      const { json } = await mutate("POST", `/v1/channels/${enc(channelId)}/messages`, {
        content,
        ...(o?.idempotencyKey !== undefined ? { idempotencyKey: o.idempotencyKey } : {}),
        ...(o?.suppressEmbeds !== undefined ? { suppressEmbeds: o.suppressEmbeds } : {}),
      });
      const messages = (json.messages ?? []) as { id: string }[];
      const last = messages[messages.length - 1];
      if (last === undefined)
        throw new FelicityError(502, "no_message", "post returned no message");
      return last.id;
    },
    async editMessage(channelId, messageId, content) {
      await mutate("PATCH", `/v1/channels/${enc(channelId)}/messages/${enc(messageId)}`, {
        content,
      });
    },
    async addReaction(channelId, messageId, emoji) {
      await mutate(
        "PUT",
        `/v1/channels/${enc(channelId)}/messages/${enc(messageId)}/reactions/${enc(emoji)}`,
      );
    },
    async setTyping(channelId, active, ttlMs) {
      await mutate("PUT", `/v1/channels/${enc(channelId)}/typing`, {
        active,
        ...(active && ttlMs !== undefined ? { ttlMs } : {}),
      });
    },
  };
}
