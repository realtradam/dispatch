import type { Logger, Span } from "@dispatch/kernel";
import type { WarmResult } from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import { MIN_INTERVAL_MS } from "./pure.js";
import { createCacheWarmer, type TimerDeps } from "./warmer.js";

function memStorage(): StorageNamespace {
	const map = new Map<string, string>();
	return {
		get: async (k) => map.get(k) ?? null,
		set: async (k, v) => {
			map.set(k, v);
		},
		delete: async (k) => {
			map.delete(k);
		},
		has: async (k) => map.has(k),
		keys: async (prefix) =>
			[...map.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
	};
}

function makeSpan(): Span {
	const span: Span = {
		id: "span",
		log: makeLogger(),
		setAttributes: () => {},
		addLink: () => {},
		child: () => makeSpan(),
		end: () => {},
	};
	return span;
}

function makeLogger(): Logger {
	return {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => makeLogger(),
		span: () => makeSpan(),
	};
}

function fakeTimers(): TimerDeps & { flush: () => void } {
	let nextId = 1;
	const pending = new Map<number, () => void>();
	return {
		setTimer(fn, _ms) {
			const id = nextId++;
			pending.set(id, fn);
			return id;
		},
		clearTimer(id) {
			pending.delete(id);
		},
		flush() {
			const fns = [...pending.values()];
			pending.clear();
			for (const fn of fns) fn();
		},
	};
}

const WARM_RESULT: WarmResult = {
	inputTokens: 1000,
	outputTokens: 10,
	cacheReadTokens: 800,
	cacheWriteTokens: 0,
};

import type { StorageNamespace } from "@dispatch/kernel";

describe("CacheWarmer", () => {
	it("arms a timer on turnSettled and warms when it fires (enabled)", async () => {
		const timers = fakeTimers();
		const warmCalls: string[] = [];
		const warmer = createCacheWarmer({
			warm: async (convId) => {
				warmCalls.push(convId);
				return WARM_RESULT;
			},
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		timers.flush();

		await new Promise((r) => setTimeout(r, 10));
		expect(warmCalls).toContain("conv-1");
	});

	it("cancels the timer on turnStarted (no warm while generating)", () => {
		const timers = fakeTimers();
		const warmCalls: string[] = [];
		const warmer = createCacheWarmer({
			warm: async (convId) => {
				warmCalls.push(convId);
				return WARM_RESULT;
			},
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		warmer.onTurnStarted("conv-1");
		timers.flush();

		expect(warmCalls).toHaveLength(0);
	});

	it("in-flight warm result is dropped when superseded (token mismatch)", async () => {
		const timers = fakeTimers();
		let resolveWarm: (v: WarmResult) => void = () => {};
		const warmPromise = new Promise<WarmResult>((r) => {
			resolveWarm = r;
		});
		const warmer = createCacheWarmer({
			warm: () => warmPromise,
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		timers.flush();

		warmer.onTurnStarted("conv-1");
		warmer.onTurnSettled("conv-1", {});

		resolveWarm?.(WARM_RESULT);
		await new Promise((r) => setTimeout(r, 10));

		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBeNull();
	});

	it("disabled conversation does not warm", async () => {
		const timers = fakeTimers();
		const warmCalls: string[] = [];
		const warmer = createCacheWarmer({
			warm: async (convId) => {
				warmCalls.push(convId);
				return WARM_RESULT;
			},
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		await warmer.setEnabled("conv-1", false);
		warmer.onTurnSettled("conv-1", {});
		timers.flush();

		await new Promise((r) => setTimeout(r, 10));
		expect(warmCalls).toHaveLength(0);
	});

	it("stores lastPct from the warm result", async () => {
		const timers = fakeTimers();
		const warmer = createCacheWarmer({
			warm: async () => WARM_RESULT,
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		timers.flush();

		await new Promise((r) => setTimeout(r, 10));
		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBe(80);
	});

	it("a completed warm stores both lastPct (rate) and lastExpectedPct (retention)", async () => {
		const timers = fakeTimers();
		const warmer = createCacheWarmer({
			warm: async () => ({
				inputTokens: 1000,
				outputTokens: 10,
				cacheReadTokens: 700,
				cacheWriteTokens: 300,
			}),
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		timers.flush();

		await new Promise((r) => setTimeout(r, 10));
		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBe(70);
		expect(state.lastExpectedPct).toBe(70);
	});

	it("re-arms timer after warm completes", async () => {
		const timers = fakeTimers();
		let warmCount = 0;
		const warmer = createCacheWarmer({
			warm: async () => {
				warmCount++;
				return WARM_RESULT;
			},
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		timers.flush();
		await new Promise((r) => setTimeout(r, 10));

		timers.flush();
		await new Promise((r) => setTimeout(r, 10));

		expect(warmCount).toBe(2);
	});

	it("setIntervalMs converts seconds→ms, floors at MIN_INTERVAL_MS, and re-arms", async () => {
		const timers = fakeTimers();
		const warmCalls: string[] = [];
		const warmer = createCacheWarmer({
			warm: async (convId) => {
				warmCalls.push(convId);
				return WARM_RESULT;
			},
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		// Enable and settle to arm the timer
		warmer.onTurnSettled("conv-1", {});

		// Set interval to 30 seconds (30000ms)
		const settings = await warmer.setIntervalMs("conv-1", 30_000);
		expect(settings.intervalMs).toBe(30_000);

		const state = warmer.getState("conv-1");
		expect(state.intervalMs).toBe(30_000);

		// Timer should still be armed — flush fires it
		timers.flush();
		await new Promise((r) => setTimeout(r, 10));
		expect(warmCalls).toContain("conv-1");
	});

	it("setIntervalMs clamps values below MIN_INTERVAL_MS", async () => {
		const timers = fakeTimers();
		const warmer = createCacheWarmer({
			warm: async () => WARM_RESULT,
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});

		// Set interval to 500ms — should clamp to MIN_INTERVAL_MS (1000)
		const settings = await warmer.setIntervalMs("conv-1", 500);
		expect(settings.intervalMs).toBe(1000);
	});

	it("setIntervalMs ignores NaN / non-positive (clamps to MIN_INTERVAL_MS)", async () => {
		const timers = fakeTimers();
		const warmer = createCacheWarmer({
			warm: async () => WARM_RESULT,
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});

		const settings1 = await warmer.setIntervalMs("conv-1", Number.NaN);
		expect(settings1.intervalMs).toBe(MIN_INTERVAL_MS);

		const settings2 = await warmer.setIntervalMs("conv-1", -5000);
		expect(settings2.intervalMs).toBe(MIN_INTERVAL_MS);

		const settings3 = await warmer.setIntervalMs("conv-1", 0);
		expect(settings3.intervalMs).toBe(MIN_INTERVAL_MS);
	});

	it("setEnabled flips enabled for a conversation", async () => {
		const timers = fakeTimers();
		const warmer = createCacheWarmer({
			warm: async () => WARM_RESULT,
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		// Default is enabled
		expect(warmer.getState("conv-1").enabled).toBe(true);

		// Toggle off
		await warmer.setEnabled("conv-1", false);
		expect(warmer.getState("conv-1").enabled).toBe(false);

		// Toggle on
		await warmer.setEnabled("conv-1", true);
		expect(warmer.getState("conv-1").enabled).toBe(true);
	});

	it("onSurfaceChange is called when settings change", async () => {
		const timers = fakeTimers();
		let changeCount = 0;
		const warmer = createCacheWarmer({
			warm: async () => WARM_RESULT,
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {
				changeCount++;
			},
		});

		await warmer.setEnabled("conv-1", false);
		expect(changeCount).toBe(1);

		await warmer.setIntervalMs("conv-1", 30_000);
		expect(changeCount).toBe(2);
	});

	it("the per-conversation spec includes a cache-retention stat", async () => {
		const timers = fakeTimers();
		const warmer = createCacheWarmer({
			warm: async () => ({
				inputTokens: 1000,
				outputTokens: 10,
				cacheReadTokens: 900,
				cacheWriteTokens: 100,
			}),
			storage: memStorage(),
			logger: makeLogger(),
			timers,
			onSurfaceChange: () => {},
		});

		warmer.onTurnSettled("conv-1", {});
		timers.flush();
		await new Promise((r) => setTimeout(r, 10));

		const state = warmer.getState("conv-1");
		expect(state.lastExpectedPct).toBe(90);
	});
});
