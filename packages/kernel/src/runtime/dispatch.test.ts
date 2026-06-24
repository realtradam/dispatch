import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../contracts/conversation.js";
import type { AgentEvent } from "../contracts/events.js";
import type { ProviderContract, ProviderEvent } from "../contracts/provider.js";
import type { ToolContract, ToolExecuteContext, ToolResult } from "../contracts/tool.js";
import { executeToolCall } from "./dispatch.js";
import { runTurn } from "./run-turn.js";

// ---------------------------------------------------------------------------
// Helpers (no internal mocks — kernel standard; fakes only)
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createFakeProvider(script: ProviderEvent[][]): ProviderContract {
	let callIndex = 0;
	return {
		id: "fake",
		stream() {
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

const noopEmit = () => {};

const userMessage: ChatMessage = {
	role: "user",
	chunks: [{ type: "text", text: "hello" }],
};

const ABORTED_RESULT: ToolResult = { content: "Aborted", isError: true };

// ===========================================================================
// executeToolCall — direct unit tests for the abort-signal race
// ===========================================================================

describe("executeToolCall", () => {
	it("returns the tool's result when the tool resolves before abort", async () => {
		const ac = new AbortController();
		const tool = createFakeTool("echo", async (input) => ({
			content: `echo: ${JSON.stringify(input)}`,
		}));

		const result = await executeToolCall(
			{ id: "tc1", name: "echo", input: { x: 1 } },
			tool,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		expect(result).toEqual({ content: 'echo: {"x":1}' });
	});

	it("returns Aborted immediately when signal is already aborted at call time", async () => {
		const ac = new AbortController();
		ac.abort();
		const tool = createFakeTool("echo", async () => ({ content: "should not run" }));

		const result = await executeToolCall(
			{ id: "tc1", name: "echo", input: {} },
			tool,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		expect(result).toEqual(ABORTED_RESULT);
	});

	it("returns Aborted when a hanging tool is raced against an abort signal", async () => {
		const ac = new AbortController();
		// A tool that never resolves and ignores ctx.signal
		const tool = createFakeTool("hang", () => new Promise<ToolResult>(() => {}));

		const promise = executeToolCall(
			{ id: "tc1", name: "hang", input: {} },
			tool,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		// Abort after the tool has started
		await delay(10);
		ac.abort();

		const result = await promise;
		expect(result).toEqual(ABORTED_RESULT);
	});

	it("returns the tool's own result when a signal-aware tool resolves on abort", async () => {
		const ac = new AbortController();
		const toolResult: ToolResult = { content: "aborted by tool", isError: true };
		const tool = createFakeTool("aware", (_input, ctx) => {
			return new Promise<ToolResult>((resolve) => {
				ctx.signal.addEventListener("abort", () => resolve(toolResult), { once: true });
			});
		});

		const promise = executeToolCall(
			{ id: "tc1", name: "aware", input: {} },
			tool,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		await delay(10);
		ac.abort();

		const result = await promise;
		// The tool listens to the signal and resolves its own result. Whether
		// the tool's result or the race's "Aborted" wins is timing-dependent;
		// both are isError and let the turn seal with finishReason "aborted".
		expect(result.isError).toBe(true);
		expect(result.content).toBe("aborted by tool");
	});

	it("swallows a late rejection from the orphaned tool promise after abort wins the race", async () => {
		const ac = new AbortController();
		let rejectTool: ((err: Error) => void) | undefined;
		const tool = createFakeTool("late-reject", () => {
			return new Promise<ToolResult>((_resolve, reject) => {
				rejectTool = reject;
			});
		});

		const promise = executeToolCall(
			{ id: "tc1", name: "late-reject", input: {} },
			tool,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		await delay(10);
		ac.abort();

		const result = await promise;
		expect(result).toEqual(ABORTED_RESULT);

		// The tool rejects AFTER the race already resolved with "Aborted".
		// The no-op catch must swallow this — no unhandled rejection.
		rejectTool?.(new Error("late boom"));
		// Give the microtask queue a tick to flush
		await delay(5);
		// If we reach here without an unhandledRejection crashing the process,
		// the test passes. (vitest surfaces unhandled rejections as failures.)
	});

	it("returns an error result when the tool rejects before abort", async () => {
		const ac = new AbortController();
		const tool = createFakeTool("boom", async () => {
			throw new Error("tool exploded");
		});

		const result = await executeToolCall(
			{ id: "tc1", name: "boom", input: {} },
			tool,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("tool exploded");
	});

	it("returns Unknown tool when the tool is undefined", async () => {
		const ac = new AbortController();
		const result = await executeToolCall(
			{ id: "tc1", name: "nonexistent", input: {} },
			undefined,
			ac.signal,
			noopEmit,
			"conv-1",
			"turn-1",
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown tool");
	});
});

// ===========================================================================
// runTurn — integration tests for the abort-signal race (durability)
// ===========================================================================

describe("runTurn abort-race durability", () => {
	// Required test 1: A hanging tool (never resolves, ignores ctx.signal)
	// must not keep runTurn from returning when the signal aborts.
	it("hanging tool + abort → runTurn returns with finishReason aborted and emits done", async () => {
		const ac = new AbortController();

		// A tool whose execute returns a promise that NEVER resolves and
		// ignores ctx.signal entirely.
		const tool = createFakeTool("hang", () => new Promise<ToolResult>(() => {}));

		// Use eager: true so the tool starts BEFORE the signal aborts.
		// This exercises the race (not the early signal.aborted return).
		const provider: ProviderContract = {
			id: "fake",
			stream() {
				return (async function* () {
					yield {
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "hang",
						input: {},
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
			dispatch: { maxConcurrent: 1, eager: true },
			conversationId: "conv-1",
			turnId: "turn-1",
			emit,
			signal: ac.signal,
		});

		// runTurn returned (didn't hang) → the race worked.
		expect(result.finishReason).toBe("aborted");

		// A done event was emitted with reason "aborted".
		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
		if (doneEvents[0]?.type === "done") {
			expect(doneEvents[0].reason).toBe("aborted");
		}
	});

	// Required test 2: A signal-aware tool that resolves its own result on
	// abort must also let runTurn return with finishReason "aborted".
	it("signal-aware tool + abort → runTurn returns with finishReason aborted", async () => {
		const ac = new AbortController();

		const tool = createFakeTool("aware", (_input, ctx) => {
			return new Promise<ToolResult>((resolve) => {
				ctx.signal.addEventListener(
					"abort",
					() => resolve({ content: "aborted by tool", isError: true }),
					{ once: true },
				);
			});
		});

		const provider: ProviderContract = {
			id: "fake",
			stream() {
				return (async function* () {
					yield {
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "aware",
						input: {},
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
			dispatch: { maxConcurrent: 1, eager: true },
			conversationId: "conv-1",
			turnId: "turn-1",
			emit,
			signal: ac.signal,
		});

		expect(result.finishReason).toBe("aborted");

		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
		if (doneEvents[0]?.type === "done") {
			expect(doneEvents[0].reason).toBe("aborted");
		}

		// When the step is aborted, tool-result MESSAGES are omitted from the
		// result (the tool-result EVENT is still emitted by executeStep for
		// live UI updates, but the message is not persisted). This prevents
		// orphaned `tool` messages from breaking the next turn's provider
		// request. The assistant message has its tool-call chunks stripped.
		const toolResultMsg = result.messages.find((m) => m.role === "tool");
		expect(toolResultMsg).toBeUndefined();

		// The assistant message should NOT contain tool-call chunks.
		const assistantMsg = result.messages.find(
			(m) => m.role === "assistant" && m.chunks.some((c) => c.type === "tool-call"),
		);
		expect(assistantMsg).toBeUndefined();
	});

	// Required test 3 (regression guard): Without abort, a normal tool runs
	// and its result is used; finishReason reflects the model.
	it("no abort → tool runs normally and its result is used (regression)", async () => {
		const tool = createFakeTool("normal", async (input) => ({
			content: `result: ${JSON.stringify(input)}`,
		}));

		const provider = createFakeProvider([
			[
				{ type: "tool-call", toolCallId: "tc1", toolName: "normal", input: { x: 1 } },
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
			dispatch: { maxConcurrent: 1, eager: true },
			conversationId: "conv-1",
			turnId: "turn-1",
			emit,
		});

		// finishReason reflects the model (second step's "stop").
		expect(result.finishReason).toBe("stop");

		// The tool's result was used (fed back, not "Aborted").
		const toolResultMsg = result.messages.find((m) => m.role === "tool");
		expect(toolResultMsg).toBeDefined();
		const trChunk = toolResultMsg?.chunks[0];
		expect(trChunk?.type).toBe("tool-result");
		if (trChunk?.type === "tool-result") {
			expect(trChunk.content).toBe('result: {"x":1}');
			expect(trChunk.isError).toBe(false);
		}

		// done event emitted with reason "stop".
		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
		if (doneEvents[0]?.type === "done") {
			expect(doneEvents[0].reason).toBe("stop");
		}
	});

	// Bonus: multiple hanging tools + abort → all resolve via the race,
	// drain() doesn't deadlock, and runTurn returns. Tool-result messages
	// are omitted from the result (aborted step); the turn seals cleanly.
	it("multiple hanging tools + abort → drain completes and runTurn returns", async () => {
		const ac = new AbortController();

		// Two tools that never resolve and ignore ctx.signal.
		const toolA = createFakeTool("hangA", () => new Promise<ToolResult>(() => {}));
		const toolB = createFakeTool("hangB", () => new Promise<ToolResult>(() => {}));

		const provider: ProviderContract = {
			id: "fake",
			stream() {
				return (async function* () {
					yield {
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "hangA",
						input: {},
					} as ProviderEvent;
					yield {
						type: "tool-call",
						toolCallId: "tc2",
						toolName: "hangB",
						input: {},
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
			tools: [toolA, toolB],
			dispatch: { maxConcurrent: 2, eager: true },
			conversationId: "conv-1",
			turnId: "turn-1",
			emit,
			signal: ac.signal,
		});

		expect(result.finishReason).toBe("aborted");

		// tool-result EVENTS are still emitted by executeStep (for live UI),
		// but tool-result MESSAGES are omitted from the result (not persisted).
		const toolResultEvents = events.filter((e) => e.type === "tool-result");
		expect(toolResultEvents).toHaveLength(2);
		for (const tr of toolResultEvents) {
			if (tr.type === "tool-result") {
				expect(tr.isError).toBe(true);
			}
		}

		// No tool messages in the result (they would orphan on the next turn).
		const toolMessages = result.messages.filter((m) => m.role === "tool");
		expect(toolMessages).toHaveLength(0);

		// Assistant message has no tool-call chunks.
		const assistantMsgs = result.messages.filter((m) => m.role === "assistant");
		for (const msg of assistantMsgs) {
			expect(msg.chunks.some((c) => c.type === "tool-call")).toBe(false);
		}

		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
		if (doneEvents[0]?.type === "done") {
			expect(doneEvents[0].reason).toBe("aborted");
		}
	});

	// Critical regression: after an aborted tool call, the result messages
	// must NOT contain orphaned tool messages. If they did, the next turn
	// would send a `tool` role message to the provider without a preceding
	// `assistant` message carrying `tool_calls` → 400 error.
	it("aborted step produces no tool messages and no tool-call chunks in result", async () => {
		const ac = new AbortController();

		// Tool that hangs forever
		const tool = createFakeTool("hang", () => new Promise<ToolResult>(() => {}));

		const provider: ProviderContract = {
			id: "fake",
			stream() {
				return (async function* () {
					yield { type: "text-delta", delta: "Let me run that for you" } as ProviderEvent;
					yield {
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "hang",
						input: {},
					} as ProviderEvent;
					ac.abort();
					await delay(10);
					yield { type: "finish", reason: "tool-calls" } as ProviderEvent;
				})();
			},
		};

		const result = await runTurn({
			provider,
			messages: [userMessage],
			tools: [tool],
			dispatch: { maxConcurrent: 1, eager: true },
			conversationId: "conv-1",
			turnId: "turn-1",
			emit: noopEmit,
			signal: ac.signal,
		});

		expect(result.finishReason).toBe("aborted");

		// No tool messages in the result
		const toolMessages = result.messages.filter((m) => m.role === "tool");
		expect(toolMessages).toHaveLength(0);

		// The assistant message should preserve text but NOT tool-call chunks
		const assistantMsg = result.messages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		if (assistantMsg !== undefined) {
			const hasToolCall = assistantMsg.chunks.some((c) => c.type === "tool-call");
			expect(hasToolCall).toBe(false);
			// Text content should be preserved
			const hasText = assistantMsg.chunks.some((c) => c.type === "text");
			expect(hasText).toBe(true);
		}

		// Simulate what the next turn would see: the result messages are the
		// conversation history (minus the user message). If we feed these to
		// a simple converter, there should be NO `tool` role messages.
		const toolRoleCount = result.messages.filter((m) => m.role === "tool").length;
		expect(toolRoleCount).toBe(0);
	});
});
