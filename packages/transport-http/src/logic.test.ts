import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { isParseError, parseChatBody, serializeEventLine } from "./logic.js";

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
