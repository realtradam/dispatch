import { describe, expect, it } from "vitest";
import { resolveSystalyzeConfig, toSystalyzeCredentials } from "./resolver.js";

describe("resolveSystalyzeConfig", () => {
  it("returns null when no key is set", () => {
    expect(resolveSystalyzeConfig({}, undefined)).toBeNull();
  });

  it("returns null when SYSTALYZE_API_KEY is an empty string", () => {
    expect(resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "" }, undefined)).toBeNull();
  });

  it("returns null when both key variables are empty strings", () => {
    expect(
      resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "", STLZ_API_KEY: "" }, undefined),
    ).toBeNull();
  });

  it("accepts the vendor's documented STLZ_API_KEY alias", () => {
    const cfg = resolveSystalyzeConfig({ STLZ_API_KEY: "stlzi_alias" }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("stlzi_alias");
  });

  it("prefers SYSTALYZE_API_KEY over the STLZ_API_KEY alias", () => {
    const cfg = resolveSystalyzeConfig(
      { SYSTALYZE_API_KEY: "primary", STLZ_API_KEY: "alias" },
      undefined,
    );
    expect(cfg?.apiKey).toBe("primary");
  });

  it("falls back to the alias when SYSTALYZE_API_KEY is empty", () => {
    const cfg = resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "", STLZ_API_KEY: "alias" }, undefined);
    expect(cfg?.apiKey).toBe("alias");
  });

  it("uses the default base URL when SYSTALYZE_BASE_URL is absent", () => {
    const cfg = resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "k" }, undefined);
    expect(cfg?.baseURL).toBe("https://inference.systalyze.com/v1");
  });

  it("uses SYSTALYZE_BASE_URL override when set", () => {
    const cfg = resolveSystalyzeConfig(
      { SYSTALYZE_API_KEY: "k", SYSTALYZE_BASE_URL: "https://custom.example.com/v1" },
      undefined,
    );
    expect(cfg?.baseURL).toBe("https://custom.example.com/v1");
  });

  it("does not validate the key by a documented prefix", () => {
    // Only a non-empty value is required — future key formats stay valid.
    const cfg = resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "some-future-format" }, undefined);
    expect(cfg?.apiKey).toBe("some-future-format");
  });

  it("model precedence: host config wins, then SYSTALYZE_MODEL, then default", () => {
    const fromConfig = resolveSystalyzeConfig(
      { SYSTALYZE_API_KEY: "k", SYSTALYZE_MODEL: "env-model" },
      "config-model",
    );
    expect(fromConfig?.model).toBe("config-model");

    const fromEnv = resolveSystalyzeConfig(
      { SYSTALYZE_API_KEY: "k", SYSTALYZE_MODEL: "env-model" },
      undefined,
    );
    expect(fromEnv?.model).toBe("env-model");

    const fromDefault = resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "k" }, undefined);
    expect(fromDefault?.model).toBe("moonshotai/Kimi-K3");
  });

  it("toSystalyzeCredentials builds an api-key credential with the resolved baseURL", () => {
    const cfg = resolveSystalyzeConfig({ SYSTALYZE_API_KEY: "k" }, undefined);
    expect(cfg).not.toBeNull();
    if (!cfg) return; // narrows without a non-null assertion
    expect(toSystalyzeCredentials(cfg)).toEqual({
      type: "api-key",
      apiKey: "k",
      baseURL: "https://inference.systalyze.com/v1",
    });
  });
});
