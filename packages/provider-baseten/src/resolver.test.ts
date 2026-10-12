import { describe, expect, it } from "vitest";
import { resolveBasetenConfig, toBasetenCredentials } from "./resolver.js";

describe("resolveBasetenConfig", () => {
  it("activate uses BASETEN_BASE_URL override when set (default otherwise)", () => {
    const override = resolveBasetenConfig(
      { BASETEN_API_KEY: "sk-test", BASETEN_BASE_URL: "https://custom.example.com/openai" },
      undefined,
    );
    expect(override?.baseURL).toBe("https://custom.example.com/openai");

    const fallback = resolveBasetenConfig({ BASETEN_API_KEY: "sk-test" }, undefined);
    expect(fallback?.baseURL).toBe("https://inference.baseten.co/v1");
  });

  it('activate uses config provider.baseten.model → BASETEN_MODEL → "deepseek-ai/DeepSeek-V4.1-Flash-Fast" resolution', () => {
    // config wins over env + default
    const fromConfig = resolveBasetenConfig(
      { BASETEN_API_KEY: "sk-test", BASETEN_MODEL: "env-model" },
      "config-model",
    );
    expect(fromConfig?.model).toBe("config-model");

    // env wins when config is absent
    const fromEnv = resolveBasetenConfig(
      { BASETEN_API_KEY: "sk-test", BASETEN_MODEL: "env-model" },
      undefined,
    );
    expect(fromEnv?.model).toBe("env-model");

    // default when neither is set
    const fromDefault = resolveBasetenConfig({ BASETEN_API_KEY: "sk-test" }, undefined);
    expect(fromDefault?.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-Fast");
  });

  it("returns null when BASETEN_API_KEY is unset", () => {
    expect(resolveBasetenConfig({}, undefined)).toBeNull();
  });

  it("returns null when BASETEN_API_KEY is empty string", () => {
    expect(resolveBasetenConfig({ BASETEN_API_KEY: "" }, undefined)).toBeNull();
  });

  it("toBasetenCredentials builds an api-key credential with the resolved baseURL", () => {
    const cfg = resolveBasetenConfig({ BASETEN_API_KEY: "sk-test" }, undefined);
    expect(cfg).not.toBeNull();
    if (!cfg) return; // narrows without a non-null assertion
    expect(toBasetenCredentials(cfg)).toEqual({
      type: "api-key",
      apiKey: "sk-test",
      baseURL: "https://inference.baseten.co/v1",
    });
  });
});
