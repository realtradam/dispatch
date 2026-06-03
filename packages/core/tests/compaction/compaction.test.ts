import { describe, expect, it } from "vitest";
import {
	buildCompactionPrompt,
	buildCompactionRequest,
	buildSummaryTurnText,
	DEFAULT_TAIL_TURNS,
	extractPreviousSummary,
	renderTranscript,
	SUMMARY_MARKER,
	SUMMARY_TEMPLATE,
	selectHeadTail,
} from "../../src/compaction/index.js";
import type { ChatMessage } from "../../src/types/index.js";

function user(text: string): ChatMessage {
	return { role: "user", chunks: [{ type: "text", text }] };
}
function assistant(text: string): ChatMessage {
	return { role: "assistant", chunks: [{ type: "text", text }] };
}

describe("selectHeadTail", () => {
	it("returns empty head when turns <= tailTurns (nothing to compact)", () => {
		const msgs = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
		const { head, tail } = selectHeadTail(msgs, 2);
		expect(head).toEqual([]);
		expect(tail).toEqual(msgs);
	});

	it("keeps the last N turns verbatim and summarizes the rest", () => {
		const msgs = [
			user("u1"),
			assistant("a1"),
			user("u2"),
			assistant("a2"),
			user("u3"),
			assistant("a3"),
		];
		const { head, tail } = selectHeadTail(msgs, 2);
		expect(tail[0]).toBe(msgs[2]);
		expect(tail.at(-1)).toBe(msgs[5]);
		expect(head).toEqual([msgs[0], msgs[1]]);
	});

	it("a turn includes trailing assistant/tool messages up to the next user", () => {
		const msgs = [user("u1"), assistant("a1a"), assistant("a1b"), user("u2"), assistant("a2")];
		const { head, tail } = selectHeadTail(msgs, 1);
		expect(head).toEqual([msgs[0], msgs[1], msgs[2]]);
		expect(tail).toEqual([msgs[3], msgs[4]]);
	});

	it("tailTurns<=0 → everything is head", () => {
		const msgs = [user("u1"), assistant("a1")];
		expect(selectHeadTail(msgs, 0)).toEqual({ head: msgs, tail: [] });
	});

	it("defaults to DEFAULT_TAIL_TURNS", () => {
		const msgs = [user("u1"), user("u2"), user("u3")];
		const def = selectHeadTail(msgs);
		const explicit = selectHeadTail(msgs, DEFAULT_TAIL_TURNS);
		expect(def).toEqual(explicit);
	});
});

describe("buildCompactionPrompt", () => {
	it("creates a fresh-summary instruction without a previous summary", () => {
		const p = buildCompactionPrompt({});
		expect(p).toContain("Create a new anchored summary");
		expect(p).toContain(SUMMARY_TEMPLATE);
		expect(p).not.toContain("<previous-summary>");
	});

	it("anchors on a previous summary when provided", () => {
		const p = buildCompactionPrompt({ previousSummary: "## Goal\n- old" });
		expect(p).toContain("Update the anchored summary");
		expect(p).toContain("<previous-summary>");
		expect(p).toContain("## Goal\n- old");
		expect(p).toContain(SUMMARY_TEMPLATE);
	});
});

describe("extractPreviousSummary", () => {
	it("returns undefined when the first user message is not a seeded summary", () => {
		expect(extractPreviousSummary([user("hello"), assistant("hi")])).toBeUndefined();
	});

	it("extracts the body of a seeded summary turn (marker stripped)", () => {
		const seeded = user(buildSummaryTurnText("## Goal\n- build X"));
		expect(extractPreviousSummary([seeded, assistant("ok")])).toBe("## Goal\n- build X");
	});
});

describe("renderTranscript", () => {
	it("renders user/assistant text blocks", () => {
		const t = renderTranscript([user("hello"), assistant("hi there")]);
		expect(t).toContain("## User\nhello");
		expect(t).toContain("## Assistant\nhi there");
	});

	it("renders tool calls and caps long tool results", () => {
		const big = "x".repeat(5000);
		const msg: ChatMessage = {
			role: "assistant",
			chunks: [
				{
					type: "tool-batch",
					calls: [{ id: "c1", name: "read_file", arguments: { path: "a" }, result: big }],
				},
			],
		};
		const t = renderTranscript([msg], 2000);
		expect(t).toContain('[tool read_file {"path":"a"}]');
		expect(t).toContain("chars truncated for summary");
		expect(t.length).toBeLessThan(5000 + 200);
	});

	it("skips a seeded prior-summary user turn", () => {
		const seeded = user(buildSummaryTurnText("## Goal\n- prior"));
		const t = renderTranscript([seeded, assistant("work")]);
		expect(t).not.toContain("prior");
		expect(t).toContain("## Assistant\nwork");
	});

	it("omits thinking/error/system chunks", () => {
		const msg: ChatMessage = {
			role: "assistant",
			chunks: [
				{ type: "thinking", text: "secret reasoning" },
				{ type: "text", text: "visible" },
				{ type: "error", message: "boom" },
			],
		};
		const t = renderTranscript([msg]);
		expect(t).toContain("visible");
		expect(t).not.toContain("secret reasoning");
		expect(t).not.toContain("boom");
	});
});

describe("buildCompactionRequest", () => {
	it("returns no prompt when there is nothing to compact", () => {
		const msgs = [user("u1"), assistant("a1")];
		const req = buildCompactionRequest({ messages: msgs, tailTurns: 2 });
		expect(req.prompt).toBeUndefined();
		expect(req.head).toEqual([]);
		expect(req.tail).toEqual(msgs);
	});

	it("builds a prompt with transcript + instruction and exposes head/tail", () => {
		const msgs = [
			user("first task"),
			assistant("did stuff"),
			user("second"),
			assistant("more"),
			user("third"),
			assistant("done"),
		];
		const req = buildCompactionRequest({ messages: msgs, tailTurns: 2 });
		expect(req.prompt).toBeDefined();
		expect(req.prompt).toContain("first task");
		expect(req.prompt).toContain("Create a new anchored summary");
		expect(req.tail[0]).toBe(msgs[2]);
		expect(req.head[0]).toBe(msgs[0]);
	});

	it("anchors on a prior seeded summary", () => {
		const msgs = [
			user(buildSummaryTurnText("## Goal\n- old goal")),
			assistant("ack"),
			user("new work"),
			assistant("did new"),
			user("more work"),
			assistant("did more"),
		];
		const req = buildCompactionRequest({ messages: msgs, tailTurns: 2 });
		expect(req.previousSummary).toBe("## Goal\n- old goal");
		expect(req.prompt).toContain("Update the anchored summary");
		// head = [seeded-summary, "ack"]; seeded summary is skipped in the
		// transcript, so "ack" represents the summarized head. "new work" lives
		// in the preserved tail (last 2 turns), not the summary body.
		expect(req.prompt).toContain("ack");
		expect(
			req.tail.some((m) => m.chunks.some((c) => c.type === "text" && c.text === "new work")),
		).toBe(true);
	});
});

describe("buildSummaryTurnText", () => {
	it("prefixes the marker so a later compaction can anchor", () => {
		const seeded = buildSummaryTurnText("## Goal\n- x");
		expect(seeded.startsWith(SUMMARY_MARKER)).toBe(true);
		expect(extractPreviousSummary([user(seeded)])).toBe("## Goal\n- x");
	});
});
