import { describe, expect, it } from "vitest";
import { resolveCoralbricksConfig, toCoralbricksCredentials } from "./resolver.js";

describe("resolveCoralbricksConfig", () => {
  it("returns null when CORAL_API_KEY is unset", () => {
    expect(resolveCoralbricksConfig({}, undefined)).toBeNull();
  });

  it("returns null when CORAL_API_KEY is an empty string", () => {
    expect(resolveCoralbricksConfig({ CORAL_API_KEY: "" }, undefined)).toBeNull();
  });

  it("uses the default base URL when CORAL_BASE_URL is absent", () => {
    const cfg = resolveCoralbricksConfig({ CORAL_API_KEY: "cb-test" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.baseURL).toBe("https://inference.coralbricks.ai/v1");
  });

  it("uses CORAL_BASE_URL override when set", () => {
    const cfg = resolveCoralbricksConfig(
      { CORAL_API_KEY: "cb-test", CORAL_BASE_URL: "https://custom.example.com/v1" },
      undefined,
    );
    expect(cfg).not.toBeNull();
    expect(cfg?.baseURL).toBe("https://custom.example.com/v1");
  });

  it("does not validate the key by a documented prefix", () => {
    // A non-empty value with any format (including future formats / test keys)
    // resolves — only non-empty is required.
    const cfg = resolveCoralbricksConfig({ CORAL_API_KEY: "some-future-format" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("some-future-format");
  });

  it("model precedence: host config wins, then CORAL_MODEL, then default", () => {
    const fromConfig = resolveCoralbricksConfig(
      { CORAL_API_KEY: "cb-test", CORAL_MODEL: "env-model" },
      "config-model",
    );
    expect(fromConfig?.model).toBe("config-model");

    const fromEnv = resolveCoralbricksConfig(
      { CORAL_API_KEY: "cb-test", CORAL_MODEL: "env-model" },
      undefined,
    );
    expect(fromEnv?.model).toBe("env-model");

    const fromDefault = resolveCoralbricksConfig({ CORAL_API_KEY: "cb-test" }, undefined);
    expect(fromDefault?.model).toBe("deepseek-v4.1-flash-fast");
  });

  it("toCoralbricksCredentials builds an api-key credential with the resolved baseURL", () => {
    const cfg = resolveCoralbricksConfig({ CORAL_API_KEY: "cb-test" }, undefined);
    expect(cfg).not.toBeNull();
    if (!cfg) return; // narrows without a non-null assertion
    expect(toCoralbricksCredentials(cfg)).toEqual({
      type: "api-key",
      apiKey: "cb-test",
      baseURL: "https://inference.coralbricks.ai/v1",
    });
  });
});
