import type { AgentEvent, StepId } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createMetricsAccumulator } from "./metrics.js";

function stepId(id: string): StepId {
	return id as StepId;
}

describe("createMetricsAccumulator", () => {
	it("builds a TurnMetrics from a single-step turn", () => {
		const acc = createMetricsAccumulator();

		const usageEvent: AgentEvent = {
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		const stepCompleteEvent: AgentEvent = {
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			ttftMs: 50,
			decodeMs: 150,
			genTotalMs: 200,
		};
		const doneEvent: AgentEvent = {
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
			durationMs: 500,
			usage: { inputTokens: 10, outputTokens: 5 },
		};

		acc.ingest(usageEvent);
		acc.ingest(stepCompleteEvent);
		acc.ingest(doneEvent);

		const tm = acc.build("t1");
		expect(tm.turnId).toBe("t1");
		expect(tm.usage.inputTokens).toBe(10);
		expect(tm.usage.outputTokens).toBe(5);
		expect(tm.durationMs).toBe(500);
		expect(tm.steps).toHaveLength(1);
		expect(tm.steps[0]?.stepId).toBe(stepId("t1#0"));
		expect(tm.steps[0]?.usage.inputTokens).toBe(10);
		expect(tm.steps[0]?.usage.outputTokens).toBe(5);
		expect(tm.steps[0]?.ttftMs).toBe(50);
		expect(tm.steps[0]?.decodeMs).toBe(150);
		expect(tm.steps[0]?.genTotalMs).toBe(200);
	});

	it("aggregates multi-step usage and preserves step order", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			genTotalMs: 100,
		});
		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#1"),
			usage: { inputTokens: 20, outputTokens: 10 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#1"),
			genTotalMs: 150,
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
			usage: { inputTokens: 30, outputTokens: 15 },
		});

		const tm = acc.build("t1");
		expect(tm.steps).toHaveLength(2);
		expect(tm.steps[0]?.stepId).toBe(stepId("t1#0"));
		expect(tm.steps[0]?.usage.inputTokens).toBe(10);
		expect(tm.steps[1]?.stepId).toBe(stepId("t1#1"));
		expect(tm.steps[1]?.usage.inputTokens).toBe(20);
		expect(tm.usage.inputTokens).toBe(30);
		expect(tm.usage.outputTokens).toBe(15);
	});

	it("joins per-step timing and usage by stepId", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			ttftMs: 50,
			decodeMs: 100,
			genTotalMs: 150,
		});
		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});

		const tm = acc.build("t1");
		expect(tm.steps).toHaveLength(1);
		expect(tm.steps[0]?.usage.inputTokens).toBe(10);
		expect(tm.steps[0]?.ttftMs).toBe(50);
		expect(tm.steps[0]?.decodeMs).toBe(100);
		expect(tm.steps[0]?.genTotalMs).toBe(150);
	});

	it("turn-level usage comes from done event, not step sum", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
			usage: { inputTokens: 100, outputTokens: 50 },
		});

		const tm = acc.build("t1");
		expect(tm.usage.inputTokens).toBe(100);
		expect(tm.usage.outputTokens).toBe(50);
	});

	it("falls back to summing step usage when done.usage is absent", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
		});

		const tm = acc.build("t1");
		expect(tm.usage.inputTokens).toBe(10);
		expect(tm.usage.outputTokens).toBe(5);
	});

	it("tolerates missing usage on a step (timing only)", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			genTotalMs: 200,
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
		});

		const tm = acc.build("t1");
		expect(tm.steps).toHaveLength(1);
		expect(tm.steps[0]?.usage.inputTokens).toBe(0);
		expect(tm.steps[0]?.usage.outputTokens).toBe(0);
		expect(tm.steps[0]?.genTotalMs).toBe(200);
	});

	it("tolerates missing timing on a step (usage only)", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
		});

		const tm = acc.build("t1");
		expect(tm.steps).toHaveLength(1);
		expect(tm.steps[0]?.usage.inputTokens).toBe(10);
		expect(tm.steps[0]?.ttftMs).toBeUndefined();
		expect(tm.steps[0]?.decodeMs).toBeUndefined();
		expect(tm.steps[0]?.genTotalMs).toBeUndefined();
	});

	it("reset clears all accumulated state", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
			usage: { inputTokens: 10, outputTokens: 5 },
		});

		acc.reset();

		const tm = acc.build("t2");
		expect(tm.steps).toHaveLength(0);
		expect(tm.usage.inputTokens).toBe(0);
		expect(tm.usage.outputTokens).toBe(0);
	});

	it("contextSize equals inputTokens + outputTokens for a single-step turn", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
			usage: { inputTokens: 10, outputTokens: 5 },
		});

		const tm = acc.build("t1");
		expect(tm.contextSize).toBe(15);
	});

	it("contextSize equals ONLY the last step's inputTokens + outputTokens for a multi-step turn", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
		});
		acc.ingest({
			type: "usage",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#1"),
			usage: { inputTokens: 20, outputTokens: 10 },
		});
		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#1"),
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
			usage: { inputTokens: 100, outputTokens: 50 },
		});

		const tm = acc.build("t1");
		expect(tm.contextSize).toBe(30);
		expect(tm.contextSize).not.toBe(tm.usage.inputTokens);
	});

	it("contextSize is undefined when the turn has no steps", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
		});

		const tm = acc.build("t1");
		expect(tm.contextSize).toBeUndefined();
	});

	it("contextSize is undefined when the last step has no usable per-step usage", () => {
		const acc = createMetricsAccumulator();

		acc.ingest({
			type: "step-complete",
			conversationId: "c1",
			turnId: "t1",
			stepId: stepId("t1#0"),
			genTotalMs: 200,
		});
		acc.ingest({
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "stop",
		});

		const tm = acc.build("t1");
		expect(tm.contextSize).toBeUndefined();
	});
});
