import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../contracts/conversation.js";
import type { AgentEvent } from "../contracts/events.js";
import type { LogDeps, Logger, LogRecord, LogSink } from "../contracts/logging.js";
import { createLogger } from "../contracts/logging.js";
import type { ProviderContract, ProviderEvent } from "../contracts/provider.js";
import type { ToolContract, ToolExecuteContext, ToolResult } from "../contracts/tool.js";
import { runTurn } from "./run-turn.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createFakeProvider(script: ProviderEvent[][]): ProviderContract {
	let callIndex = 0;
	return {
		id: "fake",
		stream(_messages, _tools) {
			const events = script[callIndex] ?? [];
			callIndex++;
			return (async function* () {
				for (const event of events) {
					yield event;
				}
			})();
		},
	};
}

function createFakeTool(
	name: string,
	handler?: (input: unknown, ctx: ToolExecuteContext) => Promise<ToolResult>,
	opts?: { concurrencySafe?: boolean },
): ToolContract {
	return {
		name,
		description: `Fake tool: ${name}`,
		parameters: { type: "object" },
		...(opts?.concurrencySafe !== undefined ? { concurrencySafe: opts.concurrencySafe } : {}),
		execute: handler ?? (async (input) => ({ content: `${name}: ${JSON.stringify(input)}` })),
	};
}

function createCollectingEmit(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
	const events: AgentEvent[] = [];
	return { events, emit: (event) => events.push(event) };
}

const userMessage: ChatMessage = {
	role: "user",
	chunks: [{ type: "text", text: "hello" }],
};

describe("runTurn", () => {
	it("emits events with the conversationId and turnId from input", async () => {
		const provider = createFakeProvider([
			[
				{ type: "text-delta", delta: "hi" },
				{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { events, emit } = createCollectingEmit();

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "conv-42",
			turnId: "turn-99",
			emit,
		});

		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(event.conversationId).toBe("conv-42");
			if (event.type !== "status") {
				expect(event.turnId).toBe("turn-99");
			}
		}
	});

	it("text-only turn emits correct events and returns correct result", async () => {
		const provider = createFakeProvider([
			[
				{ type: "text-delta", delta: "Hello" },
				{ type: "text-delta", delta: " world" },
				{ type: "reasoning-delta", delta: "thinking..." },
				{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { events, emit } = createCollectingEmit();

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
		});

		expect(result.finishReason).toBe("stop");
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("assistant");

		const chunks = result.messages[0]?.chunks ?? [];
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toEqual({ type: "text", text: "Hello world" });
		expect(chunks[1]).toEqual({ type: "thinking", text: "thinking..." });

		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toEqual(["text-delta", "text-delta", "reasoning-delta", "usage"]);
	});

	it("turn with one tool call executes tool, feeds result back, then finishes", async () => {
		const tool = createFakeTool("greet", async (input) => ({
			content: `Hello, ${(input as { name: string }).name}!`,
		}));

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "greet", input: { name: "World" } },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "Done." },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { events, emit } = createCollectingEmit();

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
		});

		expect(result.finishReason).toBe("stop");
		expect(result.messages).toHaveLength(3);
		expect(result.messages[0]?.role).toBe("assistant");
		expect(result.messages[1]?.role).toBe("tool");
		expect(result.messages[2]?.role).toBe("assistant");

		const toolResultChunk = result.messages[1]?.chunks[0];
		expect(toolResultChunk?.type).toBe("tool-result");
		if (toolResultChunk?.type === "tool-result") {
			expect(toolResultChunk.content).toBe("Hello, World!");
			expect(toolResultChunk.toolCallId).toBe("tc1");
			expect(toolResultChunk.isError).toBe(false);
		}

		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("tool-call");
		expect(eventTypes).toContain("tool-result");
		expect(eventTypes).toContain("text-delta");
	});

	it("passes updated messages to subsequent provider calls", async () => {
		const capturedMessages: ChatMessage[][] = [];
		let callIndex = 0;
		const script: ProviderEvent[][] = [
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		];

		const provider: ProviderContract = {
			id: "fake",
			stream(messages, _tools) {
				capturedMessages.push([...messages]);
				const events = script[callIndex] ?? [];
				callIndex++;
				return (async function* () {
					for (const event of events) yield event;
				})();
			},
		};

		const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		expect(capturedMessages).toHaveLength(2);
		expect(capturedMessages[0] ?? []).toHaveLength(1);
		expect(capturedMessages[0]?.[0]?.role).toBe("user");

		expect(capturedMessages[1] ?? []).toHaveLength(3);
		expect(capturedMessages[1]?.[0]?.role).toBe("user");
		expect(capturedMessages[1]?.[1]?.role).toBe("assistant");
		expect(capturedMessages[1]?.[2]?.role).toBe("tool");
	});

	it("maxConcurrent: 1 runs tools sequentially", async () => {
		const log: string[] = [];

		const toolA = createFakeTool("a", async () => {
			log.push("a:start");
			await delay(10);
			log.push("a:end");
			return { content: "a" };
		});

		const toolB = createFakeTool("b", async () => {
			log.push("b:start");
			await delay(10);
			log.push("b:end");
			return { content: "b" };
		});

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
				{ type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [toolA, toolB],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		const aEndIdx = log.indexOf("a:end");
		const bStartIdx = log.indexOf("b:start");
		expect(aEndIdx).toBeLessThan(bStartIdx);
	});

	it("maxConcurrent: 2 runs tools in parallel", async () => {
		const log: string[] = [];

		const toolA = createFakeTool("a", async () => {
			log.push("a:start");
			await delay(20);
			log.push("a:end");
			return { content: "a" };
		});

		const toolB = createFakeTool("b", async () => {
			log.push("b:start");
			await delay(20);
			log.push("b:end");
			return { content: "b" };
		});

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
				{ type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [toolA, toolB],
			dispatch: { maxConcurrent: 2, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		const aStartIdx = log.indexOf("a:start");
		const bStartIdx = log.indexOf("b:start");
		const aEndIdx = log.indexOf("a:end");
		const bEndIdx = log.indexOf("b:end");

		expect(aStartIdx).toBeLessThan(aEndIdx);
		expect(bStartIdx).toBeLessThan(bEndIdx);
		expect(aStartIdx).toBeLessThan(bEndIdx);
		expect(bStartIdx).toBeLessThan(aEndIdx);
	});

	it("maxConcurrent: 0 runs all tools in parallel (unlimited)", async () => {
		const log: string[] = [];

		const toolA = createFakeTool("a", async () => {
			log.push("a:start");
			await delay(20);
			log.push("a:end");
			return { content: "a" };
		});

		const toolB = createFakeTool("b", async () => {
			log.push("b:start");
			await delay(20);
			log.push("b:end");
			return { content: "b" };
		});

		const toolC = createFakeTool("c", async () => {
			log.push("c:start");
			await delay(20);
			log.push("c:end");
			return { content: "c" };
		});

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
				{ type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} },
				{ type: "tool-call", toolCallId: "tc3", toolName: "c", input: {} },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [toolA, toolB, toolC],
			dispatch: { maxConcurrent: 0, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		const aStartIdx = log.indexOf("a:start");
		const bStartIdx = log.indexOf("b:start");
		const cStartIdx = log.indexOf("c:start");
		const aEndIdx = log.indexOf("a:end");
		const bEndIdx = log.indexOf("b:end");
		const cEndIdx = log.indexOf("c:end");

		expect(aStartIdx).toBeLessThan(aEndIdx);
		expect(bStartIdx).toBeLessThan(bEndIdx);
		expect(cStartIdx).toBeLessThan(cEndIdx);
		expect(aStartIdx).toBeLessThan(bEndIdx);
		expect(bStartIdx).toBeLessThan(aEndIdx);
		expect(cStartIdx).toBeLessThan(aEndIdx);
	});

	it("eager: true launches tool before step finish", async () => {
		const log: string[] = [];

		const tool = createFakeTool("test", async () => {
			log.push("tool:start");
			await delay(5);
			log.push("tool:end");
			return { content: "done" };
		});

		let callCount = 0;
		const provider: ProviderContract = {
			id: "fake",
			stream(_messages, _tools) {
				const idx = callCount++;
				if (idx === 0) {
					return (async function* () {
						yield {
							type: "tool-call",
							toolCallId: "tc1",
							toolName: "test",
							input: {},
						} as ProviderEvent;
						log.push("provider:after-tool-call");
						await delay(50);
						yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
						log.push("provider:finish");
					})();
				}
				return (async function* () {
					yield { type: "text-delta", delta: "done" } as ProviderEvent;
					yield { type: "finish", reason: "stop" } as ProviderEvent;
				})();
			},
		};

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: true },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		const toolStartIdx = log.indexOf("tool:start");
		const finishIdx = log.indexOf("provider:finish");
		expect(toolStartIdx).toBeLessThan(finishIdx);
	});

	it("eager: false does not launch tool before step finish", async () => {
		const log: string[] = [];

		const tool = createFakeTool("test", async () => {
			log.push("tool:start");
			await delay(5);
			log.push("tool:end");
			return { content: "done" };
		});

		let callCount = 0;
		const provider: ProviderContract = {
			id: "fake",
			stream(_messages, _tools) {
				const idx = callCount++;
				if (idx === 0) {
					return (async function* () {
						yield {
							type: "tool-call",
							toolCallId: "tc1",
							toolName: "test",
							input: {},
						} as ProviderEvent;
						log.push("provider:after-tool-call");
						await delay(50);
						yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
						log.push("provider:finish");
					})();
				}
				return (async function* () {
					yield { type: "text-delta", delta: "done" } as ProviderEvent;
					yield { type: "finish", reason: "stop" } as ProviderEvent;
				})();
			},
		};

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		const toolStartIdx = log.indexOf("tool:start");
		const finishIdx = log.indexOf("provider:finish");
		expect(toolStartIdx).toBeGreaterThan(finishIdx);
	});

	it("abort mid-turn synthesizes error results for unresolved tool calls", async () => {
		const ac = new AbortController();

		const tool = createFakeTool("slow", async (_input, ctx) => {
			await delay(200);
			if (ctx.signal.aborted) return { content: "Aborted", isError: true };
			return { content: "done" };
		});

		const provider: ProviderContract = {
			id: "fake",
			stream(_messages, _tools) {
				return (async function* () {
					yield {
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "slow",
						input: {},
					} as ProviderEvent;
					yield {
						type: "tool-call",
						toolCallId: "tc2",
						toolName: "slow",
						input: { x: 1 },
					} as ProviderEvent;
					ac.abort();
					await delay(10);
					yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
				})();
			},
		};

		const { events, emit } = createCollectingEmit();

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
			signal: ac.signal,
		});

		expect(result.finishReason).toBe("aborted");

		const toolResults = events.filter((e) => e.type === "tool-result");
		for (const tr of toolResults) {
			if (tr.type === "tool-result") {
				expect(tr.isError).toBe(true);
			}
		}
	});

	it("abort before any step returns aborted immediately", async () => {
		const ac = new AbortController();
		ac.abort();

		const provider = createFakeProvider([
			[
				{ type: "text-delta", delta: "should not appear" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
			signal: ac.signal,
		});

		expect(result.finishReason).toBe("aborted");
		expect(result.messages).toHaveLength(0);
	});

	it("de-duplicates identical tool calls in a batch", async () => {
		let execCount = 0;

		const tool = createFakeTool("dedup", async (_input) => {
			execCount++;
			return { content: `result-${execCount}` };
		});

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "dedup", input: { x: 1 } },
				{ type: "tool-call", toolCallId: "tc2", toolName: "dedup", input: { x: 1 } },
				{ type: "tool-call", toolCallId: "tc3", toolName: "dedup", input: { x: 2 } },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { events, emit } = createCollectingEmit();

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
		});

		expect(execCount).toBe(2);

		const toolResults = events.filter((e) => e.type === "tool-result");
		expect(toolResults).toHaveLength(3);

		const tc1Result = toolResults.find((e) => e.type === "tool-result" && e.toolCallId === "tc1");
		const tc2Result = toolResults.find((e) => e.type === "tool-result" && e.toolCallId === "tc2");
		const tc3Result = toolResults.find((e) => e.type === "tool-result" && e.toolCallId === "tc3");

		expect(tc1Result).toBeDefined();
		expect(tc2Result).toBeDefined();
		expect(tc3Result).toBeDefined();

		if (tc1Result?.type === "tool-result" && tc2Result?.type === "tool-result") {
			expect(tc1Result.content).toBe(tc2Result.content);
			expect(tc1Result.content).toBe("result-1");
		}
		if (tc3Result?.type === "tool-result") {
			expect(tc3Result.content).toBe("result-2");
		}

		expect(result.finishReason).toBe("stop");
	});

	it("serializes non-concurrency-safe tools even with maxConcurrent > 1", async () => {
		const log: string[] = [];

		const unsafeTool: ToolContract = {
			name: "unsafe",
			description: "Unsafe tool",
			parameters: { type: "object" },
			concurrencySafe: false,
			execute: async () => {
				log.push("unsafe:start");
				await delay(10);
				log.push("unsafe:end");
				return { content: "done" };
			},
		};

		const safeTool: ToolContract = {
			name: "safe",
			description: "Safe tool",
			parameters: { type: "object" },
			execute: async () => {
				log.push("safe:start");
				await delay(10);
				log.push("safe:end");
				return { content: "done" };
			},
		};

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "unsafe", input: {} },
				{ type: "tool-call", toolCallId: "tc2", toolName: "safe", input: {} },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [unsafeTool, safeTool],
			dispatch: { maxConcurrent: 5, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		const unsafeEndIdx = log.indexOf("unsafe:end");
		const safeStartIdx = log.indexOf("safe:start");
		expect(unsafeEndIdx).toBeLessThan(safeStartIdx);
	});

	it("handles unknown tool name gracefully", async () => {
		const provider = createFakeProvider([
			[
				{
					type: "tool-call",
					toolCallId: "tc1",
					toolName: "nonexistent",
					input: {},
				},
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { events, emit } = createCollectingEmit();

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
		});

		const toolResults = events.filter((e) => e.type === "tool-result");
		expect(toolResults).toHaveLength(1);
		if (toolResults[0]?.type === "tool-result") {
			expect(toolResults[0]?.isError).toBe(true);
			expect(toolResults[0]?.content).toContain("Unknown tool");
		}

		expect(result.finishReason).toBe("stop");
	});

	it("handles provider error gracefully", async () => {
		const provider: ProviderContract = {
			id: "fake",
			stream() {
				return (async function* () {
					yield { type: "text-delta", delta: "partial" } as ProviderEvent;
					throw new Error("provider crashed");
				})();
			},
		};

		const { events, emit } = createCollectingEmit();

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
		});

		expect(result.finishReason).toBe("error");

		const errorEvents = events.filter((e) => e.type === "error");
		expect(errorEvents).toHaveLength(1);
		if (errorEvents[0]?.type === "error") {
			expect(errorEvents[0]?.message).toContain("provider crashed");
		}
	});

	it("aggregates usage across multiple steps", async () => {
		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
				{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "usage", usage: { inputTokens: 20, outputTokens: 10 } },
				{ type: "finish", reason: "stop" },
			],
		]);

		const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
	});

	it("emits tool-output events from tool ctx.onOutput", async () => {
		const tool: ToolContract = {
			name: "streaming",
			description: "A tool that streams output",
			parameters: { type: "object" },
			execute: async (_input, ctx) => {
				ctx.onOutput("line 1\n", "stdout");
				ctx.onOutput("err 1\n", "stderr");
				return { content: "done" };
			},
		};

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "streaming", input: {} },
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", delta: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const { events, emit } = createCollectingEmit();

		await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit,
		});

		const outputs = events.filter((e) => e.type === "tool-output");
		expect(outputs).toHaveLength(2);
		if (outputs[0]?.type === "tool-output") {
			expect(outputs[0]?.data).toBe("line 1\n");
			expect(outputs[0]?.stream).toBe("stdout");
			expect(outputs[0]?.toolCallId).toBe("tc1");
		}
		if (outputs[1]?.type === "tool-output") {
			expect(outputs[1]?.data).toBe("err 1\n");
			expect(outputs[1]?.stream).toBe("stderr");
		}
	});

	function createTestLogger(): {
		logger: Logger;
		sink: LogSink & { records: LogRecord[] };
		deps: LogDeps;
	} {
		let idCounter = 0;
		const deps: LogDeps = {
			now: () => 1000 + idCounter * 100,
			newId: () => `span-${++idCounter}`,
		};
		const records: LogRecord[] = [];
		const sink: LogSink & { records: LogRecord[] } = {
			records,
			emit: (record) => records.push(record),
		};
		const logger = createLogger({ extensionId: "test" }, sink, deps);
		return { logger, sink, deps };
	}

	describe("span instrumentation", () => {
		it("emits turn + step span open/close in order", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { logger, sink } = createTestLogger();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
				logger,
			});

			const spanOpens = sink.records.filter((r) => r.kind === "span-open");
			const spanCloses = sink.records.filter((r) => r.kind === "span-close");

			expect(spanOpens.length).toBeGreaterThanOrEqual(2); // turn + step
			expect(spanCloses.length).toBeGreaterThanOrEqual(2);

			const turnOpen = spanOpens.find((r) => r.kind === "span-open" && r.name === "turn");
			const stepOpen = spanOpens.find((r) => r.kind === "span-open" && r.name === "step");
			expect(turnOpen).toBeDefined();
			expect(stepOpen).toBeDefined();

			if (turnOpen?.kind === "span-open") {
				expect(turnOpen.extensionId).toBe("test");
				expect(turnOpen.attributes?.conversationId).toBe("conv-1");
				expect(turnOpen.attributes?.turnId).toBe("turn-1");
			}

			const turnClose = spanCloses.find((r) => r.kind === "span-close" && r.name === "turn");
			expect(turnClose).toBeDefined();
			if (turnClose?.kind === "span-close") {
				expect(turnClose.status).toBe("ok");
				expect(turnClose.durationMs).toBeGreaterThanOrEqual(0);
			}
		});

		it("emits tool-call spans for dispatched tools", async () => {
			const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

			const provider = createFakeProvider([
				[
					{ type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
					{ type: "finish", reason: "tool-calls" },
				],
				[
					{ type: "text-delta", delta: "done" },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { logger, sink } = createTestLogger();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
				logger,
			});

			const toolCallSpans = sink.records.filter(
				(r) => r.kind === "span-open" && r.name === "tool-call",
			);
			expect(toolCallSpans).toHaveLength(1);
			if (toolCallSpans[0]?.kind === "span-open") {
				expect(toolCallSpans[0].attributes?.name).toBe("echo");
				expect(toolCallSpans[0].attributes?.toolCallId).toBe("tc1");
			}

			const toolCallCloses = sink.records.filter(
				(r) => r.kind === "span-close" && r.name === "tool-call",
			);
			expect(toolCallCloses).toHaveLength(1);
			if (toolCallCloses[0]?.kind === "span-close") {
				expect(toolCallCloses[0].status).toBe("ok");
			}
		});

		it("tools receive ctx.log (correlated logger)", async () => {
			let capturedLog: Logger | undefined;

			const tool = createFakeTool("logtest", async (_input, ctx) => {
				capturedLog = ctx.log;
				ctx.log.info("tool ran", { key: "value" });
				return { content: "ok" };
			});

			const provider = createFakeProvider([
				[
					{ type: "tool-call", toolCallId: "tc1", toolName: "logtest", input: {} },
					{ type: "finish", reason: "tool-calls" },
				],
				[
					{ type: "text-delta", delta: "done" },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { logger, sink } = createTestLogger();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
				logger,
			});

			expect(capturedLog).toBeDefined();

			const toolLogs = sink.records.filter(
				(r) => r.kind === "log" && r.kind === "log" && (r as { msg: string }).msg === "tool ran",
			);
			expect(toolLogs).toHaveLength(1);
			if (toolLogs[0]?.kind === "log") {
				expect(toolLogs[0].attributes?.key).toBe("value");
				expect(toolLogs[0].extensionId).toBe("test");
			}
		});

		it("an aborted turn still closes its turn span", async () => {
			const ac = new AbortController();
			ac.abort();

			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "should not appear" },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { logger, sink } = createTestLogger();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
				signal: ac.signal,
				logger,
			});

			const turnCloses = sink.records.filter((r) => r.kind === "span-close" && r.name === "turn");
			expect(turnCloses).toHaveLength(1);
			if (turnCloses[0]?.kind === "span-close") {
				expect(turnCloses[0].attributes?.finishReason).toBe("aborted");
			}
		});

		it("a provider error closes the step span with error status", async () => {
			const provider: ProviderContract = {
				id: "fake",
				stream() {
					return (async function* () {
						yield { type: "text-delta", delta: "partial" } as ProviderEvent;
						throw new Error("provider exploded");
					})();
				},
			};

			const { logger, sink } = createTestLogger();

			const result = await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
				logger,
			});

			expect(result.finishReason).toBe("error");

			const stepCloses = sink.records.filter((r) => r.kind === "span-close" && r.name === "step");
			expect(stepCloses).toHaveLength(1);
			if (stepCloses[0]?.kind === "span-close") {
				expect(stepCloses[0].status).toBe("error");
				expect(stepCloses[0].attributes?.["error.message"]).toContain("provider exploded");
			}
		});
	});

	describe("provider logger threading", () => {
		it("passes step span logger to provider.stream opts when logger provided", async () => {
			let capturedOpts: Record<string, unknown> | undefined;

			const provider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools, opts) {
					capturedOpts = opts !== undefined ? { ...opts } : undefined;
					return (async function* () {
						yield { type: "text-delta", delta: "hi" } as ProviderEvent;
						yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } as ProviderEvent;
						yield { type: "finish", reason: "stop" } as ProviderEvent;
					})();
				},
			};

			const { logger } = createTestLogger();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
				logger,
			});

			expect(capturedOpts).toBeDefined();
			expect(capturedOpts?.logger).toBeDefined();
			expect(typeof (capturedOpts?.logger as Record<string, unknown>).info).toBe("function");
			expect(typeof (capturedOpts?.logger as Record<string, unknown>).span).toBe("function");
		});

		it("passes undefined for opts.logger when no logger provided", async () => {
			let capturedOpts: Record<string, unknown> | undefined;

			const provider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools, opts) {
					capturedOpts = opts !== undefined ? { ...opts } : undefined;
					return (async function* () {
						yield { type: "text-delta", delta: "hi" } as ProviderEvent;
						yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } as ProviderEvent;
						yield { type: "finish", reason: "stop" } as ProviderEvent;
					})();
				},
			};

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
			});

			expect(capturedOpts).toBeDefined();
			expect(capturedOpts?.logger).toBeUndefined();
		});
	});
});
