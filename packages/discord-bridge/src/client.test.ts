import { describe, expect, it } from "vitest";
import { createRestClient, FelicityError } from "./client.js";

const TOKEN = "tok-secret-0123456789abcdef";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake Felicity HTTP edge: routes → canned responses, recording every request. */
function fakeFetch(
  respond: (req: Seen) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const r = respond(req);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      ...(r.headers !== undefined ? { headers: r.headers } : {}),
    });
  }) as typeof fetch;
  return { f, seen };
}

const client = (f: typeof fetch) =>
  createRestClient({ baseUrl: "http://felicity:27431/", token: TOKEN, fetch: f });

describe("Felicity REST client (contract 1.1)", () => {
  it("authenticates and hits the contract paths", async () => {
    const { f, seen } = fakeFetch((req) => {
      if (req.url.includes("/messages") && req.method === "POST") {
        return { status: 201, body: { messages: [{ id: "1001", url: "u" }], replayed: false } };
      }
      if (req.url.includes("/v1/chats?status=open")) {
        return { status: 200, body: { chats: [{ threadId: "9", conversationId: "c" }] } };
      }
      if (req.url.includes("/v1/chats/events?")) {
        return { status: 200, body: { events: [], nextCursor: 5, ackedCursor: 5 } };
      }
      return {
        status: req.method === "PUT" && req.url.includes("reactions") ? 204 : 200,
        body: {},
      };
    });
    const c = client(f);
    expect(await c.listOpenChats()).toEqual([{ threadId: "9", conversationId: "c" }]);
    expect(await c.pollEvents(5, 25, new AbortController().signal)).toEqual({
      events: [],
      nextCursor: 5,
    });
    expect(await c.postMessage("9", "hi", { idempotencyKey: "dsp-9-a-m1" })).toBe("1001");
    await c.editMessage("9", "1001", "hi!");
    await c.addReaction("9", "1001", "✅");
    await c.setTyping("9", true, 30_000);
    await c.setTyping("9", false);
    await c.ack(5);
    await c.reject(7, "ambiguous", { candidates: [{ id: "a", title: "t" }] });
    await c.disconnect("9", "conversation_closed");

    expect(seen.map((s) => `${s.method} ${s.url.replace("http://felicity:27431", "")}`)).toEqual([
      "GET /v1/chats?status=open",
      "GET /v1/chats/events?wait=25&limit=50&after=5",
      "POST /v1/channels/9/messages",
      "PATCH /v1/channels/9/messages/1001",
      "PUT /v1/channels/9/messages/1001/reactions/%E2%9C%85",
      "PUT /v1/channels/9/typing",
      "PUT /v1/channels/9/typing",
      "POST /v1/chats/events/ack",
      "POST /v1/chats/events/7/reject",
      "POST /v1/chats/9/disconnect",
    ]);
    for (const s of seen) expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[2]?.body).toEqual({ content: "hi", idempotencyKey: "dsp-9-a-m1" });
    expect(seen[5]?.body).toEqual({ active: true, ttlMs: 30_000 });
    expect(seen[6]?.body).toEqual({ active: false });
    expect(seen[8]?.body).toEqual({ reason: "ambiguous", candidates: [{ id: "a", title: "t" }] });
  });

  it("bind: 201 bound, 409 already_open (D23), other 4xx unbindable, 5xx throws", async () => {
    const chat = { threadId: "9", conversationId: "c" };
    let status = 201;
    let body: unknown = { chat };
    const { f, seen } = fakeFetch(() => ({ status, body }));
    const c = client(f);
    expect(await c.bind(3, { conversationId: "c", title: "T" })).toEqual({ kind: "bound", chat });
    expect(seen[0]?.url).toBe("http://felicity:27431/v1/chats/events/3/bind");
    expect(seen[0]?.body).toEqual({ conversationId: "c", title: "T" });

    status = 409;
    body = { error: { code: "already_open", message: "open" }, chat };
    expect(await c.bind(3, { conversationId: "c" })).toEqual({ kind: "already-open", chat });

    body = { error: { code: "event_resolved", message: "x" } };
    expect(await c.bind(3, { conversationId: "c" })).toEqual({
      kind: "unbindable",
      code: "event_resolved",
    });

    status = 503;
    body = { error: { code: "discord_unavailable", message: "not ready" } };
    await expect(c.bind(3, { conversationId: "c" })).rejects.toBeInstanceOf(FelicityError);
  });

  it("errors carry status/code/Retry-After and never the token", async () => {
    const { f } = fakeFetch(() => ({
      status: 429,
      body: { error: { code: "backlogged", message: "queue full" } },
      headers: { "retry-after": "4" },
    }));
    const err = await client(f)
      .postMessage("9", "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FelicityError);
    const fe = err as FelicityError;
    expect([fe.status, fe.code, fe.retryAfterSec, fe.retryable]).toEqual([
      429,
      "backlogged",
      4,
      true,
    ]);
    expect(fe.message).not.toContain(TOKEN);
    const notRetryable = new FelicityError(403, "missing_permissions", "no");
    expect(notRetryable.retryable).toBe(false);
  });

  it("transport failures become retryable status-0 errors; caller aborts propagate", async () => {
    const failing = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = (await client(failing)
      .ack(1)
      .catch((e: unknown) => e)) as FelicityError;
    expect([err.status, err.code, err.retryable]).toEqual([0, "network", true]);

    const ac = new AbortController();
    ac.abort();
    const aborting = (async (_: unknown, init?: RequestInit) => {
      throw init?.signal?.reason ?? new Error("aborted");
    }) as unknown as typeof fetch;
    const aborted = await client(aborting)
      .pollEvents(undefined, 25, ac.signal)
      .catch((e: unknown) => e);
    expect(aborted).not.toBeInstanceOf(FelicityError);
  });
});
