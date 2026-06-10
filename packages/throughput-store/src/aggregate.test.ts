import { describe, expect, it } from "vitest";
import { aggregateSamples, type ThroughputSample } from "./aggregate.js";

const S = (model: string, ts: number, outputTokens: number, genMs: number): ThroughputSample => ({
	model,
	ts,
	outputTokens,
	genMs,
});

describe("aggregateSamples", () => {
	it("token-weights tok/s (Σtokens / Σgen-seconds), so large turns dominate", () => {
		const samples = [
			S("claude/haiku", 100, 1000, 10_000), // 100 tok/s, big turn
			S("claude/haiku", 200, 10, 1000), // 10 tok/s, small turn
		];
		const [row] = aggregateSamples(samples, 0, 1000);
		expect(row?.model).toBe("claude/haiku");
		// 1010 tokens / 11 s = 91.82, NOT the simple mean (55)
		expect(row?.tokensPerSecond).toBeCloseTo(91.82, 1);
		expect(row?.totalOutputTokens).toBe(1010);
		expect(row?.totalGenMs).toBe(11_000);
		expect(row?.turns).toBe(2);
	});

	it("excludes samples outside the [start, end) range", () => {
		const samples = [S("m", 50, 100, 1000), S("m", 500, 100, 1000), S("m", 1500, 999, 1000)];
		const [row] = aggregateSamples(samples, 100, 1000);
		expect(row?.turns).toBe(1); // only ts=500 is in [100, 1000)
		expect(row?.totalOutputTokens).toBe(100);
	});

	it("groups by model and sorts by tok/s descending", () => {
		const samples = [
			S("slow", 10, 50, 5000), // 10 tok/s
			S("fast", 10, 500, 1000), // 500 tok/s
		];
		const rows = aggregateSamples(samples, 0, 100);
		expect(rows.map((r) => r.model)).toEqual(["fast", "slow"]);
	});

	it("reports 0 tok/s when generation time is 0 (avoids divide-by-zero)", () => {
		const [row] = aggregateSamples([S("m", 10, 100, 0)], 0, 100);
		expect(row?.tokensPerSecond).toBe(0);
	});

	it("returns an empty list when no samples match", () => {
		expect(aggregateSamples([], 0, 100)).toEqual([]);
	});
});
