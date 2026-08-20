import type { NamedAgent } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import {
  isDuplicateName,
  isValidCanonicalModel,
  isValidName,
  normalizeName,
  parseRecord,
  recordKey,
  serializeRecord,
} from "./pure.js";

describe("normalizeName", () => {
  it("trims leading/trailing whitespace", () => {
    expect(normalizeName("  Coding Agent  ")).toBe("Coding Agent");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(normalizeName("Coding   Agent\tAgent")).toBe("Coding Agent Agent");
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("isValidName", () => {
  it("accepts a non-empty name", () => {
    expect(isValidName("Coding Agent")).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(isValidName("")).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(isValidName("   ")).toBe(false);
  });

  it("accepts a name that is non-empty after trim", () => {
    expect(isValidName("  x  ")).toBe(true);
  });
});

describe("isValidCanonicalModel", () => {
  it("accepts a provider/model identifier", () => {
    expect(isValidCanonicalModel("opencode-1/claude-sonnet-4.5")).toBe(true);
    expect(isValidCanonicalModel("umans/umans-glm-5.2")).toBe(true);
  });

  it("rejects a model with no slash", () => {
    expect(isValidCanonicalModel("claude-sonnet-4.5")).toBe(false);
  });

  it("rejects an empty provider", () => {
    expect(isValidCanonicalModel("/claude-sonnet-4.5")).toBe(false);
  });

  it("rejects an empty model", () => {
    expect(isValidCanonicalModel("opencode-1/")).toBe(false);
  });

  it("rejects leading/trailing whitespace", () => {
    expect(isValidCanonicalModel(" opencode-1/claude-sonnet-4.5")).toBe(false);
    expect(isValidCanonicalModel("opencode-1/claude-sonnet-4.5 ")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidCanonicalModel("")).toBe(false);
  });

  it("accepts at least one slash with both sides non-empty", () => {
    expect(isValidCanonicalModel("a/b/c")).toBe(true);
  });
});

describe("isDuplicateName", () => {
  const existing: readonly NamedAgent[] = [
    { id: "1", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    { id: "2", name: "Research Agent", model: "umans/umans-glm-5.2" },
  ];

  it("detects an exact match", () => {
    expect(isDuplicateName(existing, "Coding Agent")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDuplicateName(existing, "coding agent")).toBe(true);
    expect(isDuplicateName(existing, "CODING AGENT")).toBe(true);
  });

  it("normalizes whitespace before comparing", () => {
    expect(isDuplicateName(existing, "  Coding   Agent ")).toBe(true);
  });

  it("returns false for a new name", () => {
    expect(isDuplicateName(existing, "Fast Agent")).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(isDuplicateName([], "Anything")).toBe(false);
  });
});

describe("record serialization", () => {
  it("round-trips a NamedAgent through serialize/parse", () => {
    const agent: NamedAgent = { id: "id-1", name: "Coding Agent", model: "opencode-1/x" };
    const raw = serializeRecord(agent);
    expect(parseRecord(raw)).toEqual(agent);
  });

  it("parseRecord returns null for malformed JSON", () => {
    expect(parseRecord("{not json")).toBeNull();
  });

  it("parseRecord returns null for a non-record shape", () => {
    expect(parseRecord(JSON.stringify({ id: "1" }))).toBeNull();
    expect(parseRecord(JSON.stringify({ id: 1, name: "x", model: "a/b" }))).toBeNull();
  });

  it("recordKey is prefixed", () => {
    expect(recordKey("id-1")).toBe("named-agent:id-1");
  });
});
