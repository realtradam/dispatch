import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  computeExpectedCacheRate,
  isParseError,
  isReasoningEffortParseError,
  isSinceSeqError,
  isValidReasoningEffort,
  isWindowParamError,
  parseChatBody,
  parseQueueBody,
  parseReasoningEffortBody,
  parseSinceSeq,
  parseWindowParam,
  serializeEventLine,
} from "./logic.js";

describe("parseChatBody", () => {
  const fakeId = () => "test-uuid";

  it("returns error for null body", () => {
    const result = parseChatBody(null, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("JSON object");
    }
  });

  it("returns error for non-object body", () => {
    const result = parseChatBody("hello", fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when message is missing", () => {
    const result = parseChatBody({ conversationId: "c1" }, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("message");
    }
  });

  it("returns error when message is empty string", () => {
    const result = parseChatBody({ message: "" }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when message is whitespace only", () => {
    const result = parseChatBody({ message: "   " }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when message is not a string", () => {
    const result = parseChatBody({ message: 42 }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("generates conversationId when absent", () => {
    const result = parseChatBody({ message: "hello" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.conversationId).toBe("test-uuid");
      expect(result.message).toBe("hello");
    }
  });

  it("generates conversationId when empty string", () => {
    const result = parseChatBody({ message: "hello", conversationId: "" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.conversationId).toBe("test-uuid");
    }
  });

  it("uses provided conversationId", () => {
    const result = parseChatBody({ message: "hello", conversationId: "my-conv" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.conversationId).toBe("my-conv");
    }
  });

  it("trims message whitespace", () => {
    const result = parseChatBody({ message: "  hello world  " }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.message).toBe("hello world");
    }
  });

  it("extracts model when present", () => {
    const result = parseChatBody({ message: "hi", model: "opencode/m1" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.model).toBe("opencode/m1");
    }
  });

  it("extracts cwd when present", () => {
    const result = parseChatBody({ message: "hi", cwd: "/tmp" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.cwd).toBe("/tmp");
    }
  });

  it("extracts both model and cwd", () => {
    const result = parseChatBody({ message: "hi", model: "openai/gpt-4", cwd: "/home" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.model).toBe("openai/gpt-4");
      expect(result.cwd).toBe("/home");
    }
  });

  it("omits model when absent", () => {
    const result = parseChatBody({ message: "hi" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.model).toBeUndefined();
    }
  });

  it("omits cwd when absent", () => {
    const result = parseChatBody({ message: "hi" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.cwd).toBeUndefined();
    }
  });

  it("returns error when model is not a string", () => {
    const result = parseChatBody({ message: "hi", model: 42 }, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("model");
    }
  });

  it("returns error when cwd is not a string", () => {
    const result = parseChatBody({ message: "hi", cwd: true }, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("cwd");
    }
  });

  it("extracts reasoningEffort when present and valid", () => {
    const result = parseChatBody({ message: "hi", reasoningEffort: "low" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.reasoningEffort).toBe("low");
    }
  });

  it("accepts all valid reasoningEffort levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const result = parseChatBody({ message: "hi", reasoningEffort: level }, fakeId);
      expect(isParseError(result)).toBe(false);
      if (!isParseError(result)) {
        expect(result.reasoningEffort).toBe(level);
      }
    }
  });

  it("returns error for invalid reasoningEffort", () => {
    const result = parseChatBody({ message: "hi", reasoningEffort: "banana" }, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("reasoningEffort");
    }
  });

  it("returns error for non-string reasoningEffort", () => {
    const result = parseChatBody({ message: "hi", reasoningEffort: 42 }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("omits reasoningEffort when absent", () => {
    const result = parseChatBody({ message: "hi" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.reasoningEffort).toBeUndefined();
    }
  });

  // ── images ──────────────────────────────────────────────────────────────

  it("parses images array with data URLs", () => {
    const result = parseChatBody(
      {
        message: "what is this?",
        images: [
          { url: "data:image/png;base64,aaa" },
          { url: "data:image/jpeg;base64,bbb", mimeType: "image/jpeg" },
        ],
      },
      fakeId,
    );
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.images).toHaveLength(2);
      expect(result.images?.[0]?.url).toBe("data:image/png;base64,aaa");
      expect(result.images?.[1]?.mimeType).toBe("image/jpeg");
    }
  });

  it("parses images with http URLs", () => {
    const result = parseChatBody(
      { message: "hi", images: [{ url: "https://example.com/x.png" }] },
      fakeId,
    );
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.images?.[0]?.url).toBe("https://example.com/x.png");
    }
  });

  it("returns error when images is not an array", () => {
    const result = parseChatBody({ message: "hi", images: "not-an-array" }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when an image lacks a url", () => {
    const result = parseChatBody({ message: "hi", images: [{ mimeType: "image/png" }] }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when an image url is empty", () => {
    const result = parseChatBody({ message: "hi", images: [{ url: "" }] }, fakeId);
    expect(isParseError(result)).toBe(true);
  });

  it("omits images when absent (backward compatible)", () => {
    const result = parseChatBody({ message: "hi" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.images).toBeUndefined();
    }
  });

  it("omits images when the array is empty", () => {
    const result = parseChatBody({ message: "hi", images: [] }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.images).toBeUndefined();
    }
  });
});

describe("parseSinceSeq", () => {
  it("returns 0 when undefined", () => {
    expect(parseSinceSeq(undefined)).toBe(0);
  });

  it("returns 0 when empty string", () => {
    expect(parseSinceSeq("")).toBe(0);
  });

  it("parses valid non-negative integer", () => {
    expect(parseSinceSeq("0")).toBe(0);
    expect(parseSinceSeq("5")).toBe(5);
    expect(parseSinceSeq("42")).toBe(42);
  });

  it("returns ParseError for non-integer string", () => {
    const result = parseSinceSeq("abc");
    expect(isSinceSeqError(result)).toBe(true);
    if (isSinceSeqError(result)) {
      expect(result.error).toContain("sinceSeq");
    }
  });

  it("returns ParseError for float", () => {
    const result = parseSinceSeq("3.14");
    expect(isSinceSeqError(result)).toBe(true);
  });

  it("returns ParseError for negative integer", () => {
    const result = parseSinceSeq("-1");
    expect(isSinceSeqError(result)).toBe(true);
  });
});

describe("parseWindowParam", () => {
  it("returns undefined (absent) when undefined", () => {
    expect(parseWindowParam(undefined, "limit")).toBeUndefined();
  });

  it("returns undefined (absent) when empty string", () => {
    expect(parseWindowParam("", "limit")).toBeUndefined();
  });

  it("parses a valid positive integer", () => {
    expect(parseWindowParam("1", "limit")).toBe(1);
    expect(parseWindowParam("42", "beforeSeq")).toBe(42);
  });

  it("returns ParseError for zero (store would treat it as absent)", () => {
    const result = parseWindowParam("0", "limit");
    expect(isWindowParamError(result)).toBe(true);
    if (isWindowParamError(result)) {
      expect(result.error).toContain("limit");
      expect(result.error).toContain("positive integer");
    }
  });

  it("returns ParseError for a negative integer", () => {
    expect(isWindowParamError(parseWindowParam("-1", "limit"))).toBe(true);
  });

  it("returns ParseError for a non-integer", () => {
    expect(isWindowParamError(parseWindowParam("1.5", "beforeSeq"))).toBe(true);
  });

  it("returns ParseError for a non-numeric string", () => {
    const result = parseWindowParam("abc", "beforeSeq");
    expect(isWindowParamError(result)).toBe(true);
    if (isWindowParamError(result)) {
      expect(result.error).toContain("beforeSeq");
    }
  });

  it("names the param in the error message", () => {
    const limit = parseWindowParam("0", "limit");
    const before = parseWindowParam("0", "beforeSeq");
    if (isWindowParamError(limit)) expect(limit.error).toContain("limit");
    if (isWindowParamError(before)) expect(before.error).toContain("beforeSeq");
  });

  it("isWindowParamError is false for absent and for a valid number", () => {
    expect(isWindowParamError(undefined)).toBe(false);
    expect(isWindowParamError(5)).toBe(false);
  });
});

describe("serializeEventLine", () => {
  it("serializes an event as JSON followed by newline", () => {
    const event: AgentEvent = {
      type: "text-delta",
      conversationId: "tab1",
      turnId: "turn1",
      delta: "hello",
    };
    const line = serializeEventLine(event);
    expect(line).toBe(`${JSON.stringify(event)}\n`);
  });

  it("serializes a done event", () => {
    const event: AgentEvent = {
      type: "done",
      conversationId: "tab1",
      turnId: "turn1",
      reason: "stop",
    };
    const line = serializeEventLine(event);
    const parsed = JSON.parse(line.trim());
    expect(parsed.type).toBe("done");
    expect(parsed.reason).toBe("stop");
  });
});

describe("computeExpectedCacheRate", () => {
  it("returns round(cacheRead/(cacheRead+cacheWrite)*100)", () => {
    expect(computeExpectedCacheRate(800, 200)).toBe(80);
  });

  it("returns 0 when cacheRead+cacheWrite is 0", () => {
    expect(computeExpectedCacheRate(0, 0)).toBe(0);
  });

  it("returns 100 when all tokens are cacheRead", () => {
    expect(computeExpectedCacheRate(500, 0)).toBe(100);
  });

  it("returns 0 when all tokens are cacheWrite", () => {
    expect(computeExpectedCacheRate(0, 500)).toBe(0);
  });

  it("rounds to nearest integer", () => {
    expect(computeExpectedCacheRate(1, 2)).toBe(33);
    expect(computeExpectedCacheRate(2, 1)).toBe(67);
  });
});

describe("isValidReasoningEffort", () => {
  it("returns true for all valid levels", () => {
    expect(isValidReasoningEffort("low")).toBe(true);
    expect(isValidReasoningEffort("medium")).toBe(true);
    expect(isValidReasoningEffort("high")).toBe(true);
    expect(isValidReasoningEffort("xhigh")).toBe(true);
    expect(isValidReasoningEffort("max")).toBe(true);
  });

  it("returns false for invalid strings", () => {
    expect(isValidReasoningEffort("banana")).toBe(false);
    expect(isValidReasoningEffort("")).toBe(false);
    expect(isValidReasoningEffort("LOW")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(isValidReasoningEffort(42)).toBe(false);
    expect(isValidReasoningEffort(null)).toBe(false);
    expect(isValidReasoningEffort(undefined)).toBe(false);
    expect(isValidReasoningEffort(true)).toBe(false);
  });
});

describe("parseReasoningEffortBody", () => {
  it("returns the level for a valid body", () => {
    expect(parseReasoningEffortBody({ reasoningEffort: "low" })).toBe("low");
    expect(parseReasoningEffortBody({ reasoningEffort: "max" })).toBe("max");
  });

  it("returns ParseError for missing reasoningEffort", () => {
    const result = parseReasoningEffortBody({});
    expect(isReasoningEffortParseError(result)).toBe(true);
    if (isReasoningEffortParseError(result)) {
      expect(result.error).toContain("reasoningEffort");
    }
  });

  it("returns ParseError for invalid level", () => {
    const result = parseReasoningEffortBody({ reasoningEffort: "banana" });
    expect(isReasoningEffortParseError(result)).toBe(true);
    if (isReasoningEffortParseError(result)) {
      expect(result.error).toContain("reasoningEffort");
    }
  });

  it("returns ParseError for non-object body", () => {
    expect(isReasoningEffortParseError(parseReasoningEffortBody(null))).toBe(true);
    expect(isReasoningEffortParseError(parseReasoningEffortBody("string"))).toBe(true);
  });
});

describe("parseQueueBody", () => {
  it("returns error for null body", () => {
    const result = parseQueueBody(null);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("JSON object");
    }
  });

  it("returns error for non-object body", () => {
    const result = parseQueueBody("hello");
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when text is missing", () => {
    const result = parseQueueBody({});
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("text");
    }
  });

  it("returns error when text is empty string", () => {
    const result = parseQueueBody({ text: "" });
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when text is whitespace only", () => {
    const result = parseQueueBody({ text: "   " });
    expect(isParseError(result)).toBe(true);
  });

  it("returns error when text is not a string", () => {
    const result = parseQueueBody({ text: 42 });
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("text");
    }
  });

  it("returns the trimmed text for a valid body", () => {
    const result = parseQueueBody({ text: "hello" });
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.text).toBe("hello");
    }
  });

  it("trims text whitespace", () => {
    const result = parseQueueBody({ text: "  hello world  " });
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.text).toBe("hello world");
    }
  });
});
