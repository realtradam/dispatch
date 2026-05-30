import { describe, expect, it } from "vitest";
import { explodeTurn, explodeUserText, groupRowsToMessages } from "../../src/chunks/transform.js";
import type { Chunk, ChunkRow, ChunkRowDraft } from "../../src/types/index.js";

// These tests cover the pure explode/group transforms — the heart of the flat
// chunk-log storage model. No DB is required.

/** Promote drafts to rows with synthetic seq/id/createdAt (as appendChunks would). */
function toRows(drafts: ChunkRowDraft[], tabId = "tab-1", startSeq = 0): ChunkRow[] {
	return drafts.map((d, i) => ({
		id: `c${i}`,
		tabId,
		seq: startSeq + i,
		turnId: d.turnId,
		step: d.step,
		role: d.role,
		type: d.type,
		data: d.data,
		createdAt: 1000 + i,
	}));
}

describe("explodeTurn", () => {
	it("splits a tool-batch into separate tool_call (assistant) and tool_result (tool) rows", () => {
		const chunks: Chunk[] = [
			{ type: "thinking", text: "hmm", metadata: { anthropic: { signature: "S" } } },
			{ type: "text", text: "let me read" },
			{
				type: "tool-batch",
				calls: [
					{ id: "a1", name: "read_file", arguments: { path: "x" }, result: "X", isError: false },
					{ id: "a2", name: "read_file", arguments: { path: "y" }, result: "Y", isError: false },
				],
			},
		];
		const drafts = explodeTurn("turn-1", chunks);

		// thinking, text, tool_call×2 (assistant), tool_result×2 (tool)
		expect(drafts.map((d) => `${d.role}/${d.type}`)).toEqual([
			"assistant/thinking",
			"assistant/text",
			"assistant/tool_call",
			"assistant/tool_call",
			"tool/tool_result",
			"tool/tool_result",
		]);
		// All in the same step (one round-trip).
		expect(drafts.every((d) => d.step === 0)).toBe(true);
		expect(drafts.every((d) => d.turnId === "turn-1")).toBe(true);
	});

	it("increments step after each tool-batch (multi-step turn)", () => {
		const chunks: Chunk[] = [
			{ type: "text", text: "s0" },
			{ type: "tool-batch", calls: [{ id: "a", name: "t", arguments: {}, result: "r" }] },
			{ type: "text", text: "s1" },
			{ type: "tool-batch", calls: [{ id: "b", name: "t", arguments: {}, result: "r" }] },
			{ type: "text", text: "final" },
		];
		const drafts = explodeTurn("turn-1", chunks);
		const byStep = (s: number) => drafts.filter((d) => d.step === s).map((d) => d.type);
		expect(byStep(0)).toEqual(["text", "tool_call", "tool_result"]);
		expect(byStep(1)).toEqual(["text", "tool_call", "tool_result"]);
		expect(byStep(2)).toEqual(["text"]); // trailing final-step text, no tool-batch
	});

	it("omits tool_result rows for calls without a result", () => {
		const chunks: Chunk[] = [
			{ type: "tool-batch", calls: [{ id: "a", name: "t", arguments: {} }] },
		];
		const drafts = explodeTurn("turn-1", chunks);
		expect(drafts.map((d) => d.type)).toEqual(["tool_call"]);
	});
});

describe("groupRowsToMessages (round-trip)", () => {
	it("reconstructs a user message then an assistant message with a per-step tool-batch", () => {
		const rows = [
			...toRows(explodeUserText("turn-1", "hello"), "tab-1", 0),
			...toRows(
				explodeTurn("turn-1", [
					{ type: "text", text: "reading" },
					{
						type: "tool-batch",
						calls: [
							{
								id: "a1",
								name: "read_file",
								arguments: { path: "x" },
								result: "X",
								isError: false,
							},
						],
					},
					{ type: "text", text: "done" },
				]),
				"tab-1",
				1,
			),
		];

		const msgs = groupRowsToMessages(rows);
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(msgs[0]?.chunks).toEqual([{ type: "text", text: "hello" }]);

		const a = msgs[1];
		if (!a) throw new Error("no assistant message");
		// reconstructed: text, tool-batch(step0), text(step1)
		expect(a.chunks.map((c) => c.type)).toEqual(["text", "tool-batch", "text"]);
		const batch = a.chunks.find((c) => c.type === "tool-batch");
		if (batch?.type !== "tool-batch") throw new Error("no batch");
		expect(batch.calls[0]).toMatchObject({
			id: "a1",
			name: "read_file",
			arguments: { path: "x" },
			result: "X",
			isError: false,
		});
	});

	it("keeps each step's tool calls in its own tool-batch chunk", () => {
		const rows = toRows(
			explodeTurn("turn-1", [
				{ type: "tool-batch", calls: [{ id: "a", name: "t", arguments: {}, result: "ra" }] },
				{ type: "tool-batch", calls: [{ id: "b", name: "t", arguments: {}, result: "rb" }] },
			]),
		);
		const msgs = groupRowsToMessages(rows);
		expect(msgs).toHaveLength(1);
		const batches = msgs[0]?.chunks.filter((c) => c.type === "tool-batch") ?? [];
		expect(batches).toHaveLength(2);
	});

	it("round-trips a multi-step assistant turn back to its original chunk shape", () => {
		const original: Chunk[] = [
			{ type: "thinking", text: "plan", metadata: { anthropic: { signature: "S" } } },
			{ type: "text", text: "step0" },
			{
				type: "tool-batch",
				calls: [
					{ id: "a", name: "read_file", arguments: { path: "p" }, result: "R", isError: false },
				],
			},
			{ type: "text", text: "final" },
		];
		const rows = toRows(explodeTurn("turn-1", original));
		const msgs = groupRowsToMessages(rows);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.chunks).toEqual(original);
	});

	it("tolerates an orphan tool_result whose tool_call was paged out", () => {
		const rows = toRows([
			{
				turnId: "turn-1",
				step: 0,
				role: "tool",
				type: "tool_result",
				data: { callId: "z", name: "t", result: "R", isError: false },
			},
		]);
		const msgs = groupRowsToMessages(rows);
		expect(msgs).toHaveLength(1);
		const batch = msgs[0]?.chunks[0];
		if (batch?.type !== "tool-batch") throw new Error("no batch");
		expect(batch.calls[0]).toMatchObject({ id: "z", result: "R" });
	});

	it("breaks the assistant grouping on a user or system row", () => {
		const rows = [
			...toRows(explodeUserText("t1", "q1"), "tab", 0),
			...toRows(explodeTurn("t1", [{ type: "text", text: "a1" }]), "tab", 1),
			...toRows(explodeUserText("t2", "q2"), "tab", 2),
			...toRows(explodeTurn("t2", [{ type: "system", kind: "notice", text: "n" }]), "tab", 3),
		];
		const msgs = groupRowsToMessages(rows);
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
	});
});
