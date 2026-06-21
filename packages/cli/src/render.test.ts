import type { AgentEvent, ConversationMeta } from "@dispatch/transport-contract";
import type { StepId } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import {
	extractLastText,
	formatConversationList,
	formatRelativeTime,
	renderEvent,
} from "./render.js";

describe("renderEvent", () => {
	const opts = { showReasoning: false };
	const optsReasoning = { showReasoning: true };

	it("renders text-delta as stdout", () => {
		const e: AgentEvent = {
			type: "text-delta",
			conversationId: "c",
			turnId: "t",
			delta: "hello",
		};
		expect(renderEvent(e, opts)).toEqual({ stdout: "hello" });
	});

	it("hides reasoning-delta by default", () => {
		const e: AgentEvent = {
			type: "reasoning-delta",
			conversationId: "c",
			turnId: "t",
			delta: "thinking...",
		};
		expect(renderEvent(e, opts)).toBeUndefined();
	});

	it("shows reasoning-delta when showReasoning is true", () => {
		const e: AgentEvent = {
			type: "reasoning-delta",
			conversationId: "c",
			turnId: "t",
			delta: "thinking...",
		};
		expect(renderEvent(e, optsReasoning)).toEqual({ stdout: "thinking..." });
	});

	it("renders tool-call with name and JSON input", () => {
		const e: AgentEvent = {
			type: "tool-call",
			conversationId: "c",
			turnId: "t",
			stepId: "t1#0" as StepId,
			toolCallId: "tc1",
			toolName: "read_file",
			input: { path: "/foo" },
		};
		const result = renderEvent(e, opts);
		expect(result?.stdout).toContain("[tool] read_file");
		expect(result?.stdout).toContain('"/foo"');
	});

	it("renders tool-output data as stdout", () => {
		const e: AgentEvent = {
			type: "tool-output",
			conversationId: "c",
			turnId: "t",
			toolCallId: "tc1",
			data: "some output",
			stream: "stdout",
		};
		expect(renderEvent(e, opts)).toEqual({ stdout: "some output" });
	});

	it("renders tool-result without error", () => {
		const e: AgentEvent = {
			type: "tool-result",
			conversationId: "c",
			turnId: "t",
			stepId: "t1#0" as StepId,
			toolCallId: "tc1",
			toolName: "read_file",
			content: "file contents",
			isError: false,
		};
		expect(renderEvent(e, opts)).toEqual({
			stdout: "[tool:read_file] file contents\n",
		});
	});

	it("renders tool-result with error flag", () => {
		const e: AgentEvent = {
			type: "tool-result",
			conversationId: "c",
			turnId: "t",
			stepId: "t1#0" as StepId,
			toolCallId: "tc1",
			toolName: "read_file",
			content: "not found",
			isError: true,
		};
		expect(renderEvent(e, opts)).toEqual({
			stdout: "[tool:read_file] ERROR not found\n",
		});
	});

	it("renders usage event", () => {
		const e: AgentEvent = {
			type: "usage",
			conversationId: "c",
			turnId: "t",
			usage: { inputTokens: 100, outputTokens: 50 },
		};
		expect(renderEvent(e, opts)).toEqual({
			stdout: "\n[usage] in=100 out=50\n",
		});
	});

	it("renders error event to stderr", () => {
		const e: AgentEvent = {
			type: "error",
			conversationId: "c",
			turnId: "t",
			message: "something went wrong",
		};
		expect(renderEvent(e, opts)).toEqual({
			stderr: "[error] something went wrong\n",
		});
	});

	it("returns undefined for status", () => {
		const e: AgentEvent = {
			type: "status",
			conversationId: "c",
			status: "running",
		};
		expect(renderEvent(e, opts)).toBeUndefined();
	});

	it("returns undefined for turn-start", () => {
		const e: AgentEvent = { type: "turn-start", conversationId: "c", turnId: "t" };
		expect(renderEvent(e, opts)).toBeUndefined();
	});

	it("returns undefined for turn-sealed", () => {
		const e: AgentEvent = { type: "turn-sealed", conversationId: "c", turnId: "t" };
		expect(renderEvent(e, opts)).toBeUndefined();
	});

	it("returns undefined for done", () => {
		const e: AgentEvent = {
			type: "done",
			conversationId: "c",
			turnId: "t",
			reason: "completed",
		};
		expect(renderEvent(e, opts)).toBeUndefined();
	});
});

describe("extractLastText", () => {
	it("accumulates text deltas", () => {
		const events: AgentEvent[] = [
			{ type: "text-delta", conversationId: "c", turnId: "t", delta: "Hello" },
			{ type: "text-delta", conversationId: "c", turnId: "t", delta: ", " },
			{ type: "text-delta", conversationId: "c", turnId: "t", delta: "world" },
			{ type: "done", conversationId: "c", turnId: "t", reason: "completed" },
		];
		expect(extractLastText(events)).toBe("Hello, world");
	});

	it("returns empty string when no text-delta events", () => {
		const events: AgentEvent[] = [
			{ type: "turn-start", conversationId: "c", turnId: "t" },
			{ type: "done", conversationId: "c", turnId: "t", reason: "completed" },
		];
		expect(extractLastText(events)).toBe("");
	});

	it("ignores non-text-delta events but keeps deltas interleaved among them", () => {
		const events: AgentEvent[] = [
			{ type: "text-delta", conversationId: "c", turnId: "t", delta: "a" },
			{
				type: "tool-call",
				conversationId: "c",
				turnId: "t",
				stepId: "t1#0" as StepId,
				toolCallId: "tc1",
				toolName: "read_file",
				input: {},
			},
			{ type: "text-delta", conversationId: "c", turnId: "t", delta: "b" },
		];
		expect(extractLastText(events)).toBe("ab");
	});

	it("returns empty string for an empty event list", () => {
		expect(extractLastText([])).toBe("");
	});
});

describe("formatRelativeTime", () => {
	const now = 1_000_000_000_000; // fixed clock

	it("returns 'just now' for under a minute", () => {
		expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
	});

	it("returns minutes ago", () => {
		expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
	});

	it("returns hours ago", () => {
		expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
	});

	it("returns days ago", () => {
		expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
	});

	it("returns a date past a week", () => {
		// 2001-09-09T01:46:40.000Z
		expect(formatRelativeTime(now - 8 * 86_400_000, now)).toBe("2001-09-01");
	});
});

describe("formatConversationList", () => {
	const now = 1_000_000_000_000;

	const conv = (id: string, title: string, ageMs: number): ConversationMeta => ({
		id,
		title,
		createdAt: now - ageMs - 1000,
		lastActivityAt: now - ageMs,
		status: "idle",
	});

	it("returns empty string for an empty list", () => {
		expect(formatConversationList([], now)).toBe("");
	});

	it("formats one row with short id, title, relative time", () => {
		const list = [conv("abcdef1234567890", "hello world", 5 * 60_000)];
		expect(formatConversationList(list, now)).toBe("abcdef12 | hello world | 5m ago");
	});

	it("formats multiple rows one per line", () => {
		const list = [
			conv("abcdef1234567890", "first", 5 * 60_000),
			conv("0123456789abcdef", "second", 3 * 3_600_000),
		];
		expect(formatConversationList(list, now)).toBe(
			"abcdef12 | first | 5m ago\n01234567 | second | 3h ago",
		);
	});
});
