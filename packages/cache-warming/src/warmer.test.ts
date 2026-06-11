import type { Logger, Span } from "@dispatch/kernel";
import type { WarmResult } from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
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
});
