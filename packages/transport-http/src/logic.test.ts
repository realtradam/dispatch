import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  computeExpectedCacheRate,
  isLocalImageRequestError,
  isModelParseError,
  isParseError,
  isReasoningEffortParseError,
  isSinceSeqError,
  isValidNamedAgentSelectionSnapshot,
  isValidReasoningEffort,
  isWindowParamError,
  mapCreateError,
  mapUpdateError,
  matchesImageMagicBytes,
  parseChatBody,
  parseLocalImageRequest,
  parseModelBody,
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
    const result = parseChatBody({ message: "hi", model: "opencode-1/m1" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.model).toBe("opencode-1/m1");
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

  // ── title ────────────────────────────────────────────────────────────────

  it("extracts title when present", () => {
    const result = parseChatBody({ message: "hi", title: "My Task" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.title).toBe("My Task");
    }
  });

  it("trims title whitespace", () => {
    const result = parseChatBody({ message: "hi", title: "  spaced title  " }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.title).toBe("spaced title");
    }
  });

  it("omits title when absent (backward compatible)", () => {
    const result = parseChatBody({ message: "hi" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.title).toBeUndefined();
    }
  });

  it("omits title when whitespace-only (treated as absent)", () => {
    const result = parseChatBody({ message: "hi", title: "    " }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.title).toBeUndefined();
    }
  });

  it("omits title when empty string (treated as absent)", () => {
    const result = parseChatBody({ message: "hi", title: "" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.title).toBeUndefined();
    }
  });

  it("returns error when title is not a string", () => {
    const result = parseChatBody({ message: "hi", title: 42 }, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("title");
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

// ─── Named Agent snapshot validation + error mapping ─────────────────────────

describe("isValidNamedAgentSelectionSnapshot", () => {
  it("accepts a conforming snapshot", () => {
    expect(
      isValidNamedAgentSelectionSnapshot({
        namedAgentId: "na-1",
        namedAgentName: "Coding Agent",
        model: "umans/umans-glm-5.2",
      }),
    ).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isValidNamedAgentSelectionSnapshot(null)).toBe(false);
    expect(isValidNamedAgentSelectionSnapshot("x")).toBe(false);
    expect(isValidNamedAgentSelectionSnapshot(42)).toBe(false);
  });

  it("rejects an empty namedAgentId", () => {
    expect(
      isValidNamedAgentSelectionSnapshot({
        namedAgentId: "",
        namedAgentName: "Coding",
        model: "umans/umans-glm-5.2",
      }),
    ).toBe(false);
  });

  it("rejects an empty model", () => {
    expect(
      isValidNamedAgentSelectionSnapshot({
        namedAgentId: "na-1",
        namedAgentName: "Coding",
        model: "",
      }),
    ).toBe(false);
  });

  it("rejects non-string fields", () => {
    expect(
      isValidNamedAgentSelectionSnapshot({
        namedAgentId: 42,
        namedAgentName: "Coding",
        model: "umans/umans-glm-5.2",
      }),
    ).toBe(false);
  });
});

describe("parseChatBody — namedAgent", () => {
  const fakeId = () => "test-uuid";

  it("extracts a valid namedAgent snapshot", () => {
    const result = parseChatBody(
      {
        message: "hi",
        namedAgent: { namedAgentId: "na-1", namedAgentName: "Coding", model: "umans/m" },
      },
      fakeId,
    );
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.namedAgent).toEqual({
        namedAgentId: "na-1",
        namedAgentName: "Coding",
        model: "umans/m",
      });
    }
  });

  it("omits namedAgent when absent (backward compatible)", () => {
    const result = parseChatBody({ message: "hi" }, fakeId);
    expect(isParseError(result)).toBe(false);
    if (!isParseError(result)) {
      expect(result.namedAgent).toBeUndefined();
    }
  });

  it("returns an error for a malformed namedAgent", () => {
    const result = parseChatBody({ message: "hi", namedAgent: { namedAgentId: "x" } }, fakeId);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("namedAgent");
    }
  });
});

describe("parseModelBody — namedAgent", () => {
  it("returns model and namedAgent when both present", () => {
    const result = parseModelBody({
      model: "umans/umans-glm-5.2",
      namedAgent: { namedAgentId: "na-1", namedAgentName: "Coding", model: "umans/umans-glm-5.2" },
    });
    expect(isModelParseError(result)).toBe(false);
    if (!isModelParseError(result)) {
      expect(result.model).toBe("umans/umans-glm-5.2");
      expect(result.namedAgent).toEqual({
        namedAgentId: "na-1",
        namedAgentName: "Coding",
        model: "umans/umans-glm-5.2",
      });
    }
  });

  it("returns model without namedAgent when absent", () => {
    const result = parseModelBody({ model: "umans/umans-glm-5.2" });
    expect(isModelParseError(result)).toBe(false);
    if (!isModelParseError(result)) {
      expect(result.model).toBe("umans/umans-glm-5.2");
      expect(result.namedAgent).toBeUndefined();
    }
  });

  it("accepts model: null without namedAgent", () => {
    const result = parseModelBody({ model: null });
    expect(isModelParseError(result)).toBe(false);
    if (!isModelParseError(result)) {
      expect(result.model).toBeNull();
      expect(result.namedAgent).toBeUndefined();
    }
  });

  it("returns an error for a malformed namedAgent", () => {
    const result = parseModelBody({ model: "umans/m", namedAgent: { namedAgentId: "" } });
    expect(isModelParseError(result)).toBe(true);
  });

  it("returns an error when model is missing", () => {
    const result = parseModelBody({
      namedAgent: { namedAgentId: "na-1", namedAgentName: "Coding", model: "umans/m" },
    });
    expect(isModelParseError(result)).toBe(true);
  });
});

describe("mapCreateError / mapUpdateError", () => {
  it("maps duplicate-name to 409", () => {
    expect(mapCreateError("duplicate-name").status).toBe(409);
    expect(mapUpdateError("duplicate-name").status).toBe(409);
  });

  it("maps invalid-name to 400", () => {
    expect(mapCreateError("invalid-name").status).toBe(400);
    expect(mapUpdateError("invalid-name").status).toBe(400);
  });

  it("maps invalid-model to 400", () => {
    expect(mapCreateError("invalid-model").status).toBe(400);
    expect(mapUpdateError("invalid-model").status).toBe(400);
  });

  it("maps not-found to 404 (update only)", () => {
    expect(mapUpdateError("not-found").status).toBe(404);
  });

  it("returns a non-empty message for every error", () => {
    for (const e of ["duplicate-name", "invalid-name", "invalid-model"] as const) {
      expect(mapCreateError(e).message.length).toBeGreaterThan(0);
    }
    for (const e of ["duplicate-name", "invalid-name", "invalid-model", "not-found"] as const) {
      expect(mapUpdateError(e).message.length).toBeGreaterThan(0);
    }
  });
});

describe("parseLocalImageRequest", () => {
  const home = "/home/tester";

  it("accepts every whitelisted raster extension with its MIME type", () => {
    const expected: readonly (readonly [string, string])[] = [
      [".png", "image/png"],
      [".jpg", "image/jpeg"],
      [".jpeg", "image/jpeg"],
      [".webp", "image/webp"],
      [".gif", "image/gif"],
      [".bmp", "image/bmp"],
    ];
    for (const [ext, mime] of expected) {
      const result = parseLocalImageRequest(`/tmp/pic${ext}`, home);
      if (isLocalImageRequestError(result)) throw new Error(result.error);
      expect(result.extension).toBe(ext);
      expect(result.mime).toBe(mime);
      expect(result.path).toBe(`/tmp/pic${ext}`);
    }
  });

  it("lowercases the extension before the whitelist lookup", () => {
    const result = parseLocalImageRequest("/tmp/PIC.PNG", home);
    if (isLocalImageRequestError(result)) throw new Error(result.error);
    expect(result.extension).toBe(".png");
    expect(result.mime).toBe("image/png");
  });

  it("expands a leading ~ to the home directory", () => {
    const result = parseLocalImageRequest("~/pics/a.png", home);
    if (isLocalImageRequestError(result)) throw new Error(result.error);
    expect(result.path).toBe("/home/tester/pics/a.png");
  });

  it("leaves non-leading ~ untouched", () => {
    const result = parseLocalImageRequest("/tmp/~a.png", home);
    if (isLocalImageRequestError(result)) throw new Error(result.error);
    expect(result.path).toBe("/tmp/~a.png");
  });

  it("rejects a relative path (after ~ expansion)", () => {
    for (const raw of ["pic.png", "./pic.png", "../pic.png"]) {
      const result = parseLocalImageRequest(raw, home);
      expect(isLocalImageRequestError(result)).toBe(true);
    }
  });

  it("rejects a missing or empty path", () => {
    for (const raw of [undefined, ""]) {
      const result = parseLocalImageRequest(raw, home);
      expect(isLocalImageRequestError(result)).toBe(true);
    }
  });

  it("rejects non-image extensions, including SVG", () => {
    for (const raw of ["/tmp/notes.txt", "/tmp/evil.svg", "/tmp/page.html", "/tmp/noext"]) {
      const result = parseLocalImageRequest(raw, home);
      expect(isLocalImageRequestError(result)).toBe(true);
    }
  });
});

describe("matchesImageMagicBytes", () => {
  const TextBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("accepts each format's real header", () => {
    expect(
      matchesImageMagicBytes(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ".png",
      ),
    ).toBe(true);
    expect(matchesImageMagicBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), ".jpg")).toBe(true);
    expect(matchesImageMagicBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]), ".jpeg")).toBe(true);
    expect(matchesImageMagicBytes(TextBytes("GIF89a"), ".gif")).toBe(true);
    expect(matchesImageMagicBytes(TextBytes("BM6\0\0\0"), ".bmp")).toBe(true);
    expect(
      matchesImageMagicBytes(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        ".webp",
      ),
    ).toBe(true);
  });

  it("rejects a non-image header for every declared format", () => {
    const text = TextBytes("plain text, definitely not an image");
    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]) {
      expect(matchesImageMagicBytes(text, ext)).toBe(false);
    }
  });

  it("rejects a header that belongs to a different image format", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(matchesImageMagicBytes(png, ".jpg")).toBe(false);
    expect(matchesImageMagicBytes(png, ".gif")).toBe(false);
    expect(matchesImageMagicBytes(png, ".webp")).toBe(false);
  });

  it("rejects truncated headers", () => {
    expect(matchesImageMagicBytes(new Uint8Array([0x89, 0x50]), ".png")).toBe(false);
    expect(matchesImageMagicBytes(new Uint8Array([0xff, 0xd8]), ".jpg")).toBe(false);
    expect(matchesImageMagicBytes(TextBytes("GIF"), ".gif")).toBe(false);
    expect(matchesImageMagicBytes(new Uint8Array([0x42]), ".bmp")).toBe(false);
    expect(
      matchesImageMagicBytes(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42]),
        ".webp",
      ),
    ).toBe(false);
  });

  it("rejects a RIFF container that is not WEBP", () => {
    expect(matchesImageMagicBytes(TextBytes("RIFFxxxxWAVE"), ".webp")).toBe(false);
  });

  it("rejects an unknown extension", () => {
    expect(matchesImageMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), ".svg")).toBe(false);
  });
});
