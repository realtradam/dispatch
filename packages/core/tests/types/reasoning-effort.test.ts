import { describe, expect, it } from "vitest";
import {
	DEFAULT_REASONING_EFFORT,
	isReasoningEffort,
	REASONING_EFFORT_LABELS,
	REASONING_EFFORTS,
} from "../../src/types/index.js";

describe("REASONING_EFFORTS — canonical effort list (single source of truth)", () => {
	it("is ordered least→most and includes xhigh between high and max", () => {
		expect(REASONING_EFFORTS).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
		const hi = REASONING_EFFORTS.indexOf("high");
		const xhi = REASONING_EFFORTS.indexOf("xhigh");
		const mx = REASONING_EFFORTS.indexOf("max");
		expect(hi).toBeLessThan(xhi);
		expect(xhi).toBeLessThan(mx);
	});

	it("has a human-readable label for every level (no gaps)", () => {
		for (const effort of REASONING_EFFORTS) {
			expect(REASONING_EFFORT_LABELS[effort]).toBeTruthy();
		}
		expect(Object.keys(REASONING_EFFORT_LABELS).sort()).toEqual([...REASONING_EFFORTS].sort());
	});

	it("defaults to high", () => {
		expect(DEFAULT_REASONING_EFFORT).toBe("high");
		expect(REASONING_EFFORTS).toContain(DEFAULT_REASONING_EFFORT);
	});
});

describe("isReasoningEffort", () => {
	it("accepts every canonical level", () => {
		for (const effort of REASONING_EFFORTS) {
			expect(isReasoningEffort(effort)).toBe(true);
		}
	});

	it("rejects unknown strings and non-strings", () => {
		expect(isReasoningEffort("turbo")).toBe(false);
		expect(isReasoningEffort("HIGH")).toBe(false);
		expect(isReasoningEffort("")).toBe(false);
		expect(isReasoningEffort(undefined)).toBe(false);
		expect(isReasoningEffort(null)).toBe(false);
		expect(isReasoningEffort(3)).toBe(false);
		expect(isReasoningEffort({})).toBe(false);
	});
});
