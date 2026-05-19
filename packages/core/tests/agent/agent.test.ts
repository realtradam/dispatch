import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/agent.js";
import type { AgentConfig } from "../../src/types/index.js";

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

interface MockStreamOptions {
	events: Array<{ type: string; [key: string]: unknown }>;
	steps?: Array<{ toolResults: Array<{ toolCallId: string; result: unknown }> }>;
}

function makeMockStreamResult(opts: MockStreamOptions) {
	return {
		fullStream: makeFullStream(opts.events),
		steps: Promise.resolve(opts.steps ?? []),
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
			makeMockStreamResult({
				events: [
					{ type: "text-delta", textDelta: "Hello!" },
					{
						type: "finish",
						finishReason: "stop",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
				],
			}),
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
			makeMockStreamResult({
				events: [
					{ type: "text-delta", textDelta: "Hello" },
					{ type: "text-delta", textDelta: " world" },
					{
						type: "finish",
						finishReason: "stop",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
				],
			}),
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
			makeMockStreamResult({
				events: [
					{ type: "text-delta", textDelta: "Response" },
					{
						type: "finish",
						finishReason: "stop",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
				],
			}),
		);

		const agent = new Agent(makeConfig());
		for await (const _ of agent.run("my question")) {
			// consume generator
		}

		expect(agent.messages).toHaveLength(2);
		expect(agent.messages[0]).toMatchObject({
			role: "user",
			content: "my question",
		});
		expect(agent.messages[1]).toMatchObject({
			role: "assistant",
			content: "Response",
		});
	});

	it("yields done event with final message", async () => {
		const { streamText } = await import("ai");
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult({
				events: [
					{ type: "text-delta", textDelta: "Done!" },
					{
						type: "finish",
						finishReason: "stop",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
				],
			}),
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
			message: { role: "assistant", content: "Done!" },
		});
	});

	it("yields tool-call and tool-result events", async () => {
		const { streamText } = await import("ai");
		vi.mocked(streamText).mockReturnValue(
			makeMockStreamResult({
				events: [
					{
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "read_file",
						args: { path: "hello.txt" },
					},
					{ type: "text-delta", textDelta: "Here is the file." },
					{
						type: "finish",
						finishReason: "stop",
						usage: {},
						providerMetadata: undefined,
						response: {},
					},
				],
				steps: [
					{
						toolResults: [{ toolCallId: "tc1", result: "file contents" }],
					},
				],
			}),
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
