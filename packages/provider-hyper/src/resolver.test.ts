import { describe, expect, it } from "vitest";
import { resolveHyperConfig, toHyperCredentials } from "./resolver.js";

describe("resolveHyperConfig", () => {
  it("returns null when HYPER_API_KEY is unset", () => {
    expect(resolveHyperConfig({}, undefined)).toBeNull();
  });

  it("returns null when HYPER_API_KEY is an empty string", () => {
    expect(resolveHyperConfig({ HYPER_API_KEY: "" }, undefined)).toBeNull();
  });

  it("uses the default base URL when HYPER_BASE_URL is absent", () => {
    const cfg = resolveHyperConfig({ HYPER_API_KEY: "sk-test" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.baseURL).toBe("https://hyper.charm.land/v1");
  });

  it("uses HYPER_BASE_URL override when set", () => {
    const cfg = resolveHyperConfig(
      { HYPER_API_KEY: "sk-test", HYPER_BASE_URL: "https://custom.example.com/v1" },
      undefined,
    );
    expect(cfg).not.toBeNull();
    expect(cfg?.baseURL).toBe("https://custom.example.com/v1");
  });

  it("does not validate the key by a documented prefix", () => {
    // A non-empty value with any format (including future formats / test keys)
    // resolves — only non-empty is required.
    const cfg = resolveHyperConfig({ HYPER_API_KEY: "some-future-format" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("some-future-format");
  });

  it("model precedence: host config wins, then HYPER_MODEL, then default", () => {
    // config wins over env + default
    const fromConfig = resolveHyperConfig(
      { HYPER_API_KEY: "sk-test", HYPER_MODEL: "env-model" },
      "config-model",
    );
    expect(fromConfig?.model).toBe("config-model");

    // env wins when config is absent
    const fromEnv = resolveHyperConfig(
      { HYPER_API_KEY: "sk-test", HYPER_MODEL: "env-model" },
      undefined,
    );
    expect(fromEnv?.model).toBe("env-model");

    // default when neither is set
    const fromDefault = resolveHyperConfig({ HYPER_API_KEY: "sk-test" }, undefined);
    expect(fromDefault?.model).toBe("deepseek-v4-flash");
  });

  it("toHyperCredentials builds an api-key credential with the resolved baseURL", () => {
    const cfg = resolveHyperConfig({ HYPER_API_KEY: "sk-test" }, undefined);
    expect(cfg).not.toBeNull();
    if (!cfg) return; // narrows without a non-null assertion
    expect(toHyperCredentials(cfg)).toEqual({
      type: "api-key",
      apiKey: "sk-test",
      baseURL: "https://hyper.charm.land/v1",
    });
  });
});
