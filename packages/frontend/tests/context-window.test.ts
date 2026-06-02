import { describe, expect, it } from "vitest";
import { computeContextUsage } from "../src/lib/context-window.js";
import type { CacheStats } from "../src/lib/types.js";

function stats(last: CacheStats["last"]): CacheStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		requests: last ? 1 : 0,
		last,
	};
}

describe("computeContextUsage", () => {
	it("derives current context from the LAST request's input + output", () => {
		const usage = computeContextUsage(
			stats({
				inputTokens: 47000,
				outputTokens: 1200,
				cacheReadTokens: 40000,
				cacheWriteTokens: 0,
			}),
			200000,
		);
		// 47000 + 1200 — NOT the cumulative totals, and cache tokens are already
		// inside inputTokens (not re-added).
		expect(usage.current).toBe(48200);
		expect(usage.max).toBe(200000);
		expect(usage.percent).toBeCloseTo(24.1, 5); // 48200 / 200000 * 100, unrounded
	});

	it("returns max=null and percent=null when the limit is unknown", () => {
		const usage = computeContextUsage(
			stats({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
			null,
		);
		expect(usage.current).toBe(100);
		expect(usage.max).toBeNull();
		expect(usage.percent).toBeNull();
	});

	it("treats a non-positive limit as unknown", () => {
		const usage = computeContextUsage(
			stats({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
			0,
		);
		expect(usage.max).toBeNull();
		expect(usage.percent).toBeNull();
	});

	it("reports zero usage when no request has completed yet", () => {
		expect(computeContextUsage(null, 200000)).toEqual({
			current: 0,
			max: 200000,
			percent: 0,
		});
		expect(computeContextUsage(stats(null), 200000)).toEqual({
			current: 0,
			max: 200000,
			percent: 0,
		});
	});

	it("clamps percent to 100 when context overflows the window", () => {
		const usage = computeContextUsage(
			stats({ inputTokens: 250000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
			200000,
		);
		expect(usage.current).toBe(255000);
		expect(usage.percent).toBe(100);
	});

	it("keeps an unrounded percent so the UI can show 2 decimals", () => {
		const usage = computeContextUsage(
			stats({ inputTokens: 3690, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
			1000000,
		);
		// 3690 / 1,000,000 * 100 = 0.369 → displayed as "0.37%" (toFixed(2)).
		expect(usage.percent).toBeCloseTo(0.369, 6);
		expect((usage.percent as number).toFixed(2)).toBe("0.37");
	});
});
