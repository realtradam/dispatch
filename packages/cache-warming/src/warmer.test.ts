import type { Logger, Span, StorageNamespace } from "@dispatch/kernel";
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

function makeDeps(
	overrides: Partial<{
		warm: (conversationId: string) => Promise<WarmResult>;
		onSurfaceChange: () => void;
		now: () => number;
	}> = {},
) {
	const timers = fakeTimers();
	let nowMs = 1000;
	return {
		timers,
		warm: overrides.warm ?? (async () => WARM_RESULT),
		storage: memStorage(),
		logger: makeLogger(),
		now: overrides.now ?? (() => nowMs),
		onSurfaceChange: overrides.onSurfaceChange ?? (() => {}),
		setNow(ms: number) {
			nowMs = ms;
		},
	};
}

describe("CacheWarmer", () => {
	it("arms a timer on turnSettled and warms when it fires (enabled)", async () => {
		const deps = makeDeps();
		const warmCalls: string[] = [];
		deps.warm = async (convId) => {
			warmCalls.push(convId);
			return WARM_RESULT;
		};
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		deps.timers.flush();

		await new Promise((r) => setTimeout(r, 10));
		expect(warmCalls).toContain("conv-1");
	});

	it("cancels the timer on turnStarted (no warm while generating)", () => {
		const deps = makeDeps();
		const warmCalls: string[] = [];
		deps.warm = async (convId) => {
			warmCalls.push(convId);
			return WARM_RESULT;
		};
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		warmer.onTurnStarted("conv-1");
		deps.timers.flush();

		expect(warmCalls).toHaveLength(0);
	});

	it("disabled conversation does not warm", async () => {
		const deps = makeDeps();
		const warmCalls: string[] = [];
		deps.warm = async (convId) => {
			warmCalls.push(convId);
			return WARM_RESULT;
		};
		const warmer = createCacheWarmer(deps);

		await warmer.setEnabled("conv-1", false);
		warmer.onTurnSettled("conv-1", {});
		deps.timers.flush();

		await new Promise((r) => setTimeout(r, 10));
		expect(warmCalls).toHaveLength(0);
	});

	it("setIntervalMs converts seconds→ms, floors at MIN_INTERVAL_MS, and re-arms", async () => {
		const deps = makeDeps();
		const warmCalls: string[] = [];
		deps.warm = async (convId) => {
			warmCalls.push(convId);
			return WARM_RESULT;
		};
		const warmer = createCacheWarmer(deps);

		// Enable and settle to arm the timer
		warmer.onTurnSettled("conv-1", {});

		// Set interval to 30 seconds (30000ms)
		const settings = await warmer.setIntervalMs("conv-1", 30_000);
		expect(settings.intervalMs).toBe(30_000);

		const state = warmer.getState("conv-1");
		expect(state.intervalMs).toBe(30_000);

		// Timer should still be armed — flush fires it
		deps.timers.flush();
		await new Promise((r) => setTimeout(r, 10));
		expect(warmCalls).toContain("conv-1");
	});

	it("setIntervalMs clamps values below MIN_INTERVAL_MS", async () => {
		const deps = makeDeps();
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});

		// Set interval to 500ms — should clamp to MIN_INTERVAL_MS (1000)
		const settings = await warmer.setIntervalMs("conv-1", 500);
		expect(settings.intervalMs).toBe(1000);
	});

	it("setIntervalMs ignores NaN / non-positive (clamps to MIN_INTERVAL_MS)", async () => {
		const deps = makeDeps();
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});

		const settings1 = await warmer.setIntervalMs("conv-1", Number.NaN);
		expect(settings1.intervalMs).toBe(MIN_INTERVAL_MS);

		const settings2 = await warmer.setIntervalMs("conv-1", -5000);
		expect(settings2.intervalMs).toBe(MIN_INTERVAL_MS);

		const settings3 = await warmer.setIntervalMs("conv-1", 0);
		expect(settings3.intervalMs).toBe(MIN_INTERVAL_MS);
	});

	it("setEnabled flips enabled for a conversation", async () => {
		const deps = makeDeps();
		const warmer = createCacheWarmer(deps);

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
		let changeCount = 0;
		const deps = makeDeps({
			onSurfaceChange: () => {
				changeCount++;
			},
		});
		const warmer = createCacheWarmer(deps);

		await warmer.setEnabled("conv-1", false);
		expect(changeCount).toBe(1);

		await warmer.setIntervalMs("conv-1", 30_000);
		expect(changeCount).toBe(2);
	});

	it("warmCompleted updates lastPct/lastExpectedPct/lastWarmAt and re-arms (nextWarmAt set), pushes onSurfaceChange", () => {
		let changeCount = 0;
		let nowMs = 5000;
		const deps = makeDeps({
			onSurfaceChange: () => {
				changeCount++;
			},
			now: () => nowMs,
		});
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		const stateBefore = warmer.getState("conv-1");
		expect(stateBefore.lastPct).toBeNull();
		expect(stateBefore.lastExpectedPct).toBeNull();
		expect(stateBefore.lastWarmAt).toBeNull();

		nowMs = 6000;
		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 300 },
		});

		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBe(70);
		expect(state.lastExpectedPct).toBe(70);
		expect(state.lastWarmAt).toBe(6000);
		expect(state.nextWarmAt).not.toBeNull();
		expect(changeCount).toBe(1);
	});

	it("a warm that completes while the conversation is active is dropped (no update, no re-arm)", () => {
		let changeCount = 0;
		const deps = makeDeps({
			onSurfaceChange: () => {
				changeCount++;
			},
			now: () => 5000,
		});
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		warmer.onTurnStarted("conv-1");

		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 0 },
		});

		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBeNull();
		expect(state.lastWarmAt).toBeNull();
		expect(state.nextWarmAt).toBeNull();
		expect(changeCount).toBe(0);
	});

	it("nextWarmAt is set when armed and null when disabled or active", async () => {
		let nowMs = 1000;
		const deps = makeDeps({ now: () => nowMs });
		const warmer = createCacheWarmer(deps);

		// Before any event — not armed
		expect(warmer.getState("conv-1").nextWarmAt).toBeNull();

		// After turnSettled — armed with nextWarmAt
		nowMs = 2000;
		warmer.onTurnSettled("conv-1", {});
		const stateArmed = warmer.getState("conv-1");
		expect(stateArmed.nextWarmAt).toBe(2000 + 240_000);

		// After turnStarted — cancelled (null)
		warmer.onTurnStarted("conv-1");
		expect(warmer.getState("conv-1").nextWarmAt).toBeNull();

		// After disabling — null
		warmer.onTurnSettled("conv-2", {});
		await warmer.setEnabled("conv-2", false);
		expect(warmer.getState("conv-2").nextWarmAt).toBeNull();
	});

	it("a manual warm (warmCompleted for a conversation) resets the timer + refreshes the surface", () => {
		let changeCount = 0;
		let nowMs = 5000;
		const deps = makeDeps({
			onSurfaceChange: () => {
				changeCount++;
			},
			now: () => nowMs,
		});
		const warmer = createCacheWarmer(deps);

		// Settle to arm the timer
		warmer.onTurnSettled("conv-1", {});
		const armed = warmer.getState("conv-1");
		expect(armed.nextWarmAt).toBe(5000 + 240_000);

		// Simulate a manual warm completing at t=8000
		nowMs = 8000;
		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 100 },
		});

		const after = warmer.getState("conv-1");
		expect(after.lastPct).toBe(90);
		expect(after.lastExpectedPct).toBe(90);
		expect(after.lastWarmAt).toBe(8000);
		// Timer should be re-armed with new nextWarmAt
		expect(after.nextWarmAt).toBe(8000 + 240_000);
		expect(changeCount).toBe(1);
	});

	it("stores lastPct from the warmCompleted event", () => {
		const deps = makeDeps({ now: () => 5000 });
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: WARM_RESULT,
		});

		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBe(80);
	});

	it("a completed warm stores both lastPct (rate) and lastExpectedPct (retention)", () => {
		const deps = makeDeps({ now: () => 5000 });
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 300 },
		});

		const state = warmer.getState("conv-1");
		expect(state.lastPct).toBe(70);
		expect(state.lastExpectedPct).toBe(70);
	});

	it("re-arms timer after warmCompleted", () => {
		let nowMs = 1000;
		const deps = makeDeps({ now: () => nowMs });
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		const firstNextWarmAt = warmer.getState("conv-1").nextWarmAt;

		nowMs = 5000;
		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: WARM_RESULT,
		});

		const after = warmer.getState("conv-1");
		expect(after.nextWarmAt).not.toBeNull();
		expect(after.nextWarmAt).not.toBe(firstNextWarmAt);
		expect(after.nextWarmAt).toBe(5000 + 240_000);
	});

	it("the per-conversation spec includes a cache-retention stat", () => {
		const deps = makeDeps({ now: () => 5000 });
		const warmer = createCacheWarmer(deps);

		warmer.onTurnSettled("conv-1", {});
		warmer.onWarmCompleted({
			conversationId: "conv-1",
			usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 100 },
		});

		const state = warmer.getState("conv-1");
		expect(state.lastExpectedPct).toBe(90);
	});
});
