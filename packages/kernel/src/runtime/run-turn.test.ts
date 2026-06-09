import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../contracts/conversation.js";
import type { AgentEvent } from "../contracts/events.js";
import type { LogDeps, Logger, LogRecord, LogSink } from "../contracts/logging.js";
import type { ProviderContract, ProviderEvent } from "../contracts/provider.js";
import type { ToolContract, ToolExecuteContext, ToolResult } from "../contracts/tool.js";
import { createLogger } from "../logging/logger.js";
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
		expect(eventTypes).toEqual([
			"turn-start",
			"text-delta",
			"text-delta",
			"reasoning-delta",
			"usage",
			"step-complete",
			"done",
		]);
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

	it("forwards cwd from RunTurnInput to ToolExecuteContext", async () => {
		let capturedCwd: string | undefined = "SENTINEL_NOT_SET";

		const tool = createFakeTool("cwdcheck", async (_input, ctx) => {
			capturedCwd = ctx.cwd;
			return { content: "ok" };
		});

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "cwdcheck", input: {} },
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
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
			cwd: "/some/dir",
		});

		expect(capturedCwd).toBe("/some/dir");
	});

	it("forwards undefined cwd when RunTurnInput has no cwd", async () => {
		let capturedCwd: string | undefined = "SENTINEL_NOT_SET";

		const tool = createFakeTool("cwdcheck", async (_input, ctx) => {
			capturedCwd = ctx.cwd;
			return { content: "ok" };
		});

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "cwdcheck", input: {} },
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
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: false },
			conversationId: "tab-test",
			turnId: "turn-test",
			emit: () => {},
		});

		expect(capturedCwd).toBeUndefined();
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

		it("emits a prompt span with verbatim body and small scalar attributes", async () => {
			const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

			const provider = createFakeProvider([
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

			const promptOpens = sink.records.filter((r) => r.kind === "span-open" && r.name === "prompt");
			expect(promptOpens).toHaveLength(1);

			const promptOpen = promptOpens[0];
			if (promptOpen?.kind === "span-open") {
				expect(promptOpen.body).toBeDefined();
				const parsed = JSON.parse(promptOpen.body as string);
				expect(parsed.messages).toEqual([userMessage]);
				expect(parsed.tools).toHaveLength(1);
				expect(parsed.tools[0].name).toBe("echo");

				expect(promptOpen.attributes?.messageCount).toBe(1);
				expect(promptOpen.attributes?.toolCount).toBe(1);
			}

			const promptCloses = sink.records.filter(
				(r) => r.kind === "span-close" && r.name === "prompt",
			);
			expect(promptCloses).toHaveLength(1);

			const logRecords = sink.records.filter(
				(r) =>
					r.kind === "log" && r.kind === "log" && (r as { msg: string }).msg === "prompt:before",
			);
			expect(logRecords).toHaveLength(0);
		});

		it("emits ttft and decode spans for a generating step", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "Hello" },
					{ type: "text-delta", delta: " world" },
					{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
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

			const ttftOpens = sink.records.filter((r) => r.kind === "span-open" && r.name === "ttft");
			const ttftCloses = sink.records.filter((r) => r.kind === "span-close" && r.name === "ttft");
			const decodeOpens = sink.records.filter((r) => r.kind === "span-open" && r.name === "decode");
			const decodeCloses = sink.records.filter(
				(r) => r.kind === "span-close" && r.name === "decode",
			);

			expect(ttftOpens).toHaveLength(1);
			expect(ttftCloses).toHaveLength(1);
			expect(decodeOpens).toHaveLength(1);
			expect(decodeCloses).toHaveLength(1);

			const stepOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "step");
			expect(stepOpen).toBeDefined();

			if (
				ttftOpens[0]?.kind === "span-open" &&
				ttftCloses[0]?.kind === "span-close" &&
				decodeOpens[0]?.kind === "span-open" &&
				decodeCloses[0]?.kind === "span-close" &&
				stepOpen?.kind === "span-open"
			) {
				// ttft and decode are children of step
				expect(ttftOpens[0].parentSpanId).toBe(stepOpen.spanId);
				expect(decodeOpens[0].parentSpanId).toBe(stepOpen.spanId);

				// ttft closes before decode opens (in order)
				const ttftCloseIdx = sink.records.indexOf(ttftCloses[0]);
				const decodeOpenIdx = sink.records.indexOf(decodeOpens[0]);
				expect(ttftCloseIdx).toBeLessThan(decodeOpenIdx);

				// ttft has firstToken: true
				expect(ttftCloses[0].attributes?.firstToken).toBe(true);

				// durations from fake clock
				expect(ttftCloses[0].durationMs).toBeGreaterThanOrEqual(0);
				expect(decodeCloses[0].durationMs).toBeGreaterThanOrEqual(0);
			}
		});

		it("first token counts a reasoning delta", async () => {
			const provider = createFakeProvider([
				[
					{ type: "reasoning-delta", delta: "thinking..." },
					{ type: "text-delta", delta: "Hello" },
					{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
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

			const ttftCloses = sink.records.filter((r) => r.kind === "span-close" && r.name === "ttft");
			expect(ttftCloses).toHaveLength(1);

			// The ttft span should close at the reasoning delta, not at the text delta
			if (ttftCloses[0]?.kind === "span-close") {
				expect(ttftCloses[0].attributes?.firstToken).toBe(true);
			}
		});

		it("a step with no content token does not emit a misleading decode", async () => {
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

			const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

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

			// First step (tool-call-only) should have ttft with firstToken: false and no decode
			const ttftOpens = sink.records.filter((r) => r.kind === "span-open" && r.name === "ttft");
			const ttftCloses = sink.records.filter((r) => r.kind === "span-close" && r.name === "ttft");
			const decodeOpens = sink.records.filter((r) => r.kind === "span-open" && r.name === "decode");

			// There should be 2 ttft opens (one per step) and 2 ttft closes
			expect(ttftOpens).toHaveLength(2);
			expect(ttftCloses).toHaveLength(2);

			// First step: tool-call-only, no first token
			if (ttftCloses[0]?.kind === "span-close") {
				expect(ttftCloses[0].attributes?.firstToken).toBe(false);
			}

			// Second step: has text-delta, should have firstToken: true and decode span
			if (ttftCloses[1]?.kind === "span-close") {
				expect(ttftCloses[1].attributes?.firstToken).toBe(true);
			}

			// Only one decode span (for the second step)
			expect(decodeOpens).toHaveLength(1);
		});

		it("turn span close stamps usage.inputTokens / usage.outputTokens (dotted)", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
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

			const turnClose = sink.records.find((r) => r.kind === "span-close" && r.name === "turn");
			expect(turnClose).toBeDefined();
			if (turnClose?.kind === "span-close") {
				expect(turnClose.attributes?.["usage.inputTokens"]).toBe(10);
				expect(turnClose.attributes?.["usage.outputTokens"]).toBe(5);
				expect(turnClose.attributes?.usage_inputTokens).toBeUndefined();
				expect(turnClose.attributes?.usage_outputTokens).toBeUndefined();
			}
		});

		it("step span close stamps usage.inputTokens / usage.outputTokens (dotted)", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{ type: "usage", usage: { inputTokens: 7, outputTokens: 3 } },
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

			const stepClose = sink.records.find((r) => r.kind === "span-close" && r.name === "step");
			expect(stepClose).toBeDefined();
			if (stepClose?.kind === "span-close") {
				expect(stepClose.attributes?.["usage.inputTokens"]).toBe(7);
				expect(stepClose.attributes?.["usage.outputTokens"]).toBe(3);
				expect(stepClose.attributes?.usage_inputTokens).toBeUndefined();
				expect(stepClose.attributes?.usage_outputTokens).toBeUndefined();
			}
		});

		it("turn + step spans stamp usage.cacheReadTokens / usage.cacheWriteTokens when the provider Usage carries them", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{
						type: "usage",
						usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
					},
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

			const turnClose = sink.records.find((r) => r.kind === "span-close" && r.name === "turn");
			const stepClose = sink.records.find((r) => r.kind === "span-close" && r.name === "step");

			expect(turnClose).toBeDefined();
			if (turnClose?.kind === "span-close") {
				expect(turnClose.attributes?.["usage.inputTokens"]).toBe(10);
				expect(turnClose.attributes?.["usage.outputTokens"]).toBe(5);
				expect(turnClose.attributes?.["usage.cacheReadTokens"]).toBe(3);
				expect(turnClose.attributes?.["usage.cacheWriteTokens"]).toBe(2);
			}

			expect(stepClose).toBeDefined();
			if (stepClose?.kind === "span-close") {
				expect(stepClose.attributes?.["usage.inputTokens"]).toBe(10);
				expect(stepClose.attributes?.["usage.outputTokens"]).toBe(5);
				expect(stepClose.attributes?.["usage.cacheReadTokens"]).toBe(3);
				expect(stepClose.attributes?.["usage.cacheWriteTokens"]).toBe(2);
			}
		});

		it("turn + step spans OMIT the cache-token attrs when the provider Usage lacks them", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
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

			const turnClose = sink.records.find((r) => r.kind === "span-close" && r.name === "turn");
			const stepClose = sink.records.find((r) => r.kind === "span-close" && r.name === "step");

			expect(turnClose).toBeDefined();
			if (turnClose?.kind === "span-close") {
				expect(turnClose.attributes?.["usage.inputTokens"]).toBe(10);
				expect(turnClose.attributes?.["usage.outputTokens"]).toBe(5);
				expect(turnClose.attributes?.["usage.cacheReadTokens"]).toBeUndefined();
				expect(turnClose.attributes?.["usage.cacheWriteTokens"]).toBeUndefined();
			}

			expect(stepClose).toBeDefined();
			if (stepClose?.kind === "span-close") {
				expect(stepClose.attributes?.["usage.inputTokens"]).toBe(10);
				expect(stepClose.attributes?.["usage.outputTokens"]).toBe(5);
				expect(stepClose.attributes?.["usage.cacheReadTokens"]).toBeUndefined();
				expect(stepClose.attributes?.["usage.cacheWriteTokens"]).toBeUndefined();
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

	describe("span tree nesting", () => {
		it("turn span is root (parentSpanId undefined)", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
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

			const turnOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "turn");
			expect(turnOpen).toBeDefined();
			if (turnOpen?.kind === "span-open") {
				expect(turnOpen.parentSpanId).toBeUndefined();
			}
		});

		it("step span is a child of turn span", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
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

			const turnOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "turn");
			const stepOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "step");
			expect(turnOpen).toBeDefined();
			expect(stepOpen).toBeDefined();
			if (turnOpen?.kind === "span-open" && stepOpen?.kind === "span-open") {
				expect(stepOpen.parentSpanId).toBe(turnOpen.spanId);
			}
		});

		it("prompt span is a child of step span", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
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

			const stepOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "step");
			const promptOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "prompt");
			expect(stepOpen).toBeDefined();
			expect(promptOpen).toBeDefined();
			if (stepOpen?.kind === "span-open" && promptOpen?.kind === "span-open") {
				expect(promptOpen.parentSpanId).toBe(stepOpen.spanId);
			}
		});

		it("provider logger creates spans nested under step", async () => {
			let capturedLogger: Logger | undefined;
			let providerReqSpanId: string | undefined;

			const provider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools, opts) {
					capturedLogger = opts?.logger;
					return (async function* () {
						// Open provider.request span inside the stream (like a real provider)
						if (capturedLogger !== undefined) {
							const span = capturedLogger.span("provider.request");
							providerReqSpanId = span.id;
							span.end();
						}
						yield { type: "text-delta", delta: "hi" } as ProviderEvent;
						yield { type: "finish", reason: "stop" } as ProviderEvent;
					})();
				},
			};

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

			expect(capturedLogger).toBeDefined();
			expect(providerReqSpanId).toBeDefined();

			const stepOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "step");
			const provReqOpen = sink.records.find(
				(r) => r.kind === "span-open" && r.name === "provider.request",
			);
			expect(stepOpen).toBeDefined();
			expect(provReqOpen).toBeDefined();
			if (stepOpen?.kind === "span-open" && provReqOpen?.kind === "span-open") {
				expect(provReqOpen.parentSpanId).toBe(stepOpen.spanId);
				expect(provReqOpen.spanId).toBe(providerReqSpanId);
			}
		});

		it("tool-call spans are children of step span", async () => {
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

			const stepOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "step");
			const tcOpen = sink.records.find((r) => r.kind === "span-open" && r.name === "tool-call");
			expect(stepOpen).toBeDefined();
			expect(tcOpen).toBeDefined();
			if (stepOpen?.kind === "span-open" && tcOpen?.kind === "span-open") {
				expect(tcOpen.parentSpanId).toBe(stepOpen.spanId);
			}
		});

		it("full parent chain: turn → step → {prompt, provider.request, tool-call}", async () => {
			let capturedLogger: Logger | undefined;

			const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

			let streamCallCount = 0;
			const provider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools, opts) {
					capturedLogger = opts?.logger;
					streamCallCount++;
					return (async function* () {
						// Simulate provider opening a provider.request span
						// INSIDE the stream on the first call only (like a real provider)
						if (streamCallCount === 1 && capturedLogger !== undefined) {
							const span = capturedLogger.span("provider.request");
							span.end();
						}
						if (streamCallCount === 1) {
							yield {
								type: "tool-call",
								toolCallId: "tc1",
								toolName: "echo",
								input: {},
							} as ProviderEvent;
							yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
						} else {
							yield { type: "text-delta", delta: "done" } as ProviderEvent;
							yield { type: "finish", reason: "stop" } as ProviderEvent;
						}
					})();
				},
			};

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

			const spanOpens = sink.records.filter((r) => r.kind === "span-open") as Array<
				Extract<LogRecord, { kind: "span-open" }>
			>;

			const turnOpen = spanOpens.find((r) => r.name === "turn");
			const stepOpen = spanOpens.find((r) => r.name === "step");
			const promptOpen = spanOpens.find((r) => r.name === "prompt");
			const provReqOpen = spanOpens.find((r) => r.name === "provider.request");
			const tcOpen = spanOpens.find((r) => r.name === "tool-call");

			expect(turnOpen).toBeDefined();
			expect(stepOpen).toBeDefined();
			expect(promptOpen).toBeDefined();
			expect(provReqOpen).toBeDefined();
			expect(tcOpen).toBeDefined();

			if (
				turnOpen?.kind === "span-open" &&
				stepOpen?.kind === "span-open" &&
				promptOpen?.kind === "span-open" &&
				provReqOpen?.kind === "span-open" &&
				tcOpen?.kind === "span-open"
			) {
				// turn = root
				expect(turnOpen.parentSpanId).toBeUndefined();

				// step = child of turn
				expect(stepOpen.parentSpanId).toBe(turnOpen.spanId);

				// prompt = child of step
				expect(promptOpen.parentSpanId).toBe(stepOpen.spanId);

				// provider.request = child of step
				expect(provReqOpen.parentSpanId).toBe(stepOpen.spanId);

				// tool-call = child of step
				expect(tcOpen.parentSpanId).toBe(stepOpen.spanId);
			}
		});
	});

	describe("lifecycle events", () => {
		it("emits turn-start as the first event with conversation + turn ids", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
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

			expect(events[0]?.type).toBe("turn-start");
			if (events[0]?.type === "turn-start") {
				expect(events[0].conversationId).toBe("conv-42");
				expect(events[0].turnId).toBe("turn-99");
			}
		});

		it("emits a single done event last, carrying the finishReason", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "Hello" },
					{ type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { events, emit } = createCollectingEmit();

			const result = await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			const lastEvent = events[events.length - 1];
			expect(lastEvent?.type).toBe("done");
			if (lastEvent?.type === "done") {
				expect(lastEvent.reason).toBe(result.finishReason);
				expect(lastEvent.conversationId).toBe("conv-1");
				expect(lastEvent.turnId).toBe("turn-1");
			}

			const doneEvents = events.filter((e) => e.type === "done");
			expect(doneEvents).toHaveLength(1);
		});

		it("emits done after a tool-call turn", async () => {
			const tool = createFakeTool("echo", async (input) => ({
				content: `echo: ${JSON.stringify(input)}`,
			}));

			const provider = createFakeProvider([
				[
					{ type: "tool-call", toolCallId: "tc1", toolName: "echo", input: { x: 1 } },
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
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			const lastEvent = events[events.length - 1];
			expect(lastEvent?.type).toBe("done");
			if (lastEvent?.type === "done") {
				expect(lastEvent.reason).toBe(result.finishReason);
			}
		});

		it('still emits done with reason "aborted" when the turn is aborted via signal', async () => {
			const ac = new AbortController();
			ac.abort();

			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "should not appear" },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { events, emit } = createCollectingEmit();

			const result = await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
				signal: ac.signal,
			});

			expect(result.finishReason).toBe("aborted");

			const lastEvent = events[events.length - 1];
			expect(lastEvent?.type).toBe("done");
			if (lastEvent?.type === "done") {
				expect(lastEvent.reason).toBe("aborted");
			}
		});

		it('still emits done with reason "error" when the provider errors', async () => {
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
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			expect(result.finishReason).toBe("error");

			const lastEvent = events[events.length - 1];
			expect(lastEvent?.type).toBe("done");
			if (lastEvent?.type === "done") {
				expect(lastEvent.reason).toBe("error");
			}
		});

		it("turn-start precedes every delta and done follows every delta", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "Hello" },
					{ type: "reasoning-delta", delta: "thinking..." },
					{ type: "text-delta", delta: " world" },
					{ type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			const turnStartIdx = events.findIndex((e) => e.type === "turn-start");
			const doneIdx = events.findIndex((e) => e.type === "done");

			expect(turnStartIdx).toBe(0);
			expect(doneIdx).toBe(events.length - 1);

			for (let i = 0; i < events.length; i++) {
				const e = events[i];
				if (e?.type === "text-delta" || e?.type === "reasoning-delta") {
					expect(i).toBeGreaterThan(turnStartIdx);
					expect(i).toBeLessThan(doneIdx);
				}
			}
		});
	});

	describe("stepId", () => {
		it("tool-call and tool-result events carry stepId", async () => {
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

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			const toolCallEvt = events.find((e) => e.type === "tool-call");
			const toolResultEvt = events.find((e) => e.type === "tool-result");

			expect(toolCallEvt).toBeDefined();
			expect(toolResultEvt).toBeDefined();

			if (toolCallEvt?.type === "tool-call" && toolResultEvt?.type === "tool-result") {
				expect(toolCallEvt.stepId).toBeDefined();
				expect(toolResultEvt.stepId).toBeDefined();
				expect(toolCallEvt.stepId).toBe(toolResultEvt.stepId);
			}
		});

		it("tool calls in the SAME step share one stepId; a later step gets a different one", async () => {
			const toolA = createFakeTool("a", async () => ({ content: "a-result" }));
			const toolB = createFakeTool("b", async () => ({ content: "b-result" }));

			const provider = createFakeProvider([
				[
					{ type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
					{ type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} },
					{ type: "finish", reason: "tool-calls" },
				],
				[
					{ type: "tool-call", toolCallId: "tc3", toolName: "a", input: {} },
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
				tools: [toolA, toolB],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			const toolCallEvts = events.filter((e) => e.type === "tool-call");
			expect(toolCallEvts.length).toBeGreaterThanOrEqual(2);

			const step0Calls = toolCallEvts.filter(
				(e) => e.type === "tool-call" && (e.toolCallId === "tc1" || e.toolCallId === "tc2"),
			);
			const step1Call = toolCallEvts.find((e) => e.type === "tool-call" && e.toolCallId === "tc3");

			expect(step0Calls).toHaveLength(2);
			if (step0Calls[0]?.type === "tool-call" && step0Calls[1]?.type === "tool-call") {
				expect(step0Calls[0].stepId).toBe(step0Calls[1].stepId);
			}

			if (step1Call?.type === "tool-call" && step0Calls[0]?.type === "tool-call") {
				expect(step1Call.stepId).not.toBe(step0Calls[0].stepId);
			}
		});

		it("tool chunks in the result carry stepId", async () => {
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

			const result = await runTurn({
				provider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit: () => {},
			});

			const toolCallMsg = result.messages.find(
				(m) => m.role === "assistant" && m.chunks.some((c) => c.type === "tool-call"),
			);
			const toolResultMsg = result.messages.find((m) => m.role === "tool");

			expect(toolCallMsg).toBeDefined();
			expect(toolResultMsg).toBeDefined();

			const tcChunk = toolCallMsg?.chunks.find((c) => c.type === "tool-call");
			const trChunk = toolResultMsg?.chunks[0];

			expect(tcChunk?.type).toBe("tool-call");
			expect(trChunk?.type).toBe("tool-result");

			if (tcChunk?.type === "tool-call" && trChunk?.type === "tool-result") {
				expect(tcChunk.stepId).toBeDefined();
				expect(trChunk.stepId).toBeDefined();
				expect(tcChunk.stepId).toBe(trChunk.stepId);
			}
		});
	});

	describe("timing events (now provided)", () => {
		function createCounterNow(): { now: () => number; tick: (ms: number) => void } {
			let current = 0;
			return {
				now: () => current,
				tick: (ms: number) => {
					current += ms;
				},
			};
		}

		it("emits step-complete per step with timing when now provided", async () => {
			const clock = createCounterNow();
			clock.tick(100); // turn starts at 100

			const { events, emit } = createCollectingEmit();

			// Advance clock during stream: first token at +50ms, stream ends at +200ms
			let streamCallCount = 0;
			const wrappedProvider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools) {
					const idx = streamCallCount++;
					return (async function* () {
						if (idx === 0) {
							clock.tick(50); // stream starts
							yield { type: "text-delta", delta: "Hello" } as ProviderEvent;
							// first token seen at 150 (100+50)
							clock.tick(100);
							yield { type: "text-delta", delta: " world" } as ProviderEvent;
							clock.tick(50);
							yield {
								type: "usage",
								usage: { inputTokens: 10, outputTokens: 5 },
							} as ProviderEvent;
							yield { type: "finish", reason: "stop" } as ProviderEvent;
						}
					})();
				},
			};

			await runTurn({
				provider: wrappedProvider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
				now: clock.now,
			});

			const stepCompleteEvts = events.filter((e) => e.type === "step-complete");
			expect(stepCompleteEvts).toHaveLength(1);

			const sc = stepCompleteEvts[0];
			if (sc?.type === "step-complete") {
				expect(sc.conversationId).toBe("conv-1");
				expect(sc.turnId).toBe("turn-1");
				expect(sc.stepId).toBeDefined();
				expect(sc.genTotalMs).toBe(200); // 50+100+50
				expect(sc.ttftMs).toBe(50); // stream start → first text-delta
				expect(sc.decodeMs).toBe(150); // first token → stream end
				const ttft = sc.ttftMs;
				const decode = sc.decodeMs;
				const genTotal = sc.genTotalMs;
				if (ttft !== undefined && decode !== undefined && genTotal !== undefined) {
					expect(genTotal).toBe(ttft + decode);
				}
			}
		});

		it("step-complete omits ttft/decode but keeps genTotalMs for a no-content step", async () => {
			const clock = createCounterNow();
			clock.tick(100); // turn starts at 100

			const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

			let streamCallCount = 0;
			const wrappedProvider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools) {
					const idx = streamCallCount++;
					return (async function* () {
						if (idx === 0) {
							clock.tick(80); // stream starts at 180
							yield {
								type: "tool-call",
								toolCallId: "tc1",
								toolName: "echo",
								input: {},
							} as ProviderEvent;
							clock.tick(20);
							yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
						} else {
							clock.tick(50);
							yield { type: "text-delta", delta: "done" } as ProviderEvent;
							clock.tick(50);
							yield { type: "finish", reason: "stop" } as ProviderEvent;
						}
					})();
				},
			};

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider: wrappedProvider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
				now: clock.now,
			});

			const stepCompleteEvts = events.filter((e) => e.type === "step-complete");
			expect(stepCompleteEvts).toHaveLength(2);

			// First step: tool-call-only, no content token
			const sc0 = stepCompleteEvts[0];
			if (sc0?.type === "step-complete") {
				expect(sc0.stepId).toBeDefined();
				expect(sc0.genTotalMs).toBe(100); // 80+20
				expect(sc0.ttftMs).toBeUndefined();
				expect(sc0.decodeMs).toBeUndefined();
			}

			// Second step: has text-delta
			const sc1 = stepCompleteEvts[1];
			if (sc1?.type === "step-complete") {
				expect(sc1.stepId).toBeDefined();
				expect(sc1.genTotalMs).toBe(100); // 50+50
				expect(sc1.ttftMs).toBe(50);
				expect(sc1.decodeMs).toBe(50);
			}
		});

		it("usage event carries stepId", async () => {
			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{ type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
			});

			const usageEvts = events.filter((e) => e.type === "usage");
			expect(usageEvts).toHaveLength(1);
			const ue = usageEvts[0];
			if (ue?.type === "usage") {
				expect(ue.stepId).toBeDefined();
			}
		});

		it("tool-result carries durationMs (execution time) when now provided", async () => {
			const clock = createCounterNow();
			clock.tick(100); // turn starts at 100

			const tool = createFakeTool("slow", async () => {
				clock.tick(200); // tool takes 200ms to execute
				return { content: "done" };
			});

			const provider = createFakeProvider([
				[
					{ type: "tool-call", toolCallId: "tc1", toolName: "slow", input: {} },
					{ type: "finish", reason: "tool-calls" },
				],
				[
					{ type: "text-delta", delta: "ok" },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
				now: clock.now,
			});

			const toolResultEvts = events.filter((e) => e.type === "tool-result");
			expect(toolResultEvts).toHaveLength(1);
			const tr = toolResultEvts[0];
			if (tr?.type === "tool-result") {
				expect(tr.durationMs).toBeDefined();
				expect(tr.durationMs).toBe(200);
			}
		});

		it("done carries durationMs and aggregate usage when now provided", async () => {
			const clock = createCounterNow();
			clock.tick(100); // turn starts at 100

			const wrappedProvider: ProviderContract = {
				id: "fake",
				stream(_messages, _tools) {
					return (async function* () {
						clock.tick(80); // stream duration
						yield { type: "text-delta", delta: "hi" } as ProviderEvent;
						yield {
							type: "usage",
							usage: { inputTokens: 10, outputTokens: 5 },
						} as ProviderEvent;
						yield { type: "finish", reason: "stop" } as ProviderEvent;
					})();
				},
			};

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider: wrappedProvider,
				messages: [userMessage],
				tools: [],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
				now: clock.now,
			});

			const doneEvts = events.filter((e) => e.type === "done");
			expect(doneEvts).toHaveLength(1);
			const d = doneEvts[0];
			if (d?.type === "done") {
				expect(d.durationMs).toBeDefined();
				expect(d.durationMs).toBeGreaterThan(0);
				expect(d.usage).toBeDefined();
				if (d.usage !== undefined) {
					expect(d.usage.inputTokens).toBe(10);
					expect(d.usage.outputTokens).toBe(5);
				}
			}
		});

		it("no now → timing fields absent", async () => {
			const tool = createFakeTool("echo", async () => ({ content: "echoed" }));

			const provider = createFakeProvider([
				[
					{ type: "text-delta", delta: "hi" },
					{ type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
					{ type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
					{ type: "finish", reason: "tool-calls" },
				],
				[
					{ type: "text-delta", delta: "done" },
					{ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
					{ type: "finish", reason: "stop" },
				],
			]);

			const { events, emit } = createCollectingEmit();

			await runTurn({
				provider,
				messages: [userMessage],
				tools: [tool],
				dispatch: { maxConcurrent: 1, eager: false },
				conversationId: "conv-1",
				turnId: "turn-1",
				emit,
				// no now
			});

			// step-complete still emitted (with stepId, no timing)
			const stepCompleteEvts = events.filter((e) => e.type === "step-complete");
			expect(stepCompleteEvts).toHaveLength(2);
			for (const sc of stepCompleteEvts) {
				if (sc?.type === "step-complete") {
					expect(sc.stepId).toBeDefined();
					expect(sc.ttftMs).toBeUndefined();
					expect(sc.decodeMs).toBeUndefined();
					expect(sc.genTotalMs).toBeUndefined();
				}
			}

			// usage still carries stepId
			const usageEvts = events.filter((e) => e.type === "usage");
			for (const ue of usageEvts) {
				if (ue?.type === "usage") {
					expect(ue.stepId).toBeDefined();
				}
			}

			// no durationMs on tool-result
			const toolResultEvts = events.filter((e) => e.type === "tool-result");
			for (const tr of toolResultEvts) {
				if (tr?.type === "tool-result") {
					expect(tr.durationMs).toBeUndefined();
				}
			}

			// no durationMs on done, but usage is present (independent of now)
			const doneEvts = events.filter((e) => e.type === "done");
			expect(doneEvts).toHaveLength(1);
			const d = doneEvts[0];
			if (d?.type === "done") {
				expect(d.durationMs).toBeUndefined();
				expect(d.usage).toBeDefined();
				if (d.usage !== undefined) {
					expect(d.usage.inputTokens).toBe(15);
					expect(d.usage.outputTokens).toBe(8);
				}
			}
		});
	});
});
