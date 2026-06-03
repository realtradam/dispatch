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

const { Agent, anthropicThinkingProviderOptions } = await import("../../src/agent/agent.js");
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

	it("does NOT swallow trailing queued messages into history at turn end", async () => {
		// Regression for the "queue not consumed after the turn ends" bug. A
		// message that lands on the queue after the last tool call (here: a
		// no-tool turn) must be LEFT on the queue for the orchestrator to start
		// a new turn — not silently appended to history with no response.
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "done" }, finishStop]),
		);

		const queue = [{ id: "q1", message: "answer me next", timestamp: 1 }];
		const dequeueMessages = vi.fn(() => queue.splice(0, queue.length));
		const agent = new Agent(makeConfig(), {
			dequeueMessages,
			waitForQueuedMessage: () => ({ promise: Promise.resolve(), cancel: () => {} }),
		});

		const before = agent.messages.length;
		for await (const _ of agent.run("hello")) {
			// consume
		}

		// The agent appended exactly the user turn + its own assistant reply;
		// it did NOT drain the queue or append a trailing user message for it.
		expect(dequeueMessages).not.toHaveBeenCalled();
		expect(queue).toHaveLength(1);
		const added = agent.messages.slice(before);
		expect(added.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(
			added.some((m) => m.chunks.some((c) => c.type === "text" && c.text === "answer me next")),
		).toBe(false);
	});

	it("still injects a mid-turn queued message into the last tool result", async () => {
		// The interrupt path (site 1) must be untouched by the turn-end fix: a
		// message present DURING a tool batch is folded into that batch's last
		// tool result as a [USER INTERRUPT], and the agent loops back to the LLM.
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{ type: "tool-call", toolCallId: "tc1", toolName: "read_file", input: { path: "a.txt" } },
					finishToolCalls,
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
			);

		const queue = [{ id: "q1", message: "stop and do X", timestamp: 1 }];
		const dequeueMessages = vi.fn(() => queue.splice(0, queue.length));
		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async () => "file contents",
		};
		const agent = new Agent(makeConfig({ tools: [toolDef] }), {
			dequeueMessages,
			waitForQueuedMessage: () => ({ promise: Promise.resolve(), cancel: () => {} }),
		});

		const events: AgentEvent[] = [];
		for await (const event of agent.run("read it")) {
			events.push(event);
		}

		expect(dequeueMessages).toHaveBeenCalled();
		const toolResult = events.find((e) => e.type === "tool-result") as
			| (AgentEvent & { toolResult: { result: string } })
			| undefined;
		expect(toolResult?.toolResult.result).toContain("[USER INTERRUPT]");
		expect(toolResult?.toolResult.result).toContain("stop and do X");
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

	it("per-step segmentation: a [tool-batch, text] turn becomes [assistant(tool-call), tool(result), assistant(text)]", async () => {
		// `toModelMessages` segments a turn at each tool-batch boundary, so the
		// tool-batch (step 0) and the trailing text (step 1) land in SEPARATE
		// assistant messages — never a single invalid [tool_use, text] block.
		// This is the cache-stability fix and is applied for every provider.
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

		// No assistant message may mix tool-call and non-tool-call parts (the
		// invalid shape Anthropic rejects); segmentation guarantees this.
		const assistantMsgs = messages.filter((m) => m.role === "assistant");
		for (const m of assistantMsgs) {
			const c = m.content as Array<Record<string, unknown>>;
			if (!Array.isArray(c)) continue;
			const hasToolCall = c.some((p) => p.type === "tool-call");
			const hasNonToolCall = c.some((p) => p.type !== "tool-call");
			expect(hasToolCall && hasNonToolCall).toBe(false);
		}

		// The seeded turn yields a tool-call assistant message immediately
		// followed by its tool-result message (valid tool_use → tool_result).
		const toolOnlyIdx = messages.findIndex((m) => {
			const c = m.content as Array<Record<string, unknown>>;
			return m.role === "assistant" && Array.isArray(c) && c.some((p) => p.type === "tool-call");
		});
		expect(toolOnlyIdx).toBeGreaterThanOrEqual(0);
		expect(messages[toolOnlyIdx + 1]?.role).toBe("tool");
	});

	it("per-step segmentation also applies to the openai-compatible provider", async () => {
		// Segmentation is provider-agnostic: a [tool-batch, text] turn is split
		// into separate assistant messages for openai-compatible too, with the
		// tool result in its own tool message (the standard OpenAI shape).
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

		// The seeded [tool-batch, text] turn is segmented: a tool-call-only
		// assistant message, its tool message, and a separate text assistant
		// message (the new turn's "ok" reply adds one more). No assistant
		// message mixes tool-call and non-tool-call parts.
		const assistantMsgs = messages.filter((m) => m.role === "assistant");
		for (const m of assistantMsgs) {
			const c = m.content as Array<Record<string, unknown>>;
			if (!Array.isArray(c)) continue;
			expect(c.some((p) => p.type === "tool-call") && c.some((p) => p.type !== "tool-call")).toBe(
				false,
			);
		}
		expect(messages.some((m) => m.role === "tool")).toBe(true);
		const toolCallMsg = assistantMsgs.find((m) => {
			const c = m.content as Array<Record<string, unknown>>;
			return Array.isArray(c) && c.some((p) => p.type === "tool-call");
		});
		expect(toolCallMsg).toBeDefined();
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

	// ─── Prompt-caching: tool-result grouping & breakpoints (notes/claude-report.md) ──

	it("groups a turn's tool results into a SINGLE role:'tool' message (Root Cause 2)", async () => {
		// The agent batches three distinct read_file calls in one step. The
		// rebuilt ModelMessage[] must contain exactly ONE `role: "tool"` message
		// holding all three results (not three separate tool messages). Per-
		// result messages would strand the rolling cache breakpoints on the last
		// two adjacent tool results, wasting a breakpoint.
		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async (args: Record<string, unknown>) => `contents of ${String(args.path)}`,
		};
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{ type: "tool-call", toolCallId: "b1", toolName: "read_file", input: { path: "a.txt" } },
					{ type: "tool-call", toolCallId: "b2", toolName: "read_file", input: { path: "b.txt" } },
					{ type: "tool-call", toolCallId: "b3", toolName: "read_file", input: { path: "c.txt" } },
					finishToolCalls,
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "done" }, finishStop]),
			);

		const agent = new Agent(makeConfig({ provider: "opencode-anthropic", tools: [toolDef] }));
		for await (const _ of agent.run("read three files")) {
			/* consume */
		}

		// Inspect the step-1 request (sent after the batch executed) — its tail
		// is the assistant tool-calls + the grouped tool results.
		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;

		const toolMsgs = messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(1);
		const toolContent = toolMsgs[0]?.content as Array<Record<string, unknown>>;
		expect(toolContent).toHaveLength(3);
		expect(toolContent.every((p) => p.type === "tool-result")).toBe(true);
		// IDs preserved per result.
		expect(toolContent.map((p) => p.toolCallId)).toEqual(["b1", "b2", "b3"]);
	});

	it("places cache breakpoints on [assistant, grouped-tool], not adjacent tool results (Root Cause 2)", async () => {
		// With grouping, the last two non-system messages of a mid-turn request
		// are [assistant(tool-calls), tool(all results)]. Both — plus the system
		// message — must carry an ephemeral cacheControl marker. The pre-fix bug
		// put both rolling breakpoints on two adjacent tool-result messages and
		// never marked the assistant turn.
		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async (args: Record<string, unknown>) => `contents of ${String(args.path)}`,
		};
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.txt" } },
					{ type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "b.txt" } },
					{ type: "tool-call", toolCallId: "c3", toolName: "read_file", input: { path: "c.txt" } },
					finishToolCalls,
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "done" }, finishStop]),
			);

		const agent = new Agent(makeConfig({ provider: "opencode-anthropic", tools: [toolDef] }));
		for await (const _ of agent.run("read three files")) {
			/* consume */
		}

		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{
			role: string;
			content: unknown;
			providerOptions?: { anthropic?: { cacheControl?: { type?: string } } };
		}>;

		const isCached = (m?: {
			providerOptions?: { anthropic?: { cacheControl?: { type?: string } } };
		}) => m?.providerOptions?.anthropic?.cacheControl?.type === "ephemeral";

		// Exactly one tool message — no adjacent tool-result breakpoints.
		expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);

		const systemMsg = messages.find((m) => m.role === "system");
		const assistantMsg = messages.find((m) => m.role === "assistant");
		const toolMsg = messages.find((m) => m.role === "tool");

		expect(isCached(systemMsg)).toBe(true);
		expect(isCached(assistantMsg)).toBe(true);
		expect(isCached(toolMsg)).toBe(true);
	});

	it("does NOT attach cacheControl for the openai-compatible (non-Anthropic) path", async () => {
		// Sanity check: caching markers are Anthropic-only. The OpenAI-compatible
		// endpoints do automatic server-side prefix caching and reject explicit
		// cache_control, so no marker should be attached.
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "hi" }, finishStop]),
		);
		const agent = new Agent(makeConfig()); // default → openai-compatible
		for await (const _ of agent.run("hello")) {
			/* consume */
		}
		const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
		const messages = callArgs?.messages as Array<{
			role: string;
			providerOptions?: { anthropic?: { cacheControl?: unknown } };
		}>;
		for (const m of messages) {
			expect(m.providerOptions?.anthropic?.cacheControl).toBeUndefined();
		}
	});

	// ─── Tool-call dedup (notes/tool-runner-duplication-incident.md) ─────────────────

	it("deduplicates byte-identical tool calls within a single batch", async () => {
		// Claude can degenerate and emit the same tool call (same name + args)
		// many times in one batch. Each copy keeps its own id (and still gets its
		// own result), but the tool must execute only ONCE — re-running identical
		// idempotent reads wastes time/money and floods the context.
		let execCount = 0;
		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async (args: Record<string, unknown>) => {
				execCount++;
				return `contents of ${String(args.path)}`;
			},
		};
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{
						type: "tool-call",
						toolCallId: "d1",
						toolName: "read_file",
						input: { path: "package.json" },
					},
					{
						type: "tool-call",
						toolCallId: "d2",
						toolName: "read_file",
						input: { path: "package.json" },
					},
					{
						type: "tool-call",
						toolCallId: "d3",
						toolName: "read_file",
						input: { path: "package.json" },
					},
					finishToolCalls,
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "done" }, finishStop]),
			);

		const agent = new Agent(makeConfig({ tools: [toolDef] }));
		const events: AgentEvent[] = [];
		for await (const e of agent.run("read it thrice")) {
			events.push(e);
		}

		// Executed exactly once despite three identical calls.
		expect(execCount).toBe(1);

		// Every call id still received its own result, all with identical content.
		const results = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result",
		);
		expect(results).toHaveLength(3);
		expect(results.map((e) => e.toolResult.toolCallId).sort()).toEqual(["d1", "d2", "d3"]);
		for (const r of results) {
			expect(r.toolResult.result).toBe("contents of package.json");
		}
	});

	it("does NOT deduplicate tool calls with differing arguments", async () => {
		// Dedup is keyed on name + serialized arguments. Distinct args must each
		// execute — only byte-identical calls collapse.
		let execCount = 0;
		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async (args: Record<string, unknown>) => {
				execCount++;
				return `contents of ${String(args.path)}`;
			},
		};
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{ type: "tool-call", toolCallId: "e1", toolName: "read_file", input: { path: "a.txt" } },
					{ type: "tool-call", toolCallId: "e2", toolName: "read_file", input: { path: "b.txt" } },
					{ type: "tool-call", toolCallId: "e3", toolName: "read_file", input: { path: "a.txt" } },
					finishToolCalls,
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "done" }, finishStop]),
			);

		const agent = new Agent(makeConfig({ tools: [toolDef] }));
		for await (const _ of agent.run("read a, b, a")) {
			/* consume */
		}

		// a.txt + b.txt are distinct → two executions; the repeated a.txt reuses
		// the first result.
		expect(execCount).toBe(2);
	});

	// ─── Cache stability: per-step wire prefix is immutable ─────────────────────

	it("keeps earlier steps' wire messages byte-identical across requests (cache prefix is stable)", async () => {
		// A 3-step tool turn. The messages for steps 0 and 1 must serialize
		// identically in the step-2 request and the step-3 request — that
		// byte-stability is what lets Anthropic's rolling prompt cache extend
		// instead of re-writing the whole prefix every step (notes/cache-miss-report.md).
		// Uses the openai-compatible provider so no cacheControl markers (which
		// intentionally move each step) obscure the content comparison.
		let n = 0;
		// mock.calls accumulates across tests in this file — reset so our
		// `calls.length` assertions count only this run's requests.
		vi.mocked(streamText).mockClear();
		const toolDef = {
			name: "read_file",
			description: "reads a file",
			parameters: z.object({ path: z.string() }),
			execute: async (args: Record<string, unknown>) => `contents of ${String(args.path)}`,
		};
		const toolStep = (id: string, path: string) =>
			makeMockStreamResult([
				{ type: "reasoning-delta", id: `r${id}`, text: `thinking ${id}` },
				{ type: "text-delta", id: `t${id}`, text: `step ${id}` },
				{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path } },
				finishToolCalls,
			]);
		vi.mocked(streamText).mockImplementation(() => {
			n++;
			if (n === 1) return toolStep("s0", "a.txt");
			if (n === 2) return toolStep("s1", "b.txt");
			if (n === 3) return toolStep("s2", "c.txt");
			return makeMockStreamResult([{ type: "text-delta", id: "tf", text: "done" }, finishStop]);
		});

		const agent = new Agent(makeConfig({ tools: [toolDef] }));
		for await (const _ of agent.run("go")) {
			/* consume */
		}

		// 4 streamText calls (steps 0..3). Compare the step-2 request (call idx 2)
		// and step-3 request (call idx 3).
		const calls = vi.mocked(streamText).mock.calls;
		expect(calls.length).toBe(4);
		const req2 = calls[2]?.[0]?.messages as unknown[];
		const req3 = calls[3]?.[0]?.messages as unknown[];

		// Step-2 request = [system, user, a(s0), tool(s0), a(s1), tool(s1)] (6).
		// Step-3 request appends a(s2), tool(s2). The shared 6-message prefix
		// must be byte-identical.
		expect(req2).toHaveLength(6);
		expect(req3).toHaveLength(8);
		expect(JSON.stringify(req3.slice(0, 6))).toBe(JSON.stringify(req2));

		// And each step really is its own [assistant, tool] pair (not one merged
		// assistant message with all tool calls bunched together).
		const roles = (req3 as Array<{ role: string }>).map((m) => m.role);
		expect(roles).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"assistant",
			"tool",
			"assistant",
			"tool",
		]);
	});

	// ─── Usage / cache-rate telemetry ──────────────────────────────────────────

	it("emits a usage event from the finish-step part with the cache read/write split", async () => {
		// The per-step `usage` (with Anthropic's cache read/write split in
		// `inputTokenDetails`) rides on the `finish-step` part — NOT the terminal
		// `finish` part, which only carries the aggregate `totalUsage`. The agent
		// re-emits it as a `usage` AgentEvent that powers the Cache Rate view.
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "text-delta", id: "t0", text: "hi" },
				{
					type: "finish-step",
					finishReason: "stop",
					rawFinishReason: "stop",
					usage: {
						inputTokens: 1000,
						outputTokens: 50,
						inputTokenDetails: {
							noCacheTokens: 200,
							cacheReadTokens: 750,
							cacheWriteTokens: 50,
						},
					},
				},
				finishStop,
			]),
		);

		const agent = new Agent(makeConfig());
		const events: AgentEvent[] = [];
		for await (const e of agent.run("hi")) {
			events.push(e);
		}

		const usageEvents = events.filter(
			(e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage",
		);
		// Exactly one usage event (from finish-step) — the terminal `finish`
		// part must NOT double-count.
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 50,
			cacheReadTokens: 750,
			cacheWriteTokens: 50,
		});
	});

	it("does NOT emit a usage event when no finish-step usage is present", async () => {
		// `finishStop` (type `finish`, aggregate `totalUsage` only) must not
		// trigger a usage event — and with no `finish-step` part there is no
		// per-step usage to emit.
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([{ type: "text-delta", id: "t0", text: "hi" }, finishStop]),
		);

		const agent = new Agent(makeConfig());
		const events: AgentEvent[] = [];
		for await (const e of agent.run("hi")) {
			events.push(e);
		}

		expect(events.some((e) => e.type === "usage")).toBe(false);
	});
});

describe("anthropicThinkingProviderOptions — adaptive-thinking model detection", () => {
	// Pure function: no provider construction, no streamText, no network I/O.
	// Mirrors opencode's transform.ts detection — Opus 4.7+ AND Opus/Sonnet 4.6
	// are adaptive; only Opus 4.7+ needs display:"summarized" to surface thinking.

	it("Opus 4.8 → adaptive + display:summarized (the reported bug)", () => {
		expect(anthropicThinkingProviderOptions("claude-opus-4-8", "max")).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			effort: "max",
		});
	});

	it("Opus 4.7 → adaptive + display:summarized (dash and dot id forms)", () => {
		const expected = { thinking: { type: "adaptive", display: "summarized" }, effort: "high" };
		expect(anthropicThinkingProviderOptions("claude-opus-4-7", "high")).toEqual(expected);
		expect(anthropicThinkingProviderOptions("claude-opus-4.7", "high")).toEqual(expected);
	});

	it("Sonnet 4.6 → adaptive WITHOUT display (dash and dot id forms)", () => {
		const expected = { thinking: { type: "adaptive" }, effort: "medium" };
		expect(anthropicThinkingProviderOptions("claude-sonnet-4-6", "medium")).toEqual(expected);
		expect(anthropicThinkingProviderOptions("claude-sonnet-4.6", "medium")).toEqual(expected);
	});

	it("Opus 4.6 → adaptive WITHOUT display", () => {
		expect(anthropicThinkingProviderOptions("claude-opus-4-6", "high")).toEqual({
			thinking: { type: "adaptive" },
			effort: "high",
		});
	});

	it("older Claude (Opus 4.5, dated Sonnet) → classic enabled thinking", () => {
		expect(anthropicThinkingProviderOptions("claude-opus-4-5", "max")).toEqual({
			thinking: { type: "enabled", budgetTokens: 31999 },
		});
		expect(anthropicThinkingProviderOptions("claude-sonnet-4-20250514", "high")).toEqual({
			thinking: { type: "enabled", budgetTokens: 16000 },
		});
	});

	it("uses a version parse, not a hardcoded string (future Opus 4.9 is adaptive)", () => {
		expect(anthropicThinkingProviderOptions("claude-opus-4-9", "high")).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			effort: "high",
		});
	});

	it("maps reasoning effort → budgetTokens for enabled (non-adaptive) models", () => {
		const budget = (e: "low" | "medium" | "high" | "xhigh" | "max") => {
			const opts = anthropicThinkingProviderOptions("claude-3-7-sonnet", e) as {
				thinking: { type: "enabled"; budgetTokens: number };
			};
			return opts.thinking.budgetTokens;
		};
		expect(budget("low")).toBe(2000);
		expect(budget("medium")).toBe(5000);
		expect(budget("high")).toBe(16000);
		expect(budget("xhigh")).toBe(24000);
		expect(budget("max")).toBe(31999);
	});

	it("xhigh budget sits strictly between high and max (ordering invariant)", () => {
		const budget = (e: "high" | "xhigh" | "max") => {
			const opts = anthropicThinkingProviderOptions("claude-3-7-sonnet", e) as {
				thinking: { type: "enabled"; budgetTokens: number };
			};
			return opts.thinking.budgetTokens;
		};
		expect(budget("high")).toBeLessThan(budget("xhigh"));
		expect(budget("xhigh")).toBeLessThan(budget("max"));
	});

	it("forwards xhigh verbatim as the adaptive effort sibling (Opus 4.7+)", () => {
		expect(anthropicThinkingProviderOptions("claude-opus-4-8", "xhigh")).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			effort: "xhigh",
		});
	});

	describe("multimodal user content", () => {
		it("emits ordered text + image parts to the model when content is provided", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
			);

			const agent = new Agent(makeConfig());
			for await (const _ of agent.run("here is image A: [image]", {
				content: [
					{ type: "text", text: "here is image A: " },
					{ type: "attachment", mediaType: "image/png", data: "QQ==" },
				],
			})) {
				// consume
			}

			const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
			const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user");
			expect(userMsg).toBeDefined();
			// Multimodal turn → content is an ordered parts array, not a string.
			expect(Array.isArray(userMsg?.content)).toBe(true);
			const parts = userMsg?.content as Array<Record<string, unknown>>;
			expect(parts[0]).toMatchObject({ type: "text", text: "here is image A: " });
			expect(parts[1]).toMatchObject({ type: "image", mediaType: "image/png" });
			expect(String(parts[1]?.image)).toBe("data:image/png;base64,QQ==");
		});

		it("emits a FilePart for a PDF attachment with its filename", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
			);

			const agent = new Agent(makeConfig());
			for await (const _ of agent.run("see [pdf]", {
				content: [
					{ type: "text", text: "see " },
					{ type: "attachment", mediaType: "application/pdf", data: "QQ==", name: "doc.pdf" },
				],
			})) {
				// consume
			}

			const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
			const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user");
			const parts = userMsg?.content as Array<Record<string, unknown>>;
			const filePart = parts.find((p) => p.type === "file");
			expect(filePart).toMatchObject({
				type: "file",
				mediaType: "application/pdf",
				filename: "doc.pdf",
			});
			expect(String(filePart?.data)).toBe("data:application/pdf;base64,QQ==");
		});

		it("persists the user turn as text only (no content) for history", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
			);

			const agent = new Agent(makeConfig());
			for await (const _ of agent.run("look: [image]", {
				content: [
					{ type: "text", text: "look: " },
					{ type: "attachment", mediaType: "image/png", data: "QQ==" },
				],
			})) {
				// consume
			}

			// The in-memory user message keeps the text chunk for the render/persist
			// path; the ephemeral `content` rides alongside it but isn't a chunk.
			const userMsg = agent.messages.find((m) => m.role === "user");
			expect(userMsg?.chunks).toEqual([{ type: "text", text: "look: [image]" }]);
		});

		it("falls back to a plain string when content has no attachment", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "ok" }, finishStop]),
			);

			const agent = new Agent(makeConfig());
			for await (const _ of agent.run("plain text", {
				content: [{ type: "text", text: "plain text" }],
			})) {
				// consume
			}

			const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
			const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user");
			// No attachment → plain string content (byte-identical to text-only path).
			expect(typeof userMsg?.content).toBe("string");
			expect(userMsg?.content).toBe("plain text");
		});
	});

	describe("warmCache (prompt-cache warming replay)", () => {
		function makeWarmStream(usage: {
			inputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
		}) {
			return makeMockStreamResult([
				{ type: "text-delta", id: "t0", text: "." },
				{
					type: "finish-step",
					finishReason: "stop",
					rawFinishReason: "stop",
					usage: {
						inputTokens: usage.inputTokens,
						outputTokens: 1,
						inputTokenDetails: {
							noCacheTokens: usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
							cacheReadTokens: usage.cacheReadTokens,
							cacheWriteTokens: usage.cacheWriteTokens,
						},
					},
				},
				finishStop,
			]);
		}

		const history = [
			{ role: "user" as const, chunks: [{ type: "text" as const, text: "hello" }] },
			{ role: "assistant" as const, chunks: [{ type: "text" as const, text: "hi there" }] },
		];

		it("returns the request usage (cache read/write split) without throwing", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeWarmStream({ inputTokens: 1000, cacheReadTokens: 950, cacheWriteTokens: 0 }),
			);
			const agent = new Agent(makeConfig({ provider: "anthropic" }));
			const usage = await agent.warmCache(history);
			expect(usage).toEqual({
				inputTokens: 1000,
				outputTokens: 1,
				cacheReadTokens: 950,
				cacheWriteTokens: 0,
			});
		});

		it("appends a single trivial throwaway user turn at the END of the history", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeWarmStream({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }),
			);
			const agent = new Agent(makeConfig({ provider: "anthropic" }));
			await agent.warmCache(history);

			const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
			const messages = callArgs?.messages as Array<{ role: string; content: unknown }>;
			// system + 2 history messages + 1 throwaway user turn.
			expect(messages[0]?.role).toBe("system");
			const last = messages.at(-1);
			expect(last?.role).toBe("user");
			// The throwaway turn's text must be the trivial probe.
			const lastText = JSON.stringify(last?.content);
			expect(lastText).toContain("reply with just a .");
			// Exactly one extra user turn beyond the genuine history's single user msg.
			const userMsgs = messages.filter((m) => m.role === "user");
			expect(userMsgs).toHaveLength(2);
		});

		it("sends Anthropic cache_control breakpoints with the SAME toolChoice/thinking as a real turn", async () => {
			// Anthropic keys the MESSAGE cache on `tool_choice` AND the extended-
			// thinking parameters. If warming sent a different value than a real
			// turn, it would warm a DIFFERENT message-cache bucket and the user's
			// next real message would still miss. So warming MUST mirror run():
			// toolChoice "auto" + the thinking providerOptions for the effort.
			vi.mocked(streamText).mockReturnValue(
				makeWarmStream({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }),
			);
			const agent = new Agent(makeConfig({ provider: "anthropic" }));
			await agent.warmCache(history);

			const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];
			expect(callArgs?.toolChoice).toBe("auto");
			// Thinking providerOptions present (effort defaults to "max").
			expect(callArgs?.providerOptions?.anthropic).toBeDefined();
			const messages = callArgs?.messages as Array<{
				role: string;
				providerOptions?: { anthropic?: { cacheControl?: unknown } };
			}>;
			const hasBreakpoint = messages.some(
				(m) => m.providerOptions?.anthropic?.cacheControl !== undefined,
			);
			expect(hasBreakpoint).toBe(true);
		});

		it("warming and a real turn send IDENTICAL cache-affecting params (same bucket)", async () => {
			// The core invariant of the whole feature: warmCache() and run() must
			// produce the same toolChoice + thinking providerOptions + maxOutputTokens
			// so the warming replay refreshes the EXACT cache the next real message
			// reads. Drive both and compare the cache-key inputs streamText receives.
			const cfg = makeConfig({ provider: "anthropic" });

			// 1) Real turn for the same history + the probe text as the user msg.
			const realAgent = new Agent(cfg);
			realAgent.messages.push(...history.map((m) => ({ ...m })));
			vi.mocked(streamText).mockReturnValue(
				makeMockStreamResult([{ type: "text-delta", id: "t0", text: "." }, finishStop]),
			);
			for await (const _ of realAgent.run("reply with just a .")) {
				// consume
			}
			const realArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];

			// 2) Warming replay for the same history.
			const warmAgent = new Agent(cfg);
			vi.mocked(streamText).mockReturnValue(
				makeWarmStream({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }),
			);
			await warmAgent.warmCache(history);
			const warmArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0];

			// The cache-affecting parameters must be byte-identical.
			expect(warmArgs?.toolChoice).toEqual(realArgs?.toolChoice);
			expect(warmArgs?.maxOutputTokens).toEqual(realArgs?.maxOutputTokens);
			expect(warmArgs?.providerOptions).toEqual(realArgs?.providerOptions);
		});

		it("does NOT mutate the agent's own message history", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeWarmStream({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }),
			);
			const agent = new Agent(makeConfig({ provider: "anthropic" }));
			expect(agent.messages).toHaveLength(0);
			await agent.warmCache(history);
			// warmCache takes history as an argument and never touches `this.messages`.
			expect(agent.messages).toHaveLength(0);
			// And it must not have flipped the agent into a running state.
			expect(agent.status).toBe("idle");
		});

		it("throws a formatted error when the stream errors", async () => {
			vi.mocked(streamText).mockReturnValue(
				makeMockStreamResult([{ type: "error", error: new Error("boom") }]),
			);
			const agent = new Agent(makeConfig({ provider: "anthropic" }));
			await expect(agent.warmCache(history)).rejects.toThrow(/boom/);
		});
	});
});
