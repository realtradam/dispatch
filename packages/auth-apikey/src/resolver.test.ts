import { describe, expect, it } from "vitest";
import { resolveApiKeyCredentials } from "./resolver.js";

describe("resolveApiKeyCredentials", () => {
  it("resolves key with default baseURL from minimal env", () => {
    const env = { DISPATCH_API_KEY: "sk-test-123" };
    const result = resolveApiKeyCredentials(env);
    expect(result).toEqual({
      type: "api-key",
      apiKey: "sk-test-123",
      baseURL: "https://opencode.ai/zen/go/v1",
    });
  });

  it("honors an explicit DISPATCH_BASE_URL", () => {
    const env = {
      DISPATCH_API_KEY: "sk-test-456",
      DISPATCH_BASE_URL: "https://custom.example.com/v2",
    };
    const result = resolveApiKeyCredentials(env);
    expect(result).toEqual({
      type: "api-key",
      apiKey: "sk-test-456",
      baseURL: "https://custom.example.com/v2",
    });
  });

  it("returns undefined when DISPATCH_API_KEY is absent", () => {
    const env = {};
    const result = resolveApiKeyCredentials(env);
    expect(result).toBeUndefined();
  });

  it("returns undefined when DISPATCH_API_KEY is empty string", () => {
    const env = { DISPATCH_API_KEY: "" };
    const result = resolveApiKeyCredentials(env);
    expect(result).toBeUndefined();
  });
});
