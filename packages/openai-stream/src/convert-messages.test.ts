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
});
