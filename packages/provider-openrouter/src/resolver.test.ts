import { describe, expect, it } from "vitest";
import { resolveOpenRouterConfig, toOpenRouterCredentials } from "./resolver.js";

describe("resolveOpenRouterConfig", () => {
  it("returns null when OPENROUTER_API_KEY is unset", () => {
    expect(resolveOpenRouterConfig({}, undefined)).toBeNull();
  });

  it("returns null when OPENROUTER_API_KEY is an empty string", () => {
    expect(resolveOpenRouterConfig({ OPENROUTER_API_KEY: "" }, undefined)).toBeNull();
  });

  it("uses the default base URL when OPENROUTER_BASE_URL is absent", () => {
    const cfg = resolveOpenRouterConfig({ OPENROUTER_API_KEY: "sk-test" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("uses OPENROUTER_BASE_URL override when set", () => {
    const cfg = resolveOpenRouterConfig(
      { OPENROUTER_API_KEY: "sk-test", OPENROUTER_BASE_URL: "https://custom.example.com/v1" },
      undefined,
    );
    expect(cfg).not.toBeNull();
    expect(cfg?.baseURL).toBe("https://custom.example.com/v1");
  });

  it("does not validate the key by a documented prefix", () => {
    // A non-empty value with any format (including future formats / test keys)
    // resolves — only non-empty is required.
    const cfg = resolveOpenRouterConfig({ OPENROUTER_API_KEY: "some-future-format" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("some-future-format");
  });

  it("model precedence: host config wins, then OPENROUTER_MODEL, then default", () => {
    // config wins over env + default
    const fromConfig = resolveOpenRouterConfig(
      { OPENROUTER_API_KEY: "sk-test", OPENROUTER_MODEL: "env-model" },
      "config-model",
    );
    expect(fromConfig?.model).toBe("config-model");

    // env wins when config is absent
    const fromEnv = resolveOpenRouterConfig(
      { OPENROUTER_API_KEY: "sk-test", OPENROUTER_MODEL: "env-model" },
      undefined,
    );
    expect(fromEnv?.model).toBe("env-model");

    // default when neither is set
    const fromDefault = resolveOpenRouterConfig({ OPENROUTER_API_KEY: "sk-test" }, undefined);
    expect(fromDefault?.model).toBe("openrouter/meta-llama/llama-3.1-8b-instruct:free");
  });

  it("toOpenRouterCredentials builds an api-key credential with the resolved baseURL", () => {
    const cfg = resolveOpenRouterConfig({ OPENROUTER_API_KEY: "sk-test" }, undefined);
    expect(cfg).not.toBeNull();
    if (!cfg) return; // narrows without a non-null assertion
    expect(toOpenRouterCredentials(cfg)).toEqual({
      type: "api-key",
      apiKey: "sk-test",
      baseURL: "https://openrouter.ai/api/v1",
    });
  });
});
