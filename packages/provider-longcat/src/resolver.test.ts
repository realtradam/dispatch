import { describe, expect, it } from "vitest";
import { resolveLongcatConfig, toLongcatCredentials } from "./resolver.js";

describe("resolveLongcatConfig", () => {
  it("activate uses LONGCAT_BASE_URL override when set (default otherwise)", () => {
    const override = resolveLongcatConfig(
      { LONGCAT_API_KEY: "sk-test", LONGCAT_BASE_URL: "https://custom.example.com/openai" },
      undefined,
    );
    expect(override?.baseURL).toBe("https://custom.example.com/openai");

    const fallback = resolveLongcatConfig({ LONGCAT_API_KEY: "sk-test" }, undefined);
    expect(fallback?.baseURL).toBe("https://api.longcat.chat/openai");
  });

  it('activate uses config provider.longcat.model → LONGCAT_MODEL → "LongCat-2.0" resolution', () => {
    // config wins over env + default
    const fromConfig = resolveLongcatConfig(
      { LONGCAT_API_KEY: "sk-test", LONGCAT_MODEL: "env-model" },
      "config-model",
    );
    expect(fromConfig?.model).toBe("config-model");

    // env wins when config is absent
    const fromEnv = resolveLongcatConfig(
      { LONGCAT_API_KEY: "sk-test", LONGCAT_MODEL: "env-model" },
      undefined,
    );
    expect(fromEnv?.model).toBe("env-model");

    // default when neither is set
    const fromDefault = resolveLongcatConfig({ LONGCAT_API_KEY: "sk-test" }, undefined);
    expect(fromDefault?.model).toBe("LongCat-2.0");
  });

  it("returns null when LONGCAT_API_KEY is unset", () => {
    expect(resolveLongcatConfig({}, undefined)).toBeNull();
  });

  it("returns null when LONGCAT_API_KEY is empty string", () => {
    expect(resolveLongcatConfig({ LONGCAT_API_KEY: "" }, undefined)).toBeNull();
  });

  it("toLongcatCredentials builds an api-key credential with the resolved baseURL", () => {
    const cfg = resolveLongcatConfig({ LONGCAT_API_KEY: "sk-test" }, undefined);
    expect(cfg).not.toBeNull();
    if (!cfg) return; // narrows without a non-null assertion
    expect(toLongcatCredentials(cfg)).toEqual({
      type: "api-key",
      apiKey: "sk-test",
      baseURL: "https://api.longcat.chat/openai",
    });
  });
});
