import { describe, expect, it } from "vitest";
import { isValidConversationId, parseConversationId } from "./index.js";

describe("conversation ID contract", () => {
  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "mcp-test-001",
    "A_0-z",
    "a".repeat(128),
  ])("accepts %s unchanged", (raw) => {
    expect(parseConversationId(raw)).toBe(raw);
    expect(isValidConversationId(raw)).toBe(true);
  });
  it.each([
    undefined,
    null,
    42,
    false,
    {},
    [],
    "",
    " ",
    "a\n",
    "../tmp",
    "a/b",
    "a\\b",
    "%2f",
    "a:b",
    "a.b",
    "é",
    "a".repeat(129),
  ])("rejects %j without coercion or normalization", (raw) => {
    expect(parseConversationId(raw)).toEqual({ error: expect.stringContaining("conversationId") });
    expect(isValidConversationId(raw)).toBe(false);
  });
});
