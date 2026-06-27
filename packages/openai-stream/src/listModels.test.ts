import type { ApiKeyCredentials, ModelInfo, ProviderContract } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";
import { describe, expect, it, vi } from "vitest";
import { isVisionModelId, parseModelList } from "./listModels.js";
import { createOpenAICompatProvider } from "./provider.js";

function makeProvider(fetchFn: FetchLike, apiKey = "sk-test-1234567890abcdef"): ProviderContract {
  const creds: ApiKeyCredentials = {
    type: "api-key",
    apiKey,
    baseURL: "https://api.example.com/v1",
  };
  return createOpenAICompatProvider({
    credentials: creds,
    model: "test-model",
    id: "openai-compat",
    fetchFn,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("listModels — pure mapping (parseModelList)", () => {
  it("maps OpenAI model entries to ModelInfo", () => {
    const result = parseModelList([{ id: "a" }, { id: "b" }]);
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("returns empty array for empty input", () => {
    const result = parseModelList([]);
    expect(result).toEqual([]);
  });

  it("extracts contextWindow from common field names", () => {
    const result = parseModelList([
      { id: "m1", context_length: 128000 },
      { id: "m2", context_window: 200000 },
      { id: "m3", max_context_length: 64000 },
      { id: "m4", max_tokens: 8000 },
    ]);
    expect(result).toEqual([
      { id: "m1", contextWindow: 128000 },
      { id: "m2", contextWindow: 200000 },
      { id: "m3", contextWindow: 64000 },
      { id: "m4", contextWindow: 8000 },
    ]);
  });
});

describe("listModels — vision capability detection", () => {
  it("isVisionModelId returns true for umans kimi and qwen model ids", () => {
    expect(isVisionModelId("umans-kimi-k2.7")).toBe(true);
    expect(isVisionModelId("Umans-Kimi-K2.7")).toBe(true); // case-insensitive
    expect(isVisionModelId("umans-qwen3.6-35b-a3b")).toBe(true);
  });

  it("isVisionModelId returns false for non-vision model ids", () => {
    expect(isVisionModelId("umans-glm-5.2")).toBe(false);
    expect(isVisionModelId("umans-coder")).toBe(false);
    expect(isVisionModelId("umans-flash")).toBe(false);
    expect(isVisionModelId("kimi-k2.7-code")).toBe(false); // opencode kimi, not umans
    expect(isVisionModelId("qwen3.7-max")).toBe(false); // opencode qwen, not umans
    expect(isVisionModelId("deepseek-v4-flash")).toBe(false);
  });

  it("parseModelList sets vision: true on umans kimi and qwen models only", () => {
    const result = parseModelList([
      { id: "umans-kimi-k2.7", context_length: 262144 },
      { id: "umans-qwen3.6-35b-a3b", context_length: 262144 },
      { id: "umans-glm-5.2", context_length: 405504 },
      { id: "umans-coder" },
    ]);
    expect(result).toEqual([
      { id: "umans-kimi-k2.7", contextWindow: 262144, vision: true },
      { id: "umans-qwen3.6-35b-a3b", contextWindow: 262144, vision: true },
      { id: "umans-glm-5.2", contextWindow: 405504 },
      { id: "umans-coder" },
    ]);
  });
});

describe("listModels — provider contract", () => {
  it("GETs models endpoint with bearer key and returns mapped ModelInfo[]", async () => {
    const fetchFn = vi.fn(
      () => jsonResponse({ data: [{ id: "a" }, { id: "b" }] }) as unknown as ReturnType<FetchLike>,
    );
    const provider = makeProvider(fetchFn);
    const listModels = provider.listModels;
    if (!listModels) throw new Error("listModels not defined");

    const models = await listModels();

    expect(fetchFn).toHaveBeenCalledOnce();
    const callArgs = fetchFn.mock.calls[0];
    if (!callArgs) throw new Error("no call args");
    const [url, init] = callArgs as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/models");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test-1234567890abcdef" });

    expect(models).toEqual([{ id: "a" }, { id: "b" }] as readonly ModelInfo[]);
  });

  it("throws on non-OK HTTP status with a clear message", async () => {
    const fetchFn = vi.fn(
      () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }) as unknown as ReturnType<FetchLike>,
    );
    const provider = makeProvider(fetchFn);
    const listModels = provider.listModels;
    if (!listModels) throw new Error("listModels not defined");

    await expect(listModels()).rejects.toThrow(
      "listModels[openai-compat]: HTTP 401 — Unauthorized",
    );
  });

  it("throws on network error with a clear message", async () => {
    const fetchFn = vi.fn(() => {
      throw new Error("connection refused");
    }) as unknown as FetchLike;
    const provider = makeProvider(fetchFn);
    const listModels = provider.listModels;
    if (!listModels) throw new Error("listModels not defined");

    await expect(listModels()).rejects.toThrow(
      "listModels[openai-compat]: network error — connection refused",
    );
  });

  it("throws when response shape is missing data array", async () => {
    const fetchFn = vi.fn(() => jsonResponse({ models: [] }) as unknown as ReturnType<FetchLike>);
    const provider = makeProvider(fetchFn);
    const listModels = provider.listModels;
    if (!listModels) throw new Error("listModels not defined");

    await expect(listModels()).rejects.toThrow(
      'listModels[openai-compat]: unexpected response shape — missing "data" array',
    );
  });
});
