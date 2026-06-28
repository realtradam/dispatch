import type { ProviderUsage } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";
import { describe, expect, it, vi } from "vitest";
import { getUsage } from "./getUsage.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getUsage", () => {
  it("extracts concurrent_sessions from the Umans /v1/usage shape", async () => {
    const fetchFn = vi.fn(
      () =>
        jsonResponse({
          usage: { concurrent_sessions: 3 },
          limits: { concurrency: { limit: 4, hard_cap: 5 } },
        }) as unknown as ReturnType<FetchLike>,
    );

    const result = await getUsage({
      baseURL: "https://api.umans.ai/v1",
      apiKey: "sk-test-1234567890abcdef",
      providerId: "umans",
      fetchFn,
    });

    expect(result).toEqual<ProviderUsage>({ concurrentSessions: 3 });
    expect(fetchFn).toHaveBeenCalledOnce();
    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe("https://api.umans.ai/v1/usage");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test-1234567890abcdef",
    );
  });

  it("returns undefined on non-200 (endpoint unsupported)", async () => {
    const fetchFn = vi.fn(
      () => jsonResponse({ error: "not found" }, 404) as unknown as ReturnType<FetchLike>,
    );

    const result = await getUsage({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      providerId: "openai",
      fetchFn,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined on a network error (never throws)", async () => {
    const fetchFn = vi.fn(
      () => Promise.reject(new Error("ECONNREFUSED")) as unknown as Promise<Response>,
    );

    const result = await getUsage({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      providerId: "openai",
      fetchFn,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when the response shape is unexpected", async () => {
    const fetchFn = vi.fn(
      () => jsonResponse({ unexpected: true }) as unknown as ReturnType<FetchLike>,
    );

    const result = await getUsage({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      providerId: "openai",
      fetchFn,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when concurrent_sessions is not a number", async () => {
    const fetchFn = vi.fn(
      () =>
        jsonResponse({
          usage: { concurrent_sessions: "three" },
        }) as unknown as ReturnType<FetchLike>,
    );

    const result = await getUsage({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      providerId: "openai",
      fetchFn,
    });

    expect(result).toBeUndefined();
  });

  it("truncates a fractional concurrent_sessions to an integer", async () => {
    const fetchFn = vi.fn(
      () =>
        jsonResponse({ usage: { concurrent_sessions: 2.9 } }) as unknown as ReturnType<FetchLike>,
    );

    const result = await getUsage({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      providerId: "openai",
      fetchFn,
    });

    expect(result).toEqual<ProviderUsage>({ concurrentSessions: 2 });
  });

  it("falls back to globalThis.fetch when fetchFn is absent", async () => {
    const original = globalThis.fetch;
    const stub = vi.fn(
      () => jsonResponse({ usage: { concurrent_sessions: 1 } }) as unknown as ReturnType<FetchLike>,
    );
    globalThis.fetch = stub as unknown as typeof globalThis.fetch;

    try {
      const result = await getUsage({
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        providerId: "openai",
      });
      expect(result).toEqual<ProviderUsage>({ concurrentSessions: 1 });
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
