import { describe, expect, it } from "vitest";
import { parseSSELines } from "./parse-sse.js";

describe("parseSSELines", () => {
	it("parses text delta events", () => {
		const lines = [
			'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"},"index":0}]}',
			'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"},"index":0}]}',
			'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{ type: "text-delta", delta: "Hello" },
			{ type: "text-delta", delta: " world" },
			{ type: "finish", reason: "stop" },
		]);
	});

	it("parses a fragmented tool_call across chunks", () => {
		const lines = [
			'data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":""}}]},"index":0}]}',
			'data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]},"index":0}]}',
			'data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"main.ts\\"}"}}]},"index":0}]}',
			'data: {"id":"chatcmpl-2","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{
				type: "tool-call",
				toolCallId: "call_abc",
				toolName: "read_file",
				input: { path: "main.ts" },
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	it("parses multiple tool_calls in one response", () => {
		const lines = [
			'data: {"id":"chatcmpl-3","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]},"index":0}]}',
			'data: {"id":"chatcmpl-3","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"index":0}]}',
			'data: {"id":"chatcmpl-3","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"read_file","arguments":""}}]},"index":0}]}',
			'data: {"id":"chatcmpl-3","choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"path\\":\\"b.ts\\"}"}}]},"index":0}]}',
			'data: {"id":"chatcmpl-3","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{ type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a.ts" } },
			{ type: "tool-call", toolCallId: "call_2", toolName: "read_file", input: { path: "b.ts" } },
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	it("parses usage from the final chunk", () => {
		const lines = [
			'data: {"id":"chatcmpl-4","choices":[{"delta":{"content":"Hi"},"index":0}]}',
			'data: {"id":"chatcmpl-4","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
			'data: {"id":"chatcmpl-4","usage":{"prompt_tokens":10,"completion_tokens":5}}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{ type: "text-delta", delta: "Hi" },
			{ type: "finish", reason: "stop" },
			{
				type: "usage",
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: undefined,
					cacheWriteTokens: undefined,
				},
			},
		]);
	});

	it("parses reasoning_content deltas", () => {
		const lines = [
			'data: {"id":"chatcmpl-5","choices":[{"delta":{"reasoning_content":"Let me think..."},"index":0}]}',
			'data: {"id":"chatcmpl-5","choices":[{"delta":{"content":"Here is my answer."},"index":0}]}',
			'data: {"id":"chatcmpl-5","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{ type: "reasoning-delta", delta: "Let me think..." },
			{ type: "text-delta", delta: "Here is my answer." },
			{ type: "finish", reason: "stop" },
		]);
	});

	it("handles invalid JSON gracefully", () => {
		const lines = [
			"data: {invalid json}",
			'data: {"id":"chatcmpl-6","choices":[{"delta":{"content":"ok"},"index":0}]}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("error");
		expect(events[1]).toEqual({ type: "text-delta", delta: "ok" });
	});

	it("ignores non-data lines", () => {
		const lines = [
			"event: message",
			": comment line",
			'data: {"id":"chatcmpl-7","choices":[{"delta":{"content":"hi"},"index":0}]}',
			"",
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([{ type: "text-delta", delta: "hi" }]);
	});

	it("stops at [DONE] sentinel", () => {
		const lines = [
			'data: {"id":"chatcmpl-8","choices":[{"delta":{"content":"before"},"index":0}]}',
			"data: [DONE]",
			'data: {"id":"chatcmpl-8","choices":[{"delta":{"content":"after"},"index":0}]}',
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([{ type: "text-delta", delta: "before" }]);
	});

	it("handles a complete turn with text, tool call, usage, and finish", () => {
		const lines = [
			'data: {"id":"chatcmpl-9","choices":[{"delta":{"content":"Let me check."},"index":0}]}',
			'data: {"id":"chatcmpl-9","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","function":{"name":"search","arguments":""}}]},"index":0}]}',
			'data: {"id":"chatcmpl-9","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":"}}]},"index":0}]}',
			'data: {"id":"chatcmpl-9","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"dispatch\\"}"}}]},"index":0}]}',
			'data: {"id":"chatcmpl-9","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
			'data: {"id":"chatcmpl-9","usage":{"prompt_tokens":50,"completion_tokens":20}}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{ type: "text-delta", delta: "Let me check." },
			{
				type: "tool-call",
				toolCallId: "call_xyz",
				toolName: "search",
				input: { query: "dispatch" },
			},
			{ type: "finish", reason: "tool_calls" },
			{
				type: "usage",
				usage: {
					inputTokens: 50,
					outputTokens: 20,
					cacheReadTokens: undefined,
					cacheWriteTokens: undefined,
				},
			},
		]);
	});

	it("handles tool_call with unparseable arguments as raw string", () => {
		const lines = [
			'data: {"id":"chatcmpl-10","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"foo","arguments":"not-json"}}]},"index":0}]}',
			'data: {"id":"chatcmpl-10","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
			"data: [DONE]",
		];

		const events = parseSSELines(lines);
		expect(events).toEqual([
			{ type: "tool-call", toolCallId: "call_bad", toolName: "foo", input: "not-json" },
			{ type: "finish", reason: "tool_calls" },
		]);
	});
});
