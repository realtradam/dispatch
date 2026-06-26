import { describe, expect, it } from "vitest";
import { recordFetch } from "./record.js";
import type { FetchLike, HttpExchangeFixture } from "./types.js";

function fakeResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("recordFetch", () => {
  it("onExchange receives fixture matching request+response", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () => fakeResponse('{"ok":true}');
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    await recorded("https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"hi"}',
    });

    expect(fixtures).toHaveLength(1);
    const fx = fixtures[0] as HttpExchangeFixture;
    expect(fx.request.method).toBe("POST");
    expect(fx.request.url).toBe("https://api.example.com/v1/chat");
    expect(fx.request.headers["content-type"]).toBe("application/json");
    expect(fx.request.body).toBe('{"prompt":"hi"}');
    expect(fx.response.status).toBe(200);
    expect(fx.response.statusText).toBe("OK");
    expect(fx.response.headers["content-type"]).toBe("application/json");
    expect(fx.response.body).toBe('{"ok":true}');
  });

  it("response returned to caller is still fully readable after recording", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () => fakeResponse("full body content");
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    const res = await recorded("https://x");
    expect(await res.text()).toBe("full body content");
  });

  it("response body can be read even after fixture is captured", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () => fakeResponse("stream data");
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    const res = await recorded("https://x");
    expect(fixtures[0]?.response.body).toBe("stream data");
    expect(await res.text()).toBe("stream data");
  });

  it("captures Request object input with method", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () => fakeResponse("ok");
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    const req = new Request("https://from-req.com/path", { method: "PUT" });
    await recorded(req);

    expect(fixtures[0]?.request.url).toBe("https://from-req.com/path");
    expect(fixtures[0]?.request.method).toBe("PUT");
  });

  it("defaults method to GET", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () => fakeResponse("ok");
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    await recorded("https://x");
    expect(fixtures[0]?.request.method).toBe("GET");
  });

  it("captures null request body", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () => fakeResponse("ok");
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    await recorded("https://x", { method: "GET" });
    expect(fixtures[0]?.request.body).toBeNull();
  });

  it("captures response error status", async () => {
    const fixtures: HttpExchangeFixture[] = [];
    const fakeFetch: FetchLike = async () =>
      new Response('{"error":"bad request"}', {
        status: 400,
        statusText: "Bad Request",
      });
    const recorded = recordFetch(fakeFetch, (fx) => fixtures.push(fx));

    const res = await recorded("https://x");
    expect(fixtures[0]?.response.status).toBe(400);
    expect(res.status).toBe(400);
  });

  it("passes through to real fetch", async () => {
    let called = false;
    const fakeFetch: FetchLike = async () => {
      called = true;
      return new Response("from fake", { status: 201 });
    };
    const recorded = recordFetch(fakeFetch, () => {});
    const res = await recorded("https://x");
    expect(called).toBe(true);
    expect(res.status).toBe(201);
  });
});
