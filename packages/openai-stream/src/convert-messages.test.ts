import type { ChatMessage } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { convertMessages } from "./convert-messages.js";

describe("convertMessages", () => {
	it("converts a system message with text chunks", () => {
		const messages: ChatMessage[] = [
			{
				role: "system",
				chunks: [
					{ type: "system", text: "You are a helpful assistant." },
					{ type: "text", text: " Additional context." },
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([
			{ role: "system", content: "You are a helpful assistant. Additional context." },
		]);
	});

	it("converts a user message with text chunks", () => {
		const messages: ChatMessage[] = [
			{
				role: "user",
				chunks: [
					{ type: "text", text: "Hello, " },
					{ type: "text", text: "world!" },
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([{ role: "user", content: "Hello, world!" }]);
	});

	it("converts an assistant message with text only", () => {
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{ type: "text", text: "I can help " },
					{ type: "text", text: "with that." },
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([{ role: "assistant", content: "I can help with that." }]);
	});

	it("converts an assistant message with tool calls", () => {
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{ type: "text", text: "Let me check that." },
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "read_file",
						input: { path: "/src/main.ts" },
					},
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([
			{
				role: "assistant",
				content: "Let me check that.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "read_file",
							arguments: JSON.stringify({ path: "/src/main.ts" }),
						},
					},
				],
			},
		]);
	});

	it("converts an assistant message with tool calls but no text", () => {
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_2",
						toolName: "run_shell",
						input: { command: "ls" },
					},
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_2",
						type: "function",
						function: {
							name: "run_shell",
							arguments: JSON.stringify({ command: "ls" }),
						},
					},
				],
			},
		]);
	});

	it("converts tool result messages", () => {
		const messages: ChatMessage[] = [
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "read_file",
						content: "file contents here",
						isError: false,
					},
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([
			{
				role: "tool",
				content: "file contents here",
				tool_call_id: "call_1",
			},
		]);
	});

	it("converts a full multi-turn history with tool round-trip", () => {
		const messages: ChatMessage[] = [
			{
				role: "system",
				chunks: [{ type: "system", text: "You are helpful." }],
			},
			{
				role: "user",
				chunks: [{ type: "text", text: "Read main.ts" }],
			},
			{
				role: "assistant",
				chunks: [
					{ type: "text", text: "Sure." },
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "read_file",
						input: { path: "main.ts" },
					},
				],
			},
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "read_file",
						content: "console.log('hello')",
						isError: false,
					},
				],
			},
			{
				role: "assistant",
				chunks: [{ type: "text", text: "The file logs hello." }],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Read main.ts" },
			{
				role: "assistant",
				content: "Sure.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "read_file",
							arguments: JSON.stringify({ path: "main.ts" }),
						},
					},
				],
			},
			{
				role: "tool",
				content: "console.log('hello')",
				tool_call_id: "call_1",
			},
			{ role: "assistant", content: "The file logs hello." },
		]);
	});

	it("handles multiple tool results in one tool message", () => {
		const messages: ChatMessage[] = [
			{
				role: "tool",
				chunks: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "read_file",
						content: "file1",
						isError: false,
					},
					{
						type: "tool-result",
						toolCallId: "call_2",
						toolName: "read_file",
						content: "file2",
						isError: false,
					},
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([
			{ role: "tool", content: "file1", tool_call_id: "call_1" },
			{ role: "tool", content: "file2", tool_call_id: "call_2" },
		]);
	});

	it("includes thinking chunks in assistant content", () => {
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{ type: "thinking", text: "Let me think..." },
					{ type: "text", text: "Here is my answer." },
				],
			},
		];

		const result = convertMessages(messages);
		expect(result).toEqual([{ role: "assistant", content: "Let me think...Here is my answer." }]);
	});

	it("arguments is valid JSON when input is a malformed string", () => {
		// Production seq-134 shape: the model emitted broken JSON as the tool
		// arguments and it was stored verbatim. Unquoted key fails JSON.parse at
		// some column (position 1 here).
		const malformed = '{path: "/src/main.ts"}';
		expect(() => JSON.parse(malformed)).toThrow();

		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_bad",
						toolName: "read_file",
						input: malformed,
					},
				],
			},
		];

		const result = convertMessages(messages);
		const args = result[0]?.tool_calls?.[0]?.function.arguments;
		expect(args).toBeDefined();
		// The output MUST parse without throwing — the provider receives valid JSON.
		expect(() => JSON.parse(args as string)).not.toThrow();
		// And it is the fallback object preserving a truncated hint.
		expect(JSON.parse(args as string)).toEqual({
			_malformed_arguments: malformed.slice(0, 200),
		});
	});

	it("arguments passes through valid string input", () => {
		const validJson = '{"path":"/src/main.ts"}';
		expect(() => JSON.parse(validJson)).not.toThrow();

		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_str",
						toolName: "read_file",
						input: validJson,
					},
				],
			},
		];

		const result = convertMessages(messages);
		const args = result[0]?.tool_calls?.[0]?.function.arguments;
		// A valid-JSON string round-trips to a canonical JSON string.
		expect(args).toBe(JSON.stringify(JSON.parse(validJson)));
		expect(args).toBe('{"path":"/src/main.ts"}');
	});

	it("stringifies object input", () => {
		const input = { path: "/src/main.ts", line: 42 };
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_obj",
						toolName: "read_file",
						input,
					},
				],
			},
		];

		const result = convertMessages(messages);
		const args = result[0]?.tool_calls?.[0]?.function.arguments;
		expect(args).toBe(JSON.stringify(input));
	});

	it("truncates the malformed input hint to 200 characters", () => {
		// A long bare run of letters is not valid JSON (no quotes/braces).
		const malformed = "x".repeat(500);
		expect(() => JSON.parse(malformed)).toThrow();

		const messages: ChatMessage[] = [
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call_long",
						toolName: "read_file",
						input: malformed,
					},
				],
			},
		];

		const result = convertMessages(messages);
		const args = result[0]?.tool_calls?.[0]?.function.arguments;
		expect(() => JSON.parse(args as string)).not.toThrow();
		const parsed = JSON.parse(args as string);
		expect(parsed).toEqual({ _malformed_arguments: malformed.slice(0, 200) });
		expect(parsed._malformed_arguments.length).toBe(200);
	});
});
