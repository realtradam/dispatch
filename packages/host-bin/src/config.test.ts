import { resolve } from "node:path";
import { OPENCODE_CREDENTIAL_CONFIG_KEY } from "@dispatch/provider-openai-compat";
import { describe, expect, it } from "vitest";
import { configMapToAccess, envToConfigMap, openCodeEnvDefaults } from "./config.js";

describe("envToConfigMap", () => {
  it("maps the single unnumbered OPENCODE_API_KEY into opencode.credential", () => {
    const result = envToConfigMap({ OPENCODE_API_KEY: "sk-one" });
    const cred = result[OPENCODE_CREDENTIAL_CONFIG_KEY] as { apiKey: string };
    expect(cred.apiKey).toBe("sk-one");
  });

  it("uses DISPATCH_BASE_URL / DISPATCH_MODEL as the credential's base URL / model", () => {
    const result = envToConfigMap({
      DISPATCH_BASE_URL: "https://custom.example/v1",
      DISPATCH_MODEL: "my-model",
      OPENCODE_API_KEY: "sk-one",
    });
    expect(result[OPENCODE_CREDENTIAL_CONFIG_KEY]).toEqual({
      apiKey: "sk-one",
      baseURL: "https://custom.example/v1",
      model: "my-model",
    });
  });

  it("does NOT set opencode.credential when no key is present", () => {
    const result = envToConfigMap({ HOME: "/root" });
    expect(result[OPENCODE_CREDENTIAL_CONFIG_KEY]).toBeUndefined();
    expect(
      envToConfigMap({ OPENCODE_API_KEY: "" })[OPENCODE_CREDENTIAL_CONFIG_KEY],
    ).toBeUndefined();
  });

  it("fails deterministically on the legacy DISPATCH_API_KEY (never silently ignored)", () => {
    expect(() =>
      envToConfigMap({
        DISPATCH_API_KEY: "sk-legacy",
        DISPATCH_BASE_URL: "https://oc/v1",
        DISPATCH_MODEL: "deepseek-v4-flash",
      }),
    ).toThrow(/DISPATCH_API_KEY/);
  });

  it("still boots with obsolete numbered OPENCODE_API_KEY_<n> present (ignored, never a fallback)", () => {
    // A stale numbered key must not stop the boot — and must not configure OpenCode.
    const stale = envToConfigMap({ OPENCODE_API_KEY_1: "sk-stale", OPENCODE_API_KEY_2: "sk-2" });
    expect(stale[OPENCODE_CREDENTIAL_CONFIG_KEY]).toBeUndefined();

    const both = envToConfigMap({ OPENCODE_API_KEY: "sk-current", OPENCODE_API_KEY_1: "sk-stale" });
    expect((both[OPENCODE_CREDENTIAL_CONFIG_KEY] as { apiKey: string }).apiKey).toBe("sk-current");
  });

  it("aborts config assembly with a secret-free error (no secret leaked in message)", () => {
    let message = "";
    try {
      envToConfigMap({
        DISPATCH_API_KEY: "top-secret-legacy-value",
        OPENCODE_API_KEY: "top-secret-current-value",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/DISPATCH_API_KEY/);
    expect(message).not.toContain("top-secret");
  });

  it("maps DISPATCH_OPENAI_MODEL to provider.openai.model", () => {
    const result = envToConfigMap({ DISPATCH_OPENAI_MODEL: "gpt-5-codex" });
    expect(result["provider.openai.model"]).toBe("gpt-5-codex");
  });

  it("maps DISPATCH_CODEX_CREDENTIAL_KEY to codex.credentialKey", () => {
    const result = envToConfigMap({ DISPATCH_CODEX_CREDENTIAL_KEY: "codex-oauth" });
    expect(result["codex.credentialKey"]).toBe("codex-oauth");
  });

  it("maps the external OpenAI/Codex pair together", () => {
    const result = envToConfigMap({
      DISPATCH_OPENAI_MODEL: "gpt-5-codex",
      DISPATCH_CODEX_CREDENTIAL_KEY: "codex-oauth",
    });
    expect(result).toEqual({
      "provider.openai.model": "gpt-5-codex",
      "codex.credentialKey": "codex-oauth",
      "vision.imageDir": resolve(".dispatch-data/images"),
    });
  });

  it("defaults images to the development data directory", () => {
    const result = envToConfigMap({ HOME: "/home/user", PATH: "/usr/bin" });
    expect(result).toEqual({ "vision.imageDir": resolve(".dispatch-data/images") });
  });

  it("maps SURFACE_WS_PORT to surfaceWsPort", () => {
    const result = envToConfigMap({ SURFACE_WS_PORT: "24206" });
    expect(result.surfaceWsPort).toBe(24206);
  });

  it("ignores a non-numeric SURFACE_WS_PORT", () => {
    const result = envToConfigMap({ SURFACE_WS_PORT: "abc" });
    expect(result.surfaceWsPort).toBeUndefined();
  });

  it("ignores a non-positive SURFACE_WS_PORT", () => {
    const result = envToConfigMap({ SURFACE_WS_PORT: "0" });
    expect(result.surfaceWsPort).toBeUndefined();
  });

  it("omits surfaceWsPort when SURFACE_WS_PORT is unset", () => {
    const result = envToConfigMap({});
    expect(result.surfaceWsPort).toBeUndefined();
  });
});

describe("configMapToAccess", () => {
  it("returns value for existing key", () => {
    const access = configMapToAccess({ "opencode.credential": { model: "m" } });
    expect(access.get("opencode.credential")).toEqual({ model: "m" });
  });

  it("returns undefined for missing key", () => {
    const access = configMapToAccess({});
    expect(access.get("nonexistent")).toBeUndefined();
  });

  it("returns typed value", () => {
    const access = configMapToAccess({ "some.number": 42 });
    expect(access.get<number>("some.number")).toBe(42);
  });

  it("getAll returns the full map", () => {
    const map = { a: 1, b: "two" };
    const access = configMapToAccess(map);
    expect(access.getAll()).toEqual(map);
  });
});

it("derives durable images beside the DB, with explicit overrides and zero retention", () => {
  expect(envToConfigMap({ DISPATCH_DB: "/tmp/custom/db.sqlite" })["vision.imageDir"]).toBe(
    "/tmp/custom/images",
  );
  expect(
    envToConfigMap({ DISPATCH_IMAGE_DIR: "/tmp/override", DISPATCH_IMAGE_RETENTION_DAYS: "0" }),
  ).toMatchObject({ "vision.imageDir": "/tmp/override", "vision.imageRetentionDays": 0 });
  for (const value of ["", "-1", "NaN", "Infinity"])
    expect(() => envToConfigMap({ DISPATCH_IMAGE_RETENTION_DAYS: value })).toThrow(
      "DISPATCH_IMAGE_RETENTION_DAYS",
    );
});

it("resolves relative image overrides and DB paths once at boot", () => {
  expect(envToConfigMap({ DISPATCH_IMAGE_DIR: "relative-images" })["vision.imageDir"]).toBe(
    resolve("relative-images"),
  );
  expect(envToConfigMap({ DISPATCH_DB: "relative-data/dispatch.db" })["vision.imageDir"]).toBe(
    resolve("relative-data/images"),
  );
});

it("exposes Inco config settings and aliases without exposing the key", () => {
  const access = configMapToAccess(
    envToConfigMap({
      INCO_BASE_URL: "https://inco.example/v1",
      INCO_MODEL: "glm-5.3-flash:fast",
      INCO_API_KEY: "fixture-key",
    }),
  );
  expect(access.get("provider.inco.baseURL")).toBe("https://inco.example/v1");
  expect(access.get("INCO_BASE_URL")).toBe("https://inco.example/v1");
  expect(access.get("provider.inco.model")).toBe("glm-5.3-flash:fast");
  expect(access.get("INCO_MODEL")).toBe("glm-5.3-flash:fast");
  expect(access.get("INCO_API_KEY")).toBeUndefined();
  expect(envToConfigMap({})["provider.inco.model"]).toBeUndefined();
});

describe("openCodeEnvDefaults", () => {
  it("returns only the overrides that are set", () => {
    expect(openCodeEnvDefaults({})).toEqual({});
    expect(openCodeEnvDefaults({ DISPATCH_MODEL: "m" })).toEqual({ model: "m" });
    expect(openCodeEnvDefaults({ DISPATCH_BASE_URL: "https://x/v1", DISPATCH_MODEL: "m" })).toEqual(
      {
        baseURL: "https://x/v1",
        model: "m",
      },
    );
  });
});
