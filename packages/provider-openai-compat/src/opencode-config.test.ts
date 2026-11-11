import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_BASE_URL,
  DEFAULT_OPENCODE_MODEL,
  formatOpenCodeEnvDiagnostics,
  hasOpenCodeCredential,
  isFatalOpenCodeEnvDiagnostic,
  OPENCODE_PROVIDER_ID,
  parseOpenCodeEnv,
} from "./opencode-config.js";

describe("parseOpenCodeEnv", () => {
  it("reads the single unnumbered OPENCODE_API_KEY", () => {
    const { credential, diagnostics } = parseOpenCodeEnv({ OPENCODE_API_KEY: "sk-one" });
    expect(credential).toEqual({
      apiKey: "sk-one",
      baseURL: DEFAULT_OPENCODE_BASE_URL,
      model: DEFAULT_OPENCODE_MODEL,
    });
    expect(diagnostics).toEqual([]);
  });

  it("registers under the unnumbered provider id", () => {
    expect(OPENCODE_PROVIDER_ID).toBe("opencode");
  });

  it("honors caller-provided base URL/model defaults", () => {
    const { credential } = parseOpenCodeEnv(
      { OPENCODE_API_KEY: "sk-one" },
      { baseURL: "https://custom/v1", model: "custom-model" },
    );
    expect(credential).toEqual({
      apiKey: "sk-one",
      baseURL: "https://custom/v1",
      model: "custom-model",
    });
  });

  it("treats an unset or empty key as not configured (no diagnostic)", () => {
    expect(parseOpenCodeEnv({ PATH: "/bin", HOME: "/root" })).toEqual({
      credential: null,
      diagnostics: [],
    });
    expect(parseOpenCodeEnv({ OPENCODE_API_KEY: "" })).toEqual({
      credential: null,
      diagnostics: [],
    });
    expect(parseOpenCodeEnv({ OPENCODE_API_KEY: undefined })).toEqual({
      credential: null,
      diagnostics: [],
    });
  });

  it("keeps the key value exactly as given (never trimmed)", () => {
    // Trimming/normalizing could alter a real secret's whitespace.
    const { credential } = parseOpenCodeEnv({ OPENCODE_API_KEY: " sk-padded " });
    expect(credential?.apiKey).toBe(" sk-padded ");
  });

  it("ignores obsolete numbered keys with a legacy-numbered warning (never a fallback)", () => {
    const { credential, diagnostics } = parseOpenCodeEnv({
      OPENCODE_API_KEY_2: "sk-2",
      OPENCODE_API_KEY_1: "sk-1",
    });
    // A numbered key NEVER configures OpenCode.
    expect(credential).toBeNull();
    // Sorted by name — independent of env iteration order.
    expect(diagnostics).toEqual([
      { key: "OPENCODE_API_KEY_1", issue: "legacy-numbered" },
      { key: "OPENCODE_API_KEY_2", issue: "legacy-numbered" },
    ]);
    expect(diagnostics.some(isFatalOpenCodeEnvDiagnostic)).toBe(false);
  });

  it("flags any suffixed variant, canonical or not", () => {
    const { diagnostics } = parseOpenCodeEnv({
      OPENCODE_API_KEY_01: "sk",
      OPENCODE_API_KEY_foo: "sk",
    });
    expect(diagnostics).toEqual([
      { key: "OPENCODE_API_KEY_01", issue: "legacy-numbered" },
      { key: "OPENCODE_API_KEY_foo", issue: "legacy-numbered" },
    ]);
  });

  it("does not flag a numbered variable that is unset/empty (nothing configured)", () => {
    const { diagnostics } = parseOpenCodeEnv({
      OPENCODE_API_KEY_1: "",
      OPENCODE_API_KEY_2: undefined,
    });
    expect(diagnostics).toEqual([]);
  });

  it("uses the unnumbered key and still warns about leftover numbered ones", () => {
    const { credential, diagnostics } = parseOpenCodeEnv({
      OPENCODE_API_KEY: "sk-current",
      OPENCODE_API_KEY_1: "sk-stale",
    });
    expect(credential?.apiKey).toBe("sk-current");
    expect(diagnostics).toEqual([{ key: "OPENCODE_API_KEY_1", issue: "legacy-numbered" }]);
  });

  it("rejects the legacy DISPATCH_API_KEY as a FATAL legacy-dispatch (never ignored)", () => {
    const { credential, diagnostics } = parseOpenCodeEnv({
      DISPATCH_API_KEY: "sk-legacy",
      DISPATCH_BASE_URL: "https://x",
      DISPATCH_MODEL: "m",
    });
    expect(credential).toBeNull();
    expect(diagnostics).toEqual([{ key: "DISPATCH_API_KEY", issue: "legacy-dispatch" }]);
    expect(diagnostics.every(isFatalOpenCodeEnvDiagnostic)).toBe(true);
  });

  it("does not flag a legacy DISPATCH_API_KEY that is unset/empty", () => {
    const { credential, diagnostics } = parseOpenCodeEnv({
      DISPATCH_API_KEY: "",
      DISPATCH_BASE_URL: "https://x",
    });
    expect(credential).toBeNull();
    expect(diagnostics).toEqual([]);
  });

  it("flags the legacy DISPATCH_API_KEY even when a valid key exists", () => {
    const { credential, diagnostics } = parseOpenCodeEnv({
      DISPATCH_API_KEY: "sk-legacy",
      OPENCODE_API_KEY: "sk-one",
    });
    expect(credential?.apiKey).toBe("sk-one");
    expect(diagnostics).toContainEqual({ key: "DISPATCH_API_KEY", issue: "legacy-dispatch" });
  });

  it("diagnostics never contain any secret value", () => {
    const { diagnostics } = parseOpenCodeEnv({
      OPENCODE_API_KEY: "shh-current-secret",
      OPENCODE_API_KEY_2: "shh-numbered-secret",
      DISPATCH_API_KEY: "shh-legacy-secret",
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("shh-");
  });
});

describe("formatOpenCodeEnvDiagnostics", () => {
  it("returns null when there are no diagnostics", () => {
    expect(formatOpenCodeEnvDiagnostics([])).toBeNull();
  });

  it("renders every issue kind secret-free with the offending key name", () => {
    const msg = formatOpenCodeEnvDiagnostics([
      { key: "OPENCODE_API_KEY_3", issue: "legacy-numbered" },
      { key: "DISPATCH_API_KEY", issue: "legacy-dispatch" },
    ]);
    expect(msg).toContain("OPENCODE_API_KEY_3");
    expect(msg).toContain("ignored");
    expect(msg).toContain("DISPATCH_API_KEY");
    // Both point at the replacement variable.
    expect(msg?.match(/use OPENCODE_API_KEY instead/g)).toHaveLength(2);
  });

  it("never includes any secret value in the formatted output", () => {
    const result = parseOpenCodeEnv({
      OPENCODE_API_KEY_1: "SUPER-SECRET-AAAA",
      DISPATCH_API_KEY: "SUPER-SECRET-BBBB",
    });
    const msg = formatOpenCodeEnvDiagnostics(result.diagnostics) ?? "";
    expect(msg).not.toContain("SUPER-SECRET");
  });
});

describe("hasOpenCodeCredential", () => {
  it("true when the unnumbered key is set", () => {
    expect(hasOpenCodeCredential({ OPENCODE_API_KEY: "sk-one" })).toBe(true);
  });

  it("false when only obsolete/empty variables exist", () => {
    expect(hasOpenCodeCredential({ OPENCODE_API_KEY_1: "sk", DISPATCH_API_KEY: "x" })).toBe(false);
    expect(hasOpenCodeCredential({ OPENCODE_API_KEY: "" })).toBe(false);
    expect(hasOpenCodeCredential({})).toBe(false);
  });
});
