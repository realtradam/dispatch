import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	computeExpectedCacheRate,
	isParseError,
	isSinceSeqError,
	isWindowParamError,
	parseChatBody,
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
