import { describe, expect, it } from "vitest";
import { appendEventToChunks, applySystemEvent } from "../../src/chunks/append.js";
import type { AgentEvent, ChatMessage, Chunk } from "../../src/types/index.js";

// ─── helpers ─────────────────────────────────────────────────────

const td = (delta: string): AgentEvent => ({ type: "text-delta", delta });
const rd = (delta: string): AgentEvent => ({ type: "reasoning-delta", delta });
const re = (metadata?: Record<string, unknown>): AgentEvent => ({
	type: "reasoning-end",
	...(metadata !== undefined ? { metadata } : {}),
});
const tc = (id: string, name = "fake_tool", args: Record<string, unknown> = {}): AgentEvent => ({
	type: "tool-call",
	toolCall: { id, name, arguments: args },
});
const tr = (toolCallId: string, result: string, isError = false): AgentEvent => ({
	type: "tool-result",
	toolResult: { toolCallId, toolName: "fake_tool", result, isError },
});
const so = (data: string, stream: "stdout" | "stderr" = "stdout"): AgentEvent => ({
	type: "shell-output",
	data,
	stream,
});
const err = (error: string, statusCode?: number): AgentEvent => ({
	type: "error",
	error,
	...(statusCode !== undefined ? { statusCode } : {}),
});
const notice = (message: string): AgentEvent => ({ type: "notice", message });
const modelChanged = (keyId: string, modelId: string): AgentEvent => ({
	type: "model-changed",
	keyId,
	modelId,
});
const configReload: AgentEvent = { type: "config-reload" };

function run(events: AgentEvent[]): Chunk[] {
	const chunks: Chunk[] = [];
	for (const e of events) appendEventToChunks(chunks, e);
	return chunks;
}

// ─── Required cases from the plan ────────────────────────────────

describe("appendEventToChunks — required cases from plan", () => {
	it("empty chunks + text-delta → one text chunk with the delta", () => {
		const chunks = run([td("Hello")]);
		expect(chunks).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("two consecutive text-deltas → one text chunk with concatenated text", () => {
		const chunks = run([td("Hello, "), td("world!")]);
		expect(chunks).toEqual([{ type: "text", text: "Hello, world!" }]);
	});

	it("text-delta then reasoning-delta → two chunks (text, thinking)", () => {
		const chunks = run([td("ans: 42"), rd("I should explain")]);
		expect(chunks).toEqual([
			{ type: "text", text: "ans: 42" },
			{ type: "thinking", text: "I should explain" },
		]);
	});

	it("text-delta then tool-call → two chunks (text, tool-batch with one entry)", () => {
		const chunks = run([td("Looking..."), tc("t1", "read_file", { path: "x" })]);
		expect(chunks).toEqual([
			{ type: "text", text: "Looking..." },
			{
				type: "tool-batch",
				calls: [{ id: "t1", name: "read_file", arguments: { path: "x" } }],
			},
		]);
	});

	it("two consecutive tool-calls → one tool-batch with two entries", () => {
		const chunks = run([tc("t1", "read_file"), tc("t2", "list_files")]);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			type: "tool-batch",
			calls: [
				{ id: "t1", name: "read_file" },
				{ id: "t2", name: "list_files" },
			],
		});
	});

	it("tool-call then tool-call then text → two chunks (tool-batch with 2 entries, text)", () => {
		const chunks = run([tc("t1"), tc("t2"), td("done")]);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toMatchObject({
			type: "tool-batch",
			calls: [{ id: "t1" }, { id: "t2" }],
		});
		expect(chunks[1]).toEqual({ type: "text", text: "done" });
	});

	it("tool-result arrives → updates matching tool-call entry in the latest tool-batch chunk by id", () => {
		const chunks = run([
			tc("t1"),
			tc("t2"),
			tr("t1", "first-result"),
			tr("t2", "second-result", true),
		]);
		expect(chunks).toHaveLength(1);
		const batch = chunks[0];
		expect(batch.type).toBe("tool-batch");
		if (batch.type !== "tool-batch") throw new Error("type guard");
		expect(batch.calls[0]).toMatchObject({ id: "t1", result: "first-result", isError: false });
		expect(batch.calls[1]).toMatchObject({ id: "t2", result: "second-result", isError: true });
	});

	it("shell-output arrives → appends to the most recent tool-call's shellOutput", () => {
		const chunks = run([
			tc("t1", "run_shell"),
			so("hello\n", "stdout"),
			so("world\n", "stdout"),
			so("err!\n", "stderr"),
		]);
		expect(chunks).toHaveLength(1);
		const batch = chunks[0];
		if (batch.type !== "tool-batch") throw new Error("type guard");
		expect(batch.calls[0]?.shellOutput).toEqual({
			stdout: "hello\nworld\n",
			stderr: "err!\n",
		});
	});

	it("error event → opens an error chunk; subsequent events go to new chunks", () => {
		const chunks = run([td("partial..."), err("network failed", 503), td("recovery")]);
		expect(chunks).toEqual([
			{ type: "text", text: "partial..." },
			{ type: "error", message: "network failed", statusCode: 503 },
			{ type: "text", text: "recovery" },
		]);
	});

	it("system event during text run → closes text, opens system, would re-open text on next text-delta", () => {
		const chunks = run([td("first "), notice("model swap"), td("second")]);
		expect(chunks).toEqual([
			{ type: "text", text: "first " },
			{ type: "system", kind: "notice", text: "model swap" },
			{ type: "text", text: "second" },
		]);
	});

	it("two consecutive system events → two separate system chunks (no coalescing)", () => {
		const chunks = run([notice("a"), notice("b")]);
		expect(chunks).toEqual([
			{ type: "system", kind: "notice", text: "a" },
			{ type: "system", kind: "notice", text: "b" },
		]);
	});

	it("interleaved think → text → think → tool → think → text → 6 chunks in order", () => {
		const chunks = run([
			rd("planning..."),
			td("here goes:"),
			rd("hmm, actually"),
			tc("t1", "read_file"),
			rd("ok now"),
			td("and so..."),
		]);
		expect(chunks.map((c) => c.type)).toEqual([
			"thinking",
			"text",
			"thinking",
			"tool-batch",
			"thinking",
			"text",
		]);
		expect(chunks[0]).toEqual({ type: "thinking", text: "planning..." });
		expect(chunks[1]).toEqual({ type: "text", text: "here goes:" });
		expect(chunks[2]).toEqual({ type: "thinking", text: "hmm, actually" });
		expect(chunks[3]).toMatchObject({ type: "tool-batch", calls: [{ id: "t1" }] });
		expect(chunks[4]).toEqual({ type: "thinking", text: "ok now" });
		expect(chunks[5]).toEqual({ type: "text", text: "and so..." });
	});
});

// ─── Additional transition coverage ──────────────────────────────

describe("appendEventToChunks — transition matrix", () => {
	it("thinking → thinking coalesces", () => {
		const chunks = run([rd("a"), rd("b")]);
		expect(chunks).toEqual([{ type: "thinking", text: "ab" }]);
	});

	it("thinking → text opens a new text chunk", () => {
		const chunks = run([rd("think"), td("speak")]);
		expect(chunks).toEqual([
			{ type: "thinking", text: "think" },
			{ type: "text", text: "speak" },
		]);
	});

	it("tool-batch → text opens a new text chunk", () => {
		const chunks = run([tc("t1"), td("after tool")]);
		expect(chunks).toHaveLength(2);
		expect(chunks[1]).toEqual({ type: "text", text: "after tool" });
	});

	it("text → reasoning-delta after a multi-delta text run still splits cleanly", () => {
		const chunks = run([td("a"), td("b"), rd("x"), rd("y"), td("c")]);
		expect(chunks).toEqual([
			{ type: "text", text: "ab" },
			{ type: "thinking", text: "xy" },
			{ type: "text", text: "c" },
		]);
	});

	it("error → text opens a fresh text chunk after the error", () => {
		const chunks = run([err("boom"), td("recovered")]);
		expect(chunks).toEqual([
			{ type: "error", message: "boom" },
			{ type: "text", text: "recovered" },
		]);
	});

	it("two consecutive errors stay as two error chunks (no coalescing)", () => {
		const chunks = run([err("first"), err("second", 429)]);
		expect(chunks).toEqual([
			{ type: "error", message: "first" },
			{ type: "error", message: "second", statusCode: 429 },
		]);
	});

	it("system → tool-call opens a new tool-batch (does not extend the system chunk)", () => {
		const chunks = run([notice("info"), tc("t1")]);
		expect(chunks).toHaveLength(2);
		expect(chunks[1]).toMatchObject({ type: "tool-batch", calls: [{ id: "t1" }] });
	});

	it("tool-result with no matching call is silently dropped", () => {
		const chunks = run([td("hi"), tr("no-such-id", "ignored")]);
		expect(chunks).toEqual([{ type: "text", text: "hi" }]);
	});

	it("shell-output with no tool-batch in scope is silently dropped", () => {
		const chunks = run([td("hi"), so("orphan")]);
		expect(chunks).toEqual([{ type: "text", text: "hi" }]);
	});

	it("tool-result for an earlier batch still updates the right call (results can arrive late)", () => {
		// Order: tc -> td -> tc(new batch) -> tr(for first batch's id)
		const chunks = run([
			tc("t1", "read_file"),
			td("midstream text"),
			tc("t2", "list_files"),
			tr("t1", "late result for first"),
		]);
		// Two tool-batches, separated by the text chunk. The result must land
		// inside the FIRST batch (the one containing t1), not the most-recent.
		expect(chunks.map((c) => c.type)).toEqual(["tool-batch", "text", "tool-batch"]);
		const first = chunks[0];
		if (first?.type !== "tool-batch") throw new Error("type guard");
		expect(first.calls[0]).toMatchObject({ id: "t1", result: "late result for first" });
		const second = chunks[2];
		if (second?.type !== "tool-batch") throw new Error("type guard");
		// t2 in the second batch has no result yet.
		expect(second.calls[0]?.result).toBeUndefined();
	});

	it("shell-output goes to the most recent tool-batch's most recent entry, even with intervening chunks", () => {
		// First batch's tool runs, emits output, then later a second batch starts and emits output.
		const chunks = run([
			tc("t1", "run_shell"),
			so("first-stdout\n"),
			td("interlude"),
			tc("t2", "run_shell"),
			so("second-stdout\n"),
		]);
		expect(chunks.map((c) => c.type)).toEqual(["tool-batch", "text", "tool-batch"]);
		const first = chunks[0];
		const second = chunks[2];
		if (first?.type !== "tool-batch" || second?.type !== "tool-batch") {
			throw new Error("type guard");
		}
		expect(first.calls[0]?.shellOutput).toEqual({ stdout: "first-stdout\n", stderr: "" });
		expect(second.calls[0]?.shellOutput).toEqual({ stdout: "second-stdout\n", stderr: "" });
	});

	it("model-changed event opens a system chunk with kind=model-changed", () => {
		const chunks = run([modelChanged("anthropic-1", "claude-sonnet-4")]);
		expect(chunks).toEqual([
			{
				type: "system",
				kind: "model-changed",
				text: "Switched to claude-sonnet-4 (anthropic-1)",
			},
		]);
	});

	it("config-reload event opens a system chunk with kind=config-reload", () => {
		const chunks = run([configReload]);
		expect(chunks).toEqual([
			{ type: "system", kind: "config-reload", text: "Configuration reloaded" },
		]);
	});

	// ─── reasoning-end (v6 SDK metadata round-trip) ──────────────────

	it("reasoning-delta then reasoning-end seals the thinking chunk with metadata", () => {
		const meta = { anthropic: { signature: "sig-1" } };
		const chunks = run([rd("plan"), re(meta)]);
		expect(chunks).toEqual([{ type: "thinking", text: "plan", metadata: meta }]);
	});

	it("two reasoning-deltas then reasoning-end coalesces text and seals once", () => {
		const meta = { anthropic: { signature: "abc" } };
		const chunks = run([rd("a"), rd("b"), re(meta)]);
		expect(chunks).toEqual([{ type: "thinking", text: "ab", metadata: meta }]);
	});

	it("reasoning-delta → reasoning-end → reasoning-delta opens a NEW chunk", () => {
		// Each Anthropic thinking content block gets its own metadata.
		// Extending a sealed chunk would corrupt the text/metadata mapping.
		const meta1 = { anthropic: { signature: "sig-1" } };
		const chunks = run([rd("first"), re(meta1), rd("second")]);
		expect(chunks).toEqual([
			{ type: "thinking", text: "first", metadata: meta1 },
			{ type: "thinking", text: "second" },
		]);
	});

	it("rd → re → rd → re produces two independently sealed chunks", () => {
		const m1 = { anthropic: { signature: "s1" } };
		const m2 = { anthropic: { signature: "s2" } };
		const chunks = run([rd("first"), re(m1), rd("second"), re(m2)]);
		expect(chunks).toEqual([
			{ type: "thinking", text: "first", metadata: m1 },
			{ type: "thinking", text: "second", metadata: m2 },
		]);
	});

	it("orphan reasoning-end (no prior thinking chunk) is a no-op", () => {
		const chunks = run([re({ anthropic: { signature: "orphan" } })]);
		expect(chunks).toEqual([]);
	});

	it("reasoning-end after an already-sealed thinking chunk does NOT overwrite", () => {
		const m1 = { anthropic: { signature: "first" } };
		const m2 = { anthropic: { signature: "second" } };
		const chunks = run([rd("a"), re(m1), re(m2)]);
		expect(chunks).toEqual([{ type: "thinking", text: "a", metadata: m1 }]);
	});

	it("reasoning-end without metadata is a silent no-op (does not seal)", () => {
		// v6 may emit reasoning-end with no providerMetadata for
		// non-Anthropic providers. Don't seal those chunks — a subsequent
		// reasoning-delta should continue extending.
		const chunks = run([rd("hello"), re(), rd(" world")]);
		expect(chunks).toEqual([{ type: "thinking", text: "hello world" }]);
	});

	it("re walks back across an intervening text chunk to seal the right thinking", () => {
		// Defensive: even if a non-thinking chunk lands between the
		// reasoning text and its end-event, the metadata still attaches
		// to the unsealed thinking chunk.
		const meta = { anthropic: { signature: "late" } };
		const chunks = run([rd("plan"), td("midstream"), re(meta)]);
		expect(chunks).toEqual([
			{ type: "thinking", text: "plan", metadata: meta },
			{ type: "text", text: "midstream" },
		]);
	});

	it("interleaved rd / re / tool-call / rd / re produces correct chunk sequence", () => {
		// Anthropic's interleaved-thinking emits a thinking block, then
		// a tool call, then another thinking block. Each thinking block
		// gets its own metadata.
		const m1 = { anthropic: { signature: "before-tool" } };
		const m2 = { anthropic: { signature: "after-tool" } };
		const chunks = run([
			rd("plan tool"),
			re(m1),
			tc("t1", "read_file"),
			rd("plan response"),
			re(m2),
		]);
		expect(chunks.map((c) => c.type)).toEqual(["thinking", "tool-batch", "thinking"]);
		expect(chunks[0]).toEqual({
			type: "thinking",
			text: "plan tool",
			metadata: m1,
		});
		expect(chunks[2]).toEqual({
			type: "thinking",
			text: "plan response",
			metadata: m2,
		});
	});

	it("non-content events (status / done / task-list-update / message-queued etc.) are no-ops", () => {
		const chunks = run([
			td("hello"),
			{ type: "status", status: "running" },
			{ type: "task-list-update", tasks: [] },
			{
				type: "tab-created",
				id: "tab1",
				title: "x",
				keyId: null,
				modelId: null,
				parentTabId: null,
				workingDirectory: null,
			},
			{ type: "message-queued", tabId: "t", messageId: "m", message: "queued" },
			{ type: "message-consumed", tabId: "t", messageIds: ["m"] },
			{ type: "message-cancelled", tabId: "t", messageId: "m" },
			{
				type: "done",
				message: { role: "assistant", chunks: [] },
			},
			td(" world"),
		]);
		expect(chunks).toEqual([{ type: "text", text: "hello world" }]);
	});

	it("error chunk omits statusCode when not provided", () => {
		const chunks = run([err("boom")]);
		expect(chunks).toEqual([{ type: "error", message: "boom" }]);
		// And no stray statusCode key:
		expect(Object.hasOwn(chunks[0], "statusCode")).toBe(false);
	});

	it("tool-result updates isError=false correctly (default success path)", () => {
		const chunks = run([tc("t1"), tr("t1", "ok", false)]);
		const batch = chunks[0];
		if (batch?.type !== "tool-batch") throw new Error("type guard");
		expect(batch.calls[0]).toMatchObject({ result: "ok", isError: false });
	});
});

// ─── applySystemEvent routing ────────────────────────────────────

describe("applySystemEvent", () => {
	type Msg = { id: string; role: "user" | "assistant" | "system"; chunks: Chunk[] };

	let counter = 0;
	const idFactory = () => `gen-${++counter}`;

	it("creates a new role:system message when message list is empty", () => {
		counter = 0;
		const messages: Msg[] = [];
		const result = applySystemEvent(messages, { kind: "notice", text: "hello" }, idFactory);
		expect(result.messageId).toBe("gen-1");
		expect(messages).toEqual([
			{
				id: "gen-1",
				role: "system",
				chunks: [{ type: "system", kind: "notice", text: "hello" }],
			},
		]);
	});

	it("creates a new role:system message when last message is user", () => {
		counter = 0;
		const messages: Msg[] = [{ id: "u1", role: "user", chunks: [{ type: "text", text: "hi" }] }];
		const result = applySystemEvent(messages, { kind: "model-changed", text: "swap" }, idFactory);
		expect(result.messageId).toBe("gen-1");
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			id: "gen-1",
			role: "system",
			chunks: [{ type: "system", kind: "model-changed", text: "swap" }],
		});
	});

	it("creates a new role:system message when last message is assistant", () => {
		counter = 0;
		const messages: Msg[] = [
			{ id: "a1", role: "assistant", chunks: [{ type: "text", text: "done" }] },
		];
		applySystemEvent(messages, { kind: "config-reload", text: "reloaded" }, idFactory);
		expect(messages).toHaveLength(2);
		expect(messages[1]?.role).toBe("system");
	});

	it("appends a chunk to the existing system message when last message is role:system", () => {
		counter = 0;
		const messages: Msg[] = [
			{
				id: "s1",
				role: "system",
				chunks: [{ type: "system", kind: "notice", text: "first" }],
			},
		];
		const result = applySystemEvent(messages, { kind: "notice", text: "second" }, idFactory);
		expect(result.messageId).toBe("s1");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.chunks).toEqual([
			{ type: "system", kind: "notice", text: "first" },
			{ type: "system", kind: "notice", text: "second" },
		]);
	});

	it("multiple consecutive calls accumulate in the same system message", () => {
		counter = 0;
		const messages: Msg[] = [{ id: "u1", role: "user", chunks: [{ type: "text", text: "hi" }] }];
		applySystemEvent(messages, { kind: "notice", text: "a" }, idFactory);
		applySystemEvent(messages, { kind: "notice", text: "b" }, idFactory);
		applySystemEvent(messages, { kind: "model-changed", text: "c" }, idFactory);
		expect(messages).toHaveLength(2);
		const sys = messages[1];
		expect(sys?.role).toBe("system");
		expect(sys?.chunks).toEqual([
			{ type: "system", kind: "notice", text: "a" },
			{ type: "system", kind: "notice", text: "b" },
			{ type: "system", kind: "model-changed", text: "c" },
		]);
	});

	it("returns the same messageId across appends to the same system message", () => {
		counter = 0;
		const messages: Msg[] = [];
		const first = applySystemEvent(messages, { kind: "notice", text: "a" }, idFactory);
		const second = applySystemEvent(messages, { kind: "notice", text: "b" }, idFactory);
		expect(first.messageId).toBe(second.messageId);
	});

	it("works against the core ChatMessage shape (with id added by caller)", () => {
		// Sanity: ChatMessage has {role, chunks}; the caller layers id on top.
		// This test exists to prove the generic constraint doesn't reject the
		// real persistence/in-memory shape we'll see in Phase 5.
		counter = 0;
		const messages: Array<ChatMessage & { id: string }> = [];
		const result = applySystemEvent(messages, { kind: "cancelled", text: "user stop" }, idFactory);
		expect(result.messageId).toBe("gen-1");
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.chunks[0]).toMatchObject({ kind: "cancelled", text: "user stop" });
	});
});
