import { describe, expect, it } from "vitest";
import type { ConversationState } from "./pure.js";
import {
	computeCachePct,
	isTokenCurrent,
	parseSettings,
	serializeSettings,
	shouldWarm,
} from "./pure.js";

describe("computeCachePct", () => {
	it("cacheRead/input rounded and clamped to 0..100", () => {
		expect(computeCachePct(1000, 800)).toBe(80);
		expect(computeCachePct(1000, 1200)).toBe(100);
		expect(computeCachePct(1000, -100)).toBe(0);
		expect(computeCachePct(1000, 0)).toBe(0);
		expect(computeCachePct(1000, 333)).toBe(33);
	});

	it("zero input tokens → 0", () => {
		expect(computeCachePct(0, 500)).toBe(0);
		expect(computeCachePct(-1, 500)).toBe(0);
	});
});

describe("shouldWarm", () => {
	it("returns true when enabled, idle, and token matches", () => {
		const state: ConversationState = {
			enabled: true,
			intervalMs: 240_000,
			active: false,
			lastPct: null,
			token: 5,
		};
		expect(shouldWarm(state, 5)).toBe(true);
	});

	it("returns false when disabled", () => {
		const state: ConversationState = {
			enabled: false,
			intervalMs: 240_000,
			active: false,
			lastPct: null,
			token: 5,
		};
		expect(shouldWarm(state, 5)).toBe(false);
	});

	it("returns false when active", () => {
		const state: ConversationState = {
			enabled: true,
			intervalMs: 240_000,
			active: true,
			lastPct: null,
			token: 5,
		};
		expect(shouldWarm(state, 5)).toBe(false);
	});

	it("returns false when token is superseded", () => {
		const state: ConversationState = {
			enabled: true,
			intervalMs: 240_000,
			active: false,
			lastPct: null,
			token: 5,
		};
		expect(shouldWarm(state, 6)).toBe(false);
	});
});

describe("isTokenCurrent", () => {
	it("returns true when tokens match", () => {
		expect(isTokenCurrent(5, 5)).toBe(true);
	});

	it("returns false when tokens differ", () => {
		expect(isTokenCurrent(5, 6)).toBe(false);
	});
});

describe("parseSettings/serializeSettings round-trip", () => {
	it("round-trips enabled + intervalMs", () => {
		const original = { enabled: false, intervalMs: 120_000 };
		const serialized = serializeSettings(original);
		const parsed = parseSettings(serialized);
		expect(parsed).toEqual(original);
	});

	it("returns defaults for null input", () => {
		const parsed = parseSettings(null);
		expect(parsed).toEqual({ enabled: true, intervalMs: 240_000 });
	});

	it("returns defaults for malformed JSON", () => {
		const parsed = parseSettings("not-json{{{");
		expect(parsed).toEqual({ enabled: true, intervalMs: 240_000 });
	});

	it("clamps non-positive interval to MIN_INTERVAL_MS", () => {
		const parsed = parseSettings(JSON.stringify({ enabled: true, intervalMs: -500 }));
		expect(parsed.intervalMs).toBe(1000);
	});

	it("uses default for NaN interval", () => {
		const parsed = parseSettings(JSON.stringify({ enabled: true, intervalMs: Number.NaN }));
		expect(parsed.intervalMs).toBe(240_000);
	});
});
