import { describe, expect, it } from "vitest";
import { replayFetch } from "./replay.js";
import type { HttpExchangeFixture } from "./types.js";

const fixture: HttpExchangeFixture = {
  request: {
    method: "POST",
    url: "https://api.example.com/v1/chat",
    headers: { "content-type": "application/json", authorization: "Bearer sk-abc" },
    body: '{"model":"gpt-4"}',
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json", "x-request-id": "req-123" },
    body: '{"choices":[{"text":"hello"}]}',
  },
  meta: { model: "gpt-4", capturedAt: 1700000000000 },
};

describe("replayFetch", () => {
  it("returns a Response with fixture status/statusText/headers", async () => {
    const { fetch } = replayFetch(fixture);
    const res = await fetch("https://api.example.com/v1/chat", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-request-id")).toBe("req-123");
  });

  it("body reads exactly fixture.response.body", async () => {
    const { fetch } = replayFetch(fixture);
    const res = await fetch("https://api.example.com/v1/chat");
    expect(await res.text()).toBe('{"choices":[{"text":"hello"}]}');
  });

  it("chunkBytes splits body into correct number of chunks and reassembles", async () => {
    const body = "abcdefghij"; // 10 bytes
    const fx: HttpExchangeFixture = {
      ...fixture,
      response: { ...fixture.response, body },
    };
    const { fetch } = replayFetch(fx, { chunkBytes: 3 });
    const res = await fetch("https://x");
    const responseBody = res.body;
    if (!responseBody) throw new Error("body is null");

    const reader = responseBody.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toHaveLength(4); // 3+3+3+1

    let reassembled = "";
    for (const c of chunks) reassembled += new TextDecoder().decode(c);
    expect(reassembled).toBe("abcdefghij");
  });

  it("getCapturedRequest returns undefined before first call", () => {
    const { getCapturedRequest } = replayFetch(fixture);
    expect(getCapturedRequest()).toBeUndefined();
  });

  it("getCapturedRequest returns the request after fetch", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    await fetch("https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"hi"}',
    });
    const captured = getCapturedRequest();
    expect(captured).toBeDefined();
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("https://api.example.com/v1/chat");
    expect(captured?.headers["content-type"]).toBe("application/json");
    expect(captured?.body).toBe('{"prompt":"hi"}');
  });

  it("getCapturedRequest updates on subsequent calls", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    await fetch("https://first", { method: "GET" });
    expect(getCapturedRequest()?.url).toBe("https://first");
    await fetch("https://second", { method: "PUT" });
    expect(getCapturedRequest()?.url).toBe("https://second");
    expect(getCapturedRequest()?.method).toBe("PUT");
  });

  it("captures URL and method from Request object input", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    const req = new Request("https://from-request.com/path", { method: "DELETE" });
    await fetch(req);
    expect(getCapturedRequest()?.url).toBe("https://from-request.com/path");
    expect(getCapturedRequest()?.method).toBe("DELETE");
  });

  it("defaults method to GET when no init", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    await fetch("https://x");
    expect(getCapturedRequest()?.method).toBe("GET");
  });

  it("handles null request body", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    await fetch("https://x", { method: "GET" });
    expect(getCapturedRequest()?.body).toBeNull();
  });

  it("handles headers as array of tuples", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    await fetch("https://x", {
      headers: [["x-custom", "val"]],
    });
    expect(getCapturedRequest()?.headers["x-custom"]).toBe("val");
  });

  it("handles headers as Headers object", async () => {
    const { fetch, getCapturedRequest } = replayFetch(fixture);
    const h = new Headers({ "x-h": "v" });
    await fetch("https://x", { headers: h });
    expect(getCapturedRequest()?.headers["x-h"]).toBe("v");
  });

  it("works with minimal response (no statusText, status 204, empty body)", async () => {
    const fx: HttpExchangeFixture = {
      request: { method: "GET", url: "https://x", headers: {}, body: null },
      response: { status: 204, headers: {}, body: "" },
    };
    const { fetch } = replayFetch(fx);
    const res = await fetch("https://x");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
