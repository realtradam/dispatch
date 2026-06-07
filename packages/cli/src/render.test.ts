import type { AgentEvent } from "@dispatch/transport-contract";
import type { StepId } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import { renderEvent } from "./render.js";

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
