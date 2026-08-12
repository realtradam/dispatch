import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_BASE_URL,
  DEFAULT_OPENCODE_MODEL,
  hasNumberedOpenCodeCredentials,
  parseNumberedOpenCodeEnv,
} from "./opencode-config.js";

describe("parseNumberedOpenCodeEnv", () => {
  it("discovers numbered keys and sorts them numerically (gaps allowed)", () => {
    const env = {
      OPENCODE_API_KEY_10: "sk-10",
      OPENCODE_API_KEY_1: "sk-1",
      OPENCODE_API_KEY_2: "sk-2",
    };
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv(env);
    expect(credentials.map((c) => c.number)).toEqual([1, 2, 10]);
    expect(credentials.map((c) => c.apiKey)).toEqual(["sk-1", "sk-2", "sk-10"]);
    expect(diagnostics).toEqual([]);
  });

  it("preserves gaps between numbers", () => {
    const env = {
      OPENCODE_API_KEY_1: "sk-1",
      OPENCODE_API_KEY_3: "sk-3",
    };
    const { credentials } = parseNumberedOpenCodeEnv(env);
    expect(credentials.map((c) => c.number)).toEqual([1, 3]);
  });

  it("applies shared baseURL + model defaults to every numbered credential", () => {
    const { credentials } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_2: "sk-2",
    });
    expect(credentials[0]).toMatchObject({
      number: 2,
      baseURL: DEFAULT_OPENCODE_BASE_URL,
      model: DEFAULT_OPENCODE_MODEL,
    });
  });

  it("allows overriding the shared baseURL + model", () => {
    const { credentials } = parseNumberedOpenCodeEnv(
      { OPENCODE_API_KEY_1: "sk-1" },
      { baseURL: "https://custom.example/v1", model: "my-model" },
    );
    expect(credentials[0]).toMatchObject({
      baseURL: "https://custom.example/v1",
      model: "my-model",
    });
  });

  it("rejects a zero suffix", () => {
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_0: "sk-0",
    });
    expect(credentials).toEqual([]);
    expect(diagnostics).toContainEqual({
      key: "OPENCODE_API_KEY_0",
      issue: "zero",
    });
  });

  it("rejects noncanonical suffixes (leading zeros)", () => {
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_01: "sk-01",
    });
    expect(credentials).toEqual([]);
    expect(diagnostics).toContainEqual({
      key: "OPENCODE_API_KEY_01",
      issue: "noncanonical",
    });
  });

  it("ignores non-digit suffixes (not OpenCode keys at all)", () => {
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_foo: "sk-foo",
      OPENCODE_API_KEY_1a: "sk-1a",
    });
    expect(credentials).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("rejects trailing-dot/dash/space suffixes (not all-digits)", () => {
    const env: Record<string, string> = {
      "OPENCODE_API_KEY_1 ": "sk",
      OPENCODE_API_KEY_n: "sk",
    };
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv(env);
    expect(credentials).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("rejects empty values", () => {
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_1: "",
      OPENCODE_API_KEY_2: undefined,
    });
    expect(credentials).toEqual([]);
    expect(diagnostics).toEqual([
      { key: "OPENCODE_API_KEY_1", issue: "empty" },
      { key: "OPENCODE_API_KEY_2", issue: "empty" },
    ]);
  });

  it("rejects a whitespace-only value as non-empty (kept as-is, never a secret leak)", () => {
    // A whitespace-only value is technically non-empty; we keep it as-is rather
    // than normalizing/trimming (which could alter a real secret's whitespace).
    const { credentials } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_1: "   ",
    });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.apiKey).toBe("   ");
  });

  it("detects duplicate secret values WITHOUT exposing them, keeping the first", () => {
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_1: "shared-secret",
      OPENCODE_API_KEY_2: "shared-secret",
    });
    // First numbered occurrence is kept; the duplicate numbered entry is dropped.
    expect(credentials.map((c) => c.number)).toEqual([1]);
    expect(credentials.some((c) => c.apiKey === "shared-secret")).toBe(true);
    expect(diagnostics).toEqual([
      { key: "OPENCODE_API_KEY_2", issue: "duplicate", duplicateOf: 1 },
    ]);
    // Never leak the secret value itself in diagnostics.
    const serialized = JSON.stringify(diagnostics);
    expect(serialized.includes("shared-secret")).toBe(false);
  });

  it("diagnostics never contain any secret value", () => {
    const { diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY_2: "shh-very-secret",
      OPENCODE_API_KEY_1: "",
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized.includes("shh-very-secret")).toBe(false);
  });

  it("returns empty credentials when no numbered keys exist", () => {
    const env = { PATH: "/bin", HOME: "/root" };
    const result = parseNumberedOpenCodeEnv(env);
    expect(result.credentials).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores the obsolete unnumbered OPENCODE_API_KEY entirely", () => {
    const { credentials, diagnostics } = parseNumberedOpenCodeEnv({
      OPENCODE_API_KEY: "sk-unnumbered",
    });
    expect(credentials).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("collides with legacy DISPATCH_API_KEY: it is completely ignored", () => {
    const { credentials } = parseNumberedOpenCodeEnv({
      DISPATCH_API_KEY: "sk-legacy",
      DISPATCH_BASE_URL: "https://x",
      DISPATCH_MODEL: "m",
    });
    expect(credentials).toEqual([]);
  });
});

describe("hasNumberedOpenCodeCredentials", () => {
  it("true when at least one valid numbered key exists", () => {
    expect(hasNumberedOpenCodeCredentials({ OPENCODE_API_KEY_1: "sk-1" })).toBe(true);
  });

  it("false when only malformed/zero/empty/legacy keys exist", () => {
    expect(
      hasNumberedOpenCodeCredentials({ OPENCODE_API_KEY_0: "sk", DISPATCH_API_KEY: "x" }),
    ).toBe(false);
    expect(hasNumberedOpenCodeCredentials({})).toBe(false);
  });
});
