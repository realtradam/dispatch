import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentConfig, AgentEvent } from "../../src/types/index.js";

// Mock bun:sqlite to avoid Bun-only import in vitest/Node
vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => ({})),
}));

// Mock the credentials module that depends on the DB
vi.mock("../../src/credentials/claude.js", () => ({
	buildBillingHeaderValue: vi.fn(() => ""),
	SYSTEM_IDENTITY: "You are a test agent.",
}));

// Mock the ai module's streamText
vi.mock("ai", async () => {
	const actual = await import("ai");
	return {
		...actual,
		streamText: vi.fn(),
	};
});

// Mock the provider
vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => (_model: string) => ({
		type: "language-model",
		modelId: _model,
	})),
}));

const { Agent } = await import("../../src/agent/agent.js");
const { streamText } = await import("ai");

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		model: "test-model",
		apiKey: "test-key",
		baseURL: "https://example.com/v1",
		systemPrompt: "You are a helpful assistant.",
		tools: [],
		workingDirectory: "/tmp",
		...overrides,
	};
}

async function* makeFullStream(
	events: Array<{ type: string; [key: string]: unknown }>,
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
	for (const event of events) {
		yield event;
	}
}

function makeMockStreamResult(events: Array<{ type: string; [key: string]: unknown }>) {
	return {
		fullStream: makeFullStream(events),
	} as ReturnType<typeof import("ai").streamText>;
}

// v6 finish event — only finishReason, rawFinishReason, totalUsage (no usage/providerMetadata/response)
const finishStop = {
	type: "finish",
	finishReason: "stop",
	rawFinishReason: "stop",
	totalUsage: { inputTokens: 10, outputTokens: 5 },
};

const finishToolCalls = {
	type: "finish",
	finishReason: "tool-calls",
	rawFinishReason: "tool_use",
	totalUsage: { inputTokens: 10, outputTokens: 5 },
};

describe("Agent", () => {
	it("starts in idle status", () => {
		const agent = new Agent(makeConfig());
		expect(agent.status).toBe("idle");
	});

	it("has empty messages initially", () => {
		const agent = new Agent(makeConfig());
		expect(agent.messages).toHaveLength(0);
	});

	it("yields running then idle status events around a simple message", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				// v6: text-delta uses `text` (not `textDelta`)
				{ type: "text-delta", id: "t0", text: "Hello!" },
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events = [];
		for await (const event of agent.run("hi")) {
			events.push(event);
		}

		const types = events.map((e) => e.type);
		expect(types[0]).toBe("status");
		expect(events[0]).toMatchObject({ type: "status", status: "running" });

		const lastStatusEvent = events.filter((e) => e.type === "status").at(-1);
		expect(lastStatusEvent).toMatchObject({ type: "status", status: "idle" });
	});

	it("yields text-delta events", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				// v6: text-delta uses `text` (not `textDelta`)
				{ type: "text-delta", id: "t0", text: "Hello" },
				{ type: "text-delta", id: "t0", text: " world" },
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events = [];
		for await (const event of agent.run("test")) {
			events.push(event);
		}

		const textDeltas = events.filter((e) => e.type === "text-delta");
		expect(textDeltas).toHaveLength(2);
		expect(textDeltas[0]).toMatchObject({ delta: "Hello" });
		expect(textDeltas[1]).toMatchObject({ delta: " world" });
	});

	it("adds user message and assistant message to history", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "Response" }, finishStop]),
		);

		const agent = new Agent(makeConfig());
		for await (const _ of agent.run("my question")) {
			// consume generator
		}

		expect(agent.messages).toHaveLength(2);
		expect(agent.messages[0]).toMatchObject({
			role: "user",
			chunks: [{ type: "text", text: "my question" }],
		});
		expect(agent.messages[1]).toMatchObject({
			role: "assistant",
			chunks: [{ type: "text", text: "Response" }],
		});
	});

	it("yields done event with final message", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "Done!" }, finishStop]),
		);

		const agent = new Agent(makeConfig());
		const events = [];
		for await (const event of agent.run("test")) {
			events.push(event);
		}

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
		expect(doneEvent).toMatchObject({
			type: "done",
			message: { role: "assistant", chunks: [{ type: "text", text: "Done!" }] },
		});
	});

	it("yields tool-call and tool-result events", async () => {
		// First call: LLM emits a tool-call
		// Second call (after tool execution): LLM emits text response with no tool calls
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "read_file",
						// v6: `input` replaces `args`
						input: { path: "hello.txt" },
					},
					finishToolCalls,
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{ type: "text-delta", id: "t0", text: "Here is the file." },
					finishStop,
				]),
			);

		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async (_args: Record<string, unknown>) => "file contents",
		};

		const agent = new Agent(makeConfig({ tools: [toolDef] }));
		const events = [];
		for await (const event of agent.run("read the file")) {
			events.push(event);
		}

		const toolCallEvent = events.find((e) => e.type === "tool-call");
		expect(toolCallEvent).toMatchObject({
			type: "tool-call",
			toolCall: { id: "tc1", name: "read_file" },
		});

		const toolResultEvent = events.find((e) => e.type === "tool-result");
		expect(toolResultEvent).toMatchObject({
			type: "tool-result",
			toolResult: { toolCallId: "tc1", result: "file contents" },
		});
	});

	it("yields reasoning-delta events", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				// v6: reasoning-delta uses `text` (not `textDelta`)
				{ type: "reasoning-delta", id: "r0", text: "thinking about this..." },
				{ type: "reasoning-delta", id: "r0", text: " more thoughts" },
				{ type: "text-delta", id: "t0", text: "Answer" },
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events = [];
		for await (const event of agent.run("think")) {
			events.push(event);
		}

		const reasoningDeltas = events.filter((e) => e.type === "reasoning-delta");
		expect(reasoningDeltas).toHaveLength(2);
		expect(reasoningDeltas[0]).toMatchObject({ delta: "thinking about this..." });
		expect(reasoningDeltas[1]).toMatchObject({ delta: " more thoughts" });
	});

	it("yields reasoning-end event when providerMetadata is present", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "reasoning-delta", id: "r0", text: "some reasoning" },
				{
					type: "reasoning-end",
					id: "r0",
					providerMetadata: { anthropic: { signature: "sig-1" } },
				},
				{ type: "text-delta", id: "t0", text: "Answer" },
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events = [];
		for await (const event of agent.run("think")) {
			events.push(event);
		}

		const reasoningEndEvent = events.find((e) => e.type === "reasoning-end");
		expect(reasoningEndEvent).toBeDefined();
		expect(reasoningEndEvent).toMatchObject({
			type: "reasoning-end",
			metadata: { anthropic: { signature: "sig-1" } },
		});
	});

	it("does NOT yield reasoning-end event when providerMetadata is absent", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "reasoning-delta", id: "r0", text: "some reasoning" },
				{
					type: "reasoning-end",
					id: "r0",
					// No providerMetadata — non-Anthropic model
				},
				{ type: "text-delta", id: "t0", text: "Answer" },
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events = [];
		for await (const event of agent.run("think")) {
			events.push(event);
		}

		const reasoningEndEvent = events.find((e) => e.type === "reasoning-end");
		expect(reasoningEndEvent).toBeUndefined();
	});

	// ─── New v6 round-trip tests ──────────────────────────────────────────────

	it("signed thinking round-trip: ThinkingChunk.metadata → ReasoningPart.providerOptions", async () => {
		// Pre-seed the agent with a prior assistant message containing a ThinkingChunk
		// with metadata (the Anthropic signature blob).
		// Anthropic-path provider — for openai-compatible the metadata
		// would be lifted into providerOptions.openaiCompatible instead;
		// that path is covered by the DeepSeek tests further down.
		const agent = new Agent(makeConfig({ provider: "opencode-anthropic" }));
		agent.messages.push({
			role: "user",
			chunks: [{ type: "text", text: "prior user message" }],
		});
		agent.messages.push({
			role: "assistant",
			chunks: [
				{
					type: "thinking",
					text: "I thought about it",
					metadata: { anthropic: { signature: "S" } },
				},
				{ type: "text", text: "prior response" },
			],
		});

		// Next turn: just return a simple text response
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "New answer" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			// consume
		}

		// Inspect the messages passed to streamText in this (last) call
		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		expect(callArgs).toBeDefined();
		const messages = callArgs?.messages as Array<{
			role: string;
			content: unknown;
		}>;

		// Find the assistant message in the rebuilt ModelMessage[]
		const assistantMsg = messages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		const content = assistantMsg?.content as Array<Record<string, unknown>>;
		const reasoningPart = content.find((p) => p.type === "reasoning");
		expect(reasoningPart).toBeDefined();
		expect(reasoningPart).toMatchObject({
			type: "reasoning",
			text: "I thought about it",
			providerOptions: { anthropic: { signature: "S" } },
		});
	});

	it("tool-call input round-trip: ToolBatchEntry.arguments → ToolCallPart.input (not args)", async () => {
		// Pre-seed the agent with a prior assistant message containing a tool-batch chunk
		const agent = new Agent(makeConfig());
		agent.messages.push({
			role: "user",
			chunks: [{ type: "text", text: "run a tool" }],
		});
		agent.messages.push({
			role: "assistant",
			chunks: [
				{
					type: "tool-batch",
					calls: [
						{
							id: "call-1",
							name: "read_file",
							arguments: { path: "/foo/bar.txt" },
							result: "file contents",
						},
					],
				},
			],
		});

		// Next turn: just return a simple text response
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "Done" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			// consume
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		// The assistant message should contain a tool-call part with `input` (not `args`)
		const assistantMsg = messages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		const content = assistantMsg?.content as Array<Record<string, unknown>>;
		const toolCallPart = content.find((p) => p.type === "tool-call");
		expect(toolCallPart).toBeDefined();
		expect(toolCallPart).toMatchObject({
			type: "tool-call",
			toolCallId: "call-1",
			toolName: "read_file",
			input: { path: "/foo/bar.txt" }, // v6: input not args
		});
		// Explicitly assert `args` is NOT present
		expect(toolCallPart).not.toHaveProperty("args");
	});

	it("tool-result output round-trip: result string → { type: 'text', value } ToolResultOutput", async () => {
		// Pre-seed the agent with a prior assistant message containing a tool-batch chunk
		const agent = new Agent(makeConfig());
		agent.messages.push({
			role: "user",
			chunks: [{ type: "text", text: "run a tool" }],
		});
		agent.messages.push({
			role: "assistant",
			chunks: [
				{
					type: "tool-batch",
					calls: [
						{
							id: "call-2",
							name: "read_file",
							arguments: { path: "/foo/baz.txt" },
							result: "the file content here",
						},
					],
				},
			],
		});

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "Done" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			// consume
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		// The tool message should contain a tool-result part with `output` (ToolResultOutput)
		const toolMsg = messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		const toolContent = toolMsg?.content as Array<Record<string, unknown>>;
		expect(toolContent[0]).toMatchObject({
			type: "tool-result",
			toolCallId: "call-2",
			toolName: "read_file",
			output: { type: "text", value: "the file content here" },
		});
		// Explicitly assert `result` (v4 raw string) is NOT present
		expect(toolContent[0]).not.toHaveProperty("result");
	});

	it("Anthropic [tool-call, text] split: mixed-order assistant message gets split into [text]+[tool-call]", async () => {
		// Pre-seed an assistant message with chunks in [tool-batch, text] order —
		// which produces [tool-call, text] in the ModelMessage content, a shape
		// Anthropic rejects. Only applies for anthropic / opencode-anthropic provider.
		const agent = new Agent(makeConfig({ provider: "opencode-anthropic" }));
		agent.messages.push({
			role: "user",
			chunks: [{ type: "text", text: "run a tool and explain" }],
		});
		agent.messages.push({
			role: "assistant",
			chunks: [
				// Note: tool-batch appears BEFORE text in chunks — this is the
				// problematic ordering that Anthropic rejects
				{
					type: "tool-batch",
					calls: [
						{
							id: "call-3",
							name: "read_file",
							arguments: { path: "/tmp/x.txt" },
							result: "x contents",
						},
					],
				},
				{ type: "text", text: "Here is my explanation." },
			],
		});

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			// consume
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		// After Anthropic structural normalisation, we should have TWO assistant messages:
		// 1st: text-only content
		// 2nd: tool-call-only content
		const assistantMsgs = messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);

		// Find the text-only assistant message and the tool-call-only assistant message
		const textOnlyMsg = assistantMsgs.find((m) => {
			const c = m.content as Array<Record<string, unknown>>;
			return Array.isArray(c) && c.every((p) => p.type !== "tool-call");
		});
		const toolOnlyMsg = assistantMsgs.find((m) => {
			const c = m.content as Array<Record<string, unknown>>;
			return Array.isArray(c) && c.every((p) => p.type === "tool-call");
		});

		// Narrow the optionals — toBeDefined() already verified non-null,
		// but TypeScript needs the explicit assertion via local consts so
		// we can pass them to indexOf without `!`.
		if (!textOnlyMsg || !toolOnlyMsg) throw new Error("type guard");

		// Text message comes first (before tool-call message) — Anthropic requires this ordering
		expect(messages.indexOf(textOnlyMsg)).toBeLessThan(messages.indexOf(toolOnlyMsg));
	});

	it("Anthropic [tool-call, text] split: openai-compatible provider preserves original order (no split)", async () => {
		// For non-Anthropic providers, the [tool-call, text] split should NOT be applied.
		// (No provider set → defaults to openai-compatible)
		const agent = new Agent(makeConfig());
		agent.messages.push({
			role: "user",
			chunks: [{ type: "text", text: "run a tool and explain" }],
		});
		agent.messages.push({
			role: "assistant",
			chunks: [
				{
					type: "tool-batch",
					calls: [
						{
							id: "call-4",
							name: "read_file",
							arguments: { path: "/tmp/y.txt" },
							result: "y contents",
						},
					],
				},
				{ type: "text", text: "Here is my explanation." },
			],
		});

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			// consume
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		// For openai-compatible provider, only ONE assistant message with mixed content
		const assistantMsgs = messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs).toHaveLength(1);
		const content = assistantMsgs[0]?.content as Array<Record<string, unknown>>;
		// Both tool-call and text parts should be in the same message
		expect(content.some((p) => p.type === "tool-call")).toBe(true);
		expect(content.some((p) => p.type === "text")).toBe(true);
	});

	it("empty-text-part filter (Anthropic): empty text chunk is not sent", async () => {
		// Pre-seed an assistant message where a text chunk has empty text.
		const agent = new Agent(makeConfig({ provider: "opencode-anthropic" }));
		agent.messages.push({
			role: "user",
			chunks: [{ type: "text", text: "hello" }],
		});
		agent.messages.push({
			role: "assistant",
			chunks: [
				{ type: "text", text: "" }, // empty text — should be filtered out
				{ type: "text", text: "non-empty response" },
			],
		});

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			// consume
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		const assistantMsg = messages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		const content = assistantMsg?.content as Array<Record<string, unknown>>;

		// Empty text part should have been filtered out
		const emptyTextParts = content.filter((p) => p.type === "text" && p.text === "");
		expect(emptyTextParts).toHaveLength(0);

		// The non-empty text part should still be there
		const nonEmptyTextParts = content.filter((p) => p.type === "text" && p.text !== "");
		expect(nonEmptyTextParts).toHaveLength(1);
		expect(nonEmptyTextParts[0]).toMatchObject({ text: "non-empty response" });
	});

	it("empty-reasoning-part filter (Anthropic): empty reasoning chunk is not sent", async () => {
		// Anthropic's adaptive thinking mode occasionally produces a signed-
		// but-empty thinking block. We persist it (for signature round-trip
		// fidelity) but strip the empty `reasoning` part before sending it
		// back, or Anthropic rejects with "thinking block must have content".
		const agent = new Agent(makeConfig({ provider: "opencode-anthropic" }));
		agent.messages.push({ role: "user", chunks: [{ type: "text", text: "hi" }] });
		agent.messages.push({
			role: "assistant",
			chunks: [
				// Signed-but-empty thinking block
				{ type: "thinking", text: "", metadata: { anthropic: { signature: "sig-empty" } } },
				{ type: "text", text: "answer" },
			],
		});

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;
		const assistantMsg = messages.find((m) => m.role === "assistant");
		const content = assistantMsg?.content as Array<Record<string, unknown>>;

		// Empty reasoning part must have been filtered out by the
		// Anthropic structural normalisation pass.
		const emptyReasoning = content.filter((p) => p.type === "reasoning" && p.text === "");
		expect(emptyReasoning).toHaveLength(0);

		// The text part should still be there
		expect(content.some((p) => p.type === "text" && p.text === "answer")).toBe(true);
	});

	it("toolCallId scrubbing (Anthropic): non-[a-zA-Z0-9_-] chars in tool IDs are sanitised", async () => {
		// Anthropic rejects toolCallId outside [a-zA-Z0-9_-]. Our internal
		// crypto.randomUUID IDs are safe, but defensively scrub for any
		// upstream-assigned IDs (subagent retrieval, provider-executed
		// tools, MCP, etc.). Mirrors opencode transform.ts:96-122.
		const agent = new Agent(makeConfig({ provider: "opencode-anthropic" }));
		agent.messages.push({ role: "user", chunks: [{ type: "text", text: "do the thing" }] });
		agent.messages.push({
			role: "assistant",
			chunks: [
				{
					type: "tool-batch",
					calls: [
						{
							id: "call.with/dots:and:slashes", // invalid chars
							name: "fake_tool",
							arguments: { x: 1 },
							result: "ok",
							isError: false,
						},
					],
				},
			],
		});

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		// Assistant tool-call part must have scrubbed ID
		const assistantMsg = messages.find((m) => m.role === "assistant");
		const assistantContent = assistantMsg?.content as Array<Record<string, unknown>>;
		const toolCallPart = assistantContent.find((p) => p.type === "tool-call");
		expect(toolCallPart).toBeDefined();
		expect(toolCallPart?.toolCallId).toBe("call_with_dots_and_slashes");

		// Matching tool-result message must use the SAME scrubbed ID
		// so Anthropic can pair them.
		const toolMsg = messages.find((m) => m.role === "tool");
		const toolContent = toolMsg?.content as Array<Record<string, unknown>>;
		expect(toolContent?.[0]?.toolCallId).toBe("call_with_dots_and_slashes");
	});

	it("reasoning metadata captured from stream is round-tripped on the next turn", async () => {
		// End-to-end integrity for the providerMetadata round-trip — the
		// bug that prompted the entire migration. Stream a turn that
		// emits reasoning-delta + reasoning-end with metadata, then run
		// ANOTHER turn and verify the metadata reaches the model via
		// ReasoningPart.providerOptions.
		const agent = new Agent(makeConfig({ provider: "opencode-anthropic" }));
		const sig = { anthropic: { signature: "round-trip-sig-1" } };

		// Turn 1: model emits reasoning + signed reasoning-end
		vi.mocked(streamText).mockReturnValueOnce(
			makeMockStreamResult([
				{ type: "reasoning-delta", id: "r0", text: "let me think" },
				{ type: "reasoning-end", id: "r0", providerMetadata: sig },
				{ type: "text-delta", id: "t0", text: "answer" },
				finishStop,
			]),
		);

		for await (const _ of agent.run("first question")) {
			/* consume */
		}

		// After turn 1, the persisted chunks should include a ThinkingChunk
		// with the captured metadata. The agent's messages array IS the
		// canonical persisted shape (the DB just JSON-stringifies it).
		const turn1Assistant = agent.messages.find(
			(m, i) => m.role === "assistant" && i === agent.messages.length - 1,
		);
		expect(turn1Assistant).toBeDefined();
		const thinkingChunk = turn1Assistant?.chunks.find((c) => c.type === "thinking");
		expect(thinkingChunk).toBeDefined();
		expect(thinkingChunk).toMatchObject({ text: "let me think", metadata: sig });

		// Turn 2: drive another turn, capture what streamText receives.
		vi.mocked(streamText).mockReturnValueOnce(
			makeMockStreamResult([
				{ type: "text-delta", id: "t1", text: "follow-up answer" },
				finishStop,
			]),
		);
		for await (const _ of agent.run("second question")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;
		const turn2Assistant = messages
			.filter((m) => m.role === "assistant")
			.find((m) => Array.isArray(m.content));
		const turn2Content = turn2Assistant?.content as Array<Record<string, unknown>>;
		const reasoningPart = turn2Content.find((p) => p.type === "reasoning");
		expect(reasoningPart).toBeDefined();
		expect(reasoningPart).toMatchObject({
			type: "reasoning",
			text: "let me think",
			providerOptions: sig,
		});
	});

	it("tool-error stream event yields a synthetic tool-result + error chunk and continues the turn", async () => {
		// Provider-executed tools (Anthropic server tools) bypass our
		// manual executor and surface as a `tool-error` stream event.
		// We must:
		//   1. Synthesize a tool-result with isError=true so the chunks
		//      reflect that the tool ran and failed — this keeps the
		//      tool-call/tool-result pairing complete and avoids the AI SDK
		//      throwing MissingToolResultsError on the next round-trip.
		//   2. Emit an error chunk so the UI shows the failure.
		//   3. NOT transition to "error" status — the step breaks out of the
		//      stream loop and the turn ends normally (here, with no further
		//      tool calls pending, the agent completes to idle).
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{
					type: "tool-error",
					toolCallId: "tc_server",
					toolName: "server_tool",
					error: new Error("upstream tool failure"),
				},
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events: AgentEvent[] = [];
		for await (const event of agent.run("trigger")) {
			events.push(event);
		}

		// Synthetic tool-result with the upstream error
		const trEvent = events.find((e) => e.type === "tool-result");
		expect(trEvent).toBeDefined();
		expect(trEvent).toMatchObject({
			type: "tool-result",
			toolResult: { toolCallId: "tc_server", isError: true },
		});

		// Error chunk for visibility
		const errEvent = events.find((e) => e.type === "error");
		expect(errEvent).toBeDefined();
		const errMsg = errEvent && "error" in errEvent ? errEvent.error : "";
		expect(typeof errMsg).toBe("string");
		expect((errMsg as string).includes("upstream tool failure")).toBe(true);

		// Status does NOT transition to error — the turn completes to idle.
		const lastStatus = events.filter((e) => e.type === "status").at(-1);
		expect(lastStatus).toMatchObject({ type: "status", status: "idle" });

		// The turn produced a `done` event (it did not abort).
		expect(events.some((e) => e.type === "done")).toBe(true);
	});

	it("tool-error leaves sibling tool calls to be resolved by the executor (not orphaned)", async () => {
		// When one tool in a batch errors, its siblings — whose tool-call
		// events were already yielded — must still receive a result, otherwise
		// the tool-call IDs are orphaned in the chunks (no matching result)
		// and the next LLM round-trip throws MissingToolResultsError. The
		// tool-error handler breaks out of the stream loop WITHOUT executing
		// the unresolved siblings inline; the normal manual-executor pass then
		// runs them. Here `sibling_tool` is not a registered tool, so the
		// executor returns an "Unknown tool" error result — completing the
		// tool-call/tool-result pairing with `isError: true`.
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{
					type: "tool-call",
					toolCallId: "tc_sibling",
					toolName: "sibling_tool",
					input: {},
				},
				{
					type: "tool-error",
					toolCallId: "tc_failed",
					toolName: "failed_tool",
					error: new Error("boom"),
				},
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events: AgentEvent[] = [];
		for await (const event of agent.run("trigger")) {
			events.push(event);
		}

		const toolResults = events.filter((e) => e.type === "tool-result");
		// One for the failed tool, one for the sibling resolved by the executor.
		const siblingResult = toolResults.find(
			(e) => "toolResult" in e && e.toolResult.toolCallId === "tc_sibling",
		);
		expect(siblingResult).toBeDefined();
		expect(siblingResult).toMatchObject({
			type: "tool-result",
			toolResult: { toolCallId: "tc_sibling", isError: true },
		});
		const siblingMsg =
			siblingResult && "toolResult" in siblingResult ? siblingResult.toolResult.result : "";
		expect((siblingMsg as string).includes("sibling_tool")).toBe(true);

		// Status completes to idle (the turn continued, not aborted).
		const lastStatus = events.filter((e) => e.type === "status").at(-1);
		expect(lastStatus).toMatchObject({ type: "status", status: "idle" });
	});

	it("abort stream event surfaces as an error event and stops the turn", async () => {
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "text-delta", id: "t0", text: "starting..." },
				{ type: "abort", reason: "user cancelled" },
			]),
		);

		const agent = new Agent(makeConfig());
		const events: AgentEvent[] = [];
		for await (const event of agent.run("hi")) {
			events.push(event);
		}

		const errEvent = events.find((e) => e.type === "error");
		expect(errEvent).toBeDefined();
		const errMsg = errEvent && "error" in errEvent ? errEvent.error : "";
		expect(
			(errMsg as string).toLowerCase().includes("aborted") ||
				(errMsg as string).includes("user cancelled"),
		).toBe(true);

		const lastStatus = events.filter((e) => e.type === "status").at(-1);
		expect(lastStatus).toMatchObject({ type: "status", status: "error" });
	});

	it("openai-compatible reasoning round-trip: ThinkingChunk -> providerOptions.openaiCompatible.reasoning_content (DeepSeek scenario)", async () => {
		// Reproducer for the "reasoning_content must be passed back" error
		// from DeepSeek via OpenCode Go.
		//
		// applyOpenAICompatibleReasoningNormalisation strips the
		// `{ type: "reasoning", text }` parts and lifts the concatenated
		// text into `providerOptions.openaiCompatible.reasoning_content`.
		// The v6 SDK provider serializes the message-level
		// `providerOptions.openaiCompatible.*` into the wire `assistant`
		// message via its `metadata` spread (line 247 of the SDK dist).
		// This route emits `reasoning_content` regardless of empty/non-
		// empty text — which is what DeepSeek requires.
		const agent = new Agent(
			makeConfig({
				model: "deepseek-v4-pro",
				// no provider field → default openai-compatible path
			}),
		);
		agent.messages.push(
			{ role: "user", chunks: [{ type: "text", text: "ping" }] },
			{
				role: "assistant",
				chunks: [
					{ type: "thinking", text: "let me reason about this" },
					{ type: "text", text: "ok done" },
				],
			},
		);

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{
			role: string;
			content: unknown;
			providerOptions?: { openaiCompatible?: { reasoning_content?: string } };
		}>;
		const assistantMsg = messages.find((m) => m.role === "assistant");
		if (!assistantMsg || !Array.isArray(assistantMsg.content)) {
			throw new Error("expected structured assistant content");
		}
		const content = assistantMsg.content as Array<Record<string, unknown>>;

		// Reasoning parts have been stripped from content (lifted into
		// providerOptions instead).
		expect(content.find((p) => p.type === "reasoning")).toBeUndefined();

		// reasoning_content is set on providerOptions.openaiCompatible.
		// This is what reaches DeepSeek and prevents the rejection.
		expect(assistantMsg.providerOptions?.openaiCompatible?.reasoning_content).toBe(
			"let me reason about this",
		);

		// The text part still survives in content.
		const textPart = content.find((p) => p.type === "text");
		expect(textPart).toMatchObject({ type: "text", text: "ok done" });

		// And critically, the message must NOT carry a providerMetadata
		// key (the v4-era misnamed key). v3 prompts use `providerOptions`.
		expect((assistantMsg as Record<string, unknown>).providerMetadata).toBeUndefined();
	});

	it("openai-compatible empty-reasoning edge case: forces reasoning_content='' so DeepSeek does not reject", async () => {
		// DeepSeek will reject the follow-up turn with "must be passed
		// back" if a prior assistant turn emitted reasoning AND the
		// follow-up doesn't include `reasoning_content` (even empty).
		// The v6 SDK's content-side path skips emission when reasoning
		// is empty (see `dist/index.mjs:245`); our normalisation routes
		// it via providerOptions instead, which fires unconditionally.
		const agent = new Agent(makeConfig({ model: "deepseek-v4-pro" }));
		agent.messages.push(
			{ role: "user", chunks: [{ type: "text", text: "ping" }] },
			{
				role: "assistant",
				chunks: [
					// Empty thinking — captured but produced no actual text.
					{ type: "thinking", text: "" },
					{ type: "text", text: "answer" },
				],
			},
		);

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("follow-up")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{
			role: string;
			content: unknown;
			providerOptions?: { openaiCompatible?: { reasoning_content?: string } };
		}>;
		const assistantMsg = messages.find((m) => m.role === "assistant");
		if (!assistantMsg) throw new Error("expected assistant message");

		// The empty-string reasoning_content is explicitly set on
		// providerOptions. (`""` is intentional and required —
		// `assistantMsg.providerOptions?.openaiCompatible?.reasoning_content`
		// must not be `undefined`.)
		const rc = assistantMsg.providerOptions?.openaiCompatible?.reasoning_content;
		expect(rc).toBeDefined();
		expect(rc).toBe("");
	});

	it("openai-compatible normalisation does NOT run for messages without any reasoning parts", async () => {
		// DeepSeek only requires `reasoning_content` AFTER a thinking
		// turn. For purely-text assistant messages, we should leave
		// providerOptions alone.
		const agent = new Agent(makeConfig({ model: "deepseek-v4-pro" }));
		agent.messages.push(
			{ role: "user", chunks: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				chunks: [{ type: "text", text: "hello back" }],
			},
		);

		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
		);

		for await (const _ of agent.run("again")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{
			role: string;
			providerOptions?: { openaiCompatible?: { reasoning_content?: string } };
		}>;
		const assistantMsg = messages.find((m) => m.role === "assistant");

		// No reasoning chunks → no providerOptions injection. (May still
		// be undefined entirely if nothing else set it.)
		const rc = assistantMsg?.providerOptions?.openaiCompatible?.reasoning_content;
		expect(rc).toBeUndefined();
	});
});
