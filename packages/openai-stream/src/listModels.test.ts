import type { ApiKeyCredentials, ModelInfo, ProviderContract } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";
import { describe, expect, it, vi } from "vitest";
import {
  isVisionModelId,
  listUmansModels,
  parseModelList,
  parseUmansModelInfo,
  visionFromUmansCapability,
} from "./listModels.js";
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

  it("parseModelList honors explicit capabilities.vision: true", () => {
    const result = parseModelList([{ id: "deepseek-v4-flash", capabilities: { vision: true } }]);
    expect(result).toEqual([{ id: "deepseek-v4-flash", vision: true }]);
  });

  it("parseModelList honors explicit capabilities.vision: false — metadata wins over the name heuristic", () => {
    // "umans-kimi-*" would be marked vision:true by the name heuristic; the
    // authoritative boolean must win.
    const result = parseModelList([{ id: "umans-kimi-k2.7", capabilities: { vision: false } }]);
    expect(result).toEqual([{ id: "umans-kimi-k2.7", vision: false }]);
  });

  it("parseModelList honors a top-level supports_image_input boolean (CoralBricks)", () => {
    const result = parseModelList([
      {
        id: "deepseek-v4.1-flash-fast",
        context_length: 1048576,
        supports_image_input: true,
      },
      { id: "glm-5.3-fast", context_length: 1048576, supports_image_input: false },
    ]);
    expect(result).toEqual([
      { id: "deepseek-v4.1-flash-fast", contextWindow: 1048576, vision: true },
      { id: "glm-5.3-fast", contextWindow: 1048576, vision: false },
    ]);
  });

  it("parseModelList prefers capabilities.vision over supports_image_input when both are present", () => {
    const result = parseModelList([
      { id: "m1", capabilities: { vision: false }, supports_image_input: true },
    ]);
    expect(result).toEqual([{ id: "m1", vision: false }]);
  });

  it("parseModelList falls back to the name heuristic when capabilities.vision is absent", () => {
    // no capabilities field — heuristic still applies (backward compatible)
    const heuristic = parseModelList([{ id: "umans-kimi-k2.7" }, { id: "deepseek-v4-flash" }]);
    expect(heuristic).toEqual([
      { id: "umans-kimi-k2.7", vision: true },
      { id: "deepseek-v4-flash" },
    ]);

    // capabilities present but vision undefined → falls through to heuristic
    const emptyCap = parseModelList([{ id: "umans-kimi-k2.7", capabilities: {} }]);
    expect(emptyCap).toEqual([{ id: "umans-kimi-k2.7", vision: true }]);
  });

  it("parseModelList maps a Hyper-shaped entry with context_window + explicit vision", () => {
    const result = parseModelList([
      {
        id: "hyper-deepseek-v4-flash",
        context_window: 64000,
        capabilities: { vision: false },
      },
      {
        id: "hyper-kimi-k2.7",
        context_window: 262144,
        capabilities: { vision: true },
      },
    ]);
    expect(result).toEqual([
      { id: "hyper-deepseek-v4-flash", contextWindow: 64000, vision: false },
      { id: "hyper-kimi-k2.7", contextWindow: 262144, vision: true },
    ]);
  });
});

describe("listModels — vision capability mapping (visionFromUmansCapability)", () => {
  it("maps true -> true", () => {
    expect(visionFromUmansCapability(true)).toBe(true);
  });

  it("maps false -> false", () => {
    expect(visionFromUmansCapability(false)).toBe(false);
  });

  it("maps 'via-handoff' -> false (native Chat-Completions image input is not supported)", () => {
    expect(visionFromUmansCapability("via-handoff")).toBe(false);
  });

  it("maps undefined -> undefined (unknown — callers fall back to heuristic)", () => {
    expect(visionFromUmansCapability(undefined)).toBeUndefined();
  });
});

describe("listModels — Umans /models/info parsing (parseUmansModelInfo)", () => {
  it("maps the real supports_vision values to ModelInfo.vision (true/false/via-handoff)", () => {
    const result = parseUmansModelInfo({
      "umans-kimi-k2.7": {
        capabilities: { context_window: 262144, supports_vision: true },
      },
      "umans-coder": {
        capabilities: { context_window: 262144, supports_vision: true },
      },
      "umans-flash": {
        capabilities: { context_window: 262144, supports_vision: true },
      },
      "umans-glm-5.2": {
        capabilities: { context_window: 405504, supports_vision: "via-handoff" },
      },
      "umans-deepseek-v4-flash-0731": {
        capabilities: { context_window: 1048576, supports_vision: false },
      },
    });
    expect(result).toEqual([
      { id: "umans-kimi-k2.7", contextWindow: 262144, vision: true, maxImages: 8 },
      { id: "umans-coder", contextWindow: 262144, vision: true, maxImages: 8 },
      { id: "umans-flash", contextWindow: 262144, vision: true, maxImages: 8 },
      { id: "umans-glm-5.2", contextWindow: 405504, vision: false, maxImages: 8 },
      { id: "umans-deepseek-v4-flash-0731", contextWindow: 1048576, vision: false, maxImages: 8 },
    ]);
  });

  it("includes display_name when present", () => {
    const result = parseUmansModelInfo({
      "umans-coder": {
        display_name: "Umans Coder",
        capabilities: { context_window: 262144, supports_vision: true },
      },
    });
    expect(result).toEqual([
      {
        id: "umans-coder",
        displayName: "Umans Coder",
        contextWindow: 262144,
        vision: true,
        maxImages: 8,
      },
    ]);
  });

  it("omits vision when the capability field is absent (caller may use the name fallback)", () => {
    const result = parseUmansModelInfo({
      "umans-coder": { capabilities: { context_window: 262144 } },
    });
    expect(result).toEqual([{ id: "umans-coder", contextWindow: 262144, maxImages: 8 }]);
  });

  it("returns empty array for an empty response map", () => {
    expect(parseUmansModelInfo({})).toEqual([]);
  });
});

describe("listModels — Umans /models/info fetch (listUmansModels)", () => {
  it("GETs /models/info with bearer key and maps capabilities -> ModelInfo[]", async () => {
    const fetchFn = vi.fn(
      () =>
        jsonResponse({
          "umans-kimi-k2.7": { capabilities: { context_window: 262144, supports_vision: true } },
          "umans-glm-5.2": {
            capabilities: { context_window: 405504, supports_vision: "via-handoff" },
          },
        }) as unknown as ReturnType<FetchLike>,
    );

    const models = await listUmansModels({
      baseURL: "https://api.code.umans.ai/v1",
      apiKey: "sk-test-1234567890abcdef",
      providerId: "umans",
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const callArgs = fetchFn.mock.calls[0];
    if (!callArgs) throw new Error("no call args");
    const [url, init] = callArgs as unknown as [string, RequestInit];
    expect(url).toBe("https://api.code.umans.ai/v1/models/info");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test-1234567890abcdef" });

    expect(models).toEqual([
      { id: "umans-kimi-k2.7", contextWindow: 262144, vision: true, maxImages: 8 },
      { id: "umans-glm-5.2", contextWindow: 405504, vision: false, maxImages: 8 },
    ] as readonly ModelInfo[]);
  });

  it("throws on non-OK HTTP status with a clear message", async () => {
    const fetchFn = vi.fn(
      () =>
        new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }) as unknown as ReturnType<FetchLike>,
    );
    await expect(
      listUmansModels({
        baseURL: "https://api.code.umans.ai/v1",
        apiKey: "sk-test",
        providerId: "umans",
        fetchFn,
      }),
    ).rejects.toThrow("listModels[umans]: HTTP 403 — Forbidden");
  });

  it("throws on network error with a clear message", async () => {
    const fetchFn = vi.fn(() => {
      throw new Error("connection refused");
    }) as unknown as FetchLike;
    await expect(
      listUmansModels({
        baseURL: "https://api.code.umans.ai/v1",
        apiKey: "sk-test",
        providerId: "umans",
        fetchFn,
      }),
    ).rejects.toThrow("listModels[umans]: network error — connection refused");
  });

  it("throws when the response is not a model-info map keyed by model id", async () => {
    const fetchFn = vi.fn(() => jsonResponse([{ id: "a" }]) as unknown as ReturnType<FetchLike>);
    await expect(
      listUmansModels({
        baseURL: "https://api.code.umans.ai/v1",
        apiKey: "sk-test",
        providerId: "umans",
        fetchFn,
      }),
    ).rejects.toThrow(
      "listModels[umans]: unexpected response shape — expected a model-info map keyed by model id",
    );
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
