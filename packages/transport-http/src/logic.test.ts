import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	isParseError,
	isSinceSeqError,
	parseChatBody,
	parseSinceSeq,
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
