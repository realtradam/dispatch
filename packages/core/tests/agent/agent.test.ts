import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentConfig } from "../../src/types/index.js";

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
		const { streamText } = await import("ai");
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "text-delta", textDelta: "Hello!" },
				{
					type: "finish",
					finishReason: "stop",
					usage: {},
					providerMetadata: undefined,
					response: {},
				},
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
		const { streamText } = await import("ai");
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "text-delta", textDelta: "Hello" },
				{ type: "text-delta", textDelta: " world" },
				{
					type: "finish",
					finishReason: "stop",
					usage: {},
					providerMetadata: undefined,
					response: {},
				},
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
		const { streamText } = await import("ai");
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "text-delta", textDelta: "Response" },
				{
					type: "finish",
					finishReason: "stop",
					usage: {},
					providerMetadata: undefined,
					response: {},
				},
			]),
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
		const { streamText } = await import("ai");
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult([
				{ type: "text-delta", textDelta: "Done!" },
				{
					type: "finish",
					finishReason: "stop",
					usage: {},
					providerMetadata: undefined,
					response: {},
				},
			]),
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
		const { streamText } = await import("ai");

		// First call: LLM emits a tool-call
		// Second call (after tool execution): LLM emits text response with no tool calls
		vi.mocked(streamText)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "read_file",
						args: { path: "hello.txt" },
					},
					{
						type: "finish",
						finishReason: "tool-calls",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
				]),
			)
			.mockReturnValueOnce(
				makeMockStreamResult([
					{ type: "text-delta", textDelta: "Here is the file." },
					{
						type: "finish",
						finishReason: "stop",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
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
});
