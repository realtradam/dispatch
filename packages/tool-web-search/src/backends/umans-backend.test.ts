import type { SearchParams } from "@dispatch/search-backend-contract";
import { describe, expect, it } from "vitest";
import {
  buildUmansRelayRequest,
  createUmansSearchBackend,
  parseUmansContentBlocks,
  umansMessagesUrl,
} from "./umans-backend.js";

const params: SearchParams = { query: "hello world", limit: 7 };

describe("umansMessagesUrl", () => {
  it("appends /messages to a /v1 base", () => {
    expect(umansMessagesUrl("https://api.code.umans.ai/v1")).toBe(
      "https://api.code.umans.ai/v1/messages",
    );
  });

  it("appends /v1/messages to a bare base", () => {
    expect(umansMessagesUrl("https://api.code.umans.ai")).toBe(
      "https://api.code.umans.ai/v1/messages",
    );
  });

  it("strips a trailing slash", () => {
    expect(umansMessagesUrl("https://api.code.umans.ai/v1/")).toBe(
      "https://api.code.umans.ai/v1/messages",
    );
  });
});

describe("buildUmansRelayRequest", () => {
  it("builds the relay body: raw query verbatim + the server-side web_search tool", () => {
    expect(buildUmansRelayRequest(params, "umans-flash", 5, 1024)).toEqual({
      model: "umans-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello world" }],
      tools: [{ type: "web_search_20250305", max_uses: 5 }],
    });
  });
});

describe("parseUmansContentBlocks", () => {
  it("maps web_search_tool_result blocks to SearchHit[] (hits only)", () => {
    const hits = parseUmansContentBlocks([
      { type: "text", text: "prose answer — discarded" },
      {
        type: "web_search_tool_result",
        content: [
          {
            type: "web_search_result",
            url: "http://a",
            title: "A",
            snippet: "sa",
            page_age: "2 days ago",
          },
          { type: "web_search_result", url: "http://b", title: "B" },
        ],
      },
    ]);
    expect(hits).toEqual([
      { url: "http://a", title: "A", description: "sa (2 days ago)" },
      { url: "http://b", title: "B" },
    ]);
  });

  it("accepts a description fallback and entries without a type tag", () => {
    const hits = parseUmansContentBlocks([
      { type: "web_search_tool_result", content: [{ url: "http://c", description: "d" }] },
    ]);
    expect(hits).toEqual([{ url: "http://c", description: "d" }]);
  });

  it("skips unrecognized / malformed blocks instead of crashing", () => {
    expect(parseUmansContentBlocks([null, 42, { type: "text", text: "x" }, {}])).toEqual([]);
    expect(parseUmansContentBlocks(undefined)).toEqual([]);
    expect(parseUmansContentBlocks({ type: "web_search_tool_result" })).toEqual([]);
  });

  it("keeps entries that have only a title (no url)", () => {
    const hits = parseUmansContentBlocks([
      { type: "web_search_tool_result", content: [{ title: "Only title" }] },
    ]);
    expect(hits).toEqual([{ title: "Only title" }]);
  });
});

describe("createUmansSearchBackend", () => {
  function makeFetch(
    status: number,
    body: unknown,
  ): {
    fetchFn: typeof globalThis.fetch;
    calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
  } {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, body: typeof init?.body === "string" ? init.body : "" });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { fetchFn, calls };
  }

  const OK_RESPONSE = {
    content: [
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", url: "http://a", title: "A", snippet: "sa" }],
      },
    ],
  };

  it("posts the relay to {base}/v1/messages with the exa provider header", async () => {
    const { fetchFn, calls } = makeFetch(200, OK_RESPONSE);
    const backend = createUmansSearchBackend({
      apiKey: "k",
      baseUrl: "https://umans.example/v1",
      fetchFn,
    });
    const hits = await backend.search(params, new AbortController().signal);
    expect(hits).toEqual([{ url: "http://a", title: "A", description: "sa" }]);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toBe("https://umans.example/v1/messages");
    expect(call.headers["X-Umans-Websearch-Provider"]).toBe("exa");
    expect(call.headers["x-api-key"]).toBe("k");
    const body = JSON.parse(call.body);
    expect(body.model).toBe("umans-flash");
    expect(body.messages).toEqual([{ role: "user", content: "hello world" }]);
    expect(body.tools).toEqual([{ type: "web_search_20250305", max_uses: 5 }]);
  });

  it("exposes the decided id + label", () => {
    const { fetchFn } = makeFetch(200, OK_RESPONSE);
    const backend = createUmansSearchBackend({ apiKey: "k", baseUrl: "http://u/v1", fetchFn });
    expect(backend.id).toBe("umans");
    expect(backend.label).toBe("Umans (Exa)");
  });

  it("honors the model / maxUses overrides", async () => {
    const { fetchFn, calls } = makeFetch(200, OK_RESPONSE);
    const backend = createUmansSearchBackend({
      apiKey: "k",
      baseUrl: "http://u/v1",
      model: "umans-pro",
      maxUses: 3,
      fetchFn,
    });
    await backend.search(params, new AbortController().signal);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.model).toBe("umans-pro");
    expect(body.tools[0]?.max_uses).toBe(3);
  });

  it("throws (→ tool-level isError) on HTTP failure", async () => {
    const { fetchFn } = makeFetch(500, { error: "boom" });
    const backend = createUmansSearchBackend({ apiKey: "k", baseUrl: "http://u/v1", fetchFn });
    await expect(backend.search(params, new AbortController().signal)).rejects.toThrow("HTTP 500");
  });
});
