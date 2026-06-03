/**
 * Tests for `src/lib/cache-warming.svelte.ts` — the prompt-cache warming
 * timer/orchestration store.
 *
 * Drives the REAL `$state`-backed store via `createCacheWarmingStore()` under
 * fake timers, asserting the idle/turn/send lifecycle, the repeating 4-minute
 * cadence, the warming-specific last-% capture, and error surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `config.ts` reads localStorage at import; mock it (mirrors chat-store.test).
vi.mock("../src/lib/config.js", () => ({
	config: {
		apiBase: "http://test.local:3000",
		wsUrl: "ws://test.local:3000/ws",
		defaultApiBase: "http://test.local:3000",
		setApiBase: vi.fn(),
	},
}));

function makeLocalStorageMock(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, v);
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
		clear: () => {
			store.clear();
		},
		get length() {
			return store.size;
		},
		key: (i: number) => Array.from(store.keys())[i] ?? null,
	};
}

import { createCacheWarmingStore, WARM_INTERVAL_MS } from "../src/lib/cache-warming.svelte.js";

type WarmStore = ReturnType<typeof createCacheWarmingStore>;

function makeFetchOk(usage: { inputTokens: number; cacheReadTokens: number }): typeof fetch {
	return vi.fn(() =>
		Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ usage }),
		}),
	) as unknown as typeof fetch;
}

/** Flush microtasks so awaited fetch `.json()` chains settle under fake timers. */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

let store: WarmStore;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("localStorage", makeLocalStorageMock());
	store = createCacheWarmingStore();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("enable / disable lifecycle", () => {
	it("arms a countdown when enabled and idle", () => {
		store.setEnabled("tab-1", true);
		const s = store.stateFor("tab-1");
		expect(s.enabled).toBe(true);
		expect(s.nextFireAt).not.toBeNull();
	});

	it("cancels the countdown when disabled", () => {
		store.setEnabled("tab-1", true);
		store.setEnabled("tab-1", false);
		expect(store.stateFor("tab-1").nextFireAt).toBeNull();
	});

	it("does not arm a disabled tab", () => {
		const s = store.stateFor("tab-2");
		expect(s.enabled).toBe(false);
		expect(s.nextFireAt).toBeNull();
	});
});

describe("firing cadence", () => {
	it("fires after the interval and captures the warming last-%", async () => {
		const fetchMock = makeFetchOk({ inputTokens: 1000, cacheReadTokens: 900 });
		vi.stubGlobal("fetch", fetchMock);

		store.setRequestResolver(() => ({ keyId: "k", modelId: "m", agentModels: null }));
		store.setEnabled("tab-1", true);

		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
			.calls[0] as [string, { body: string }];
		expect(url).toContain("/chat/warm");
		expect(JSON.parse(opts.body)).toMatchObject({ tabId: "tab-1", keyId: "k", modelId: "m" });

		const s = store.stateFor("tab-1");
		expect(s.lastPct).toBe(90); // 900 / 1000
		expect(s.error).toBeNull();
	});

	it("re-arms repeatedly (not a one-shot)", async () => {
		const fetchMock = makeFetchOk({ inputTokens: 1000, cacheReadTokens: 800 });
		vi.stubGlobal("fetch", fetchMock);
		store.setEnabled("tab-1", true);

		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// After the first fire it re-arms, so a second interval fires again.
		expect(store.stateFor("tab-1").nextFireAt).not.toBeNull();

		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("shows '-%' (null) before it has ever fired", () => {
		store.setEnabled("tab-1", true);
		expect(store.stateFor("tab-1").lastPct).toBeNull();
	});
});

describe("turn-state gating", () => {
	it("does NOT fire while a turn is active", async () => {
		const fetchMock = makeFetchOk({ inputTokens: 10, cacheReadTokens: 5 });
		vi.stubGlobal("fetch", fetchMock);
		store.setEnabled("tab-1", true);
		store.onTurnActive("tab-1");
		expect(store.stateFor("tab-1").nextFireAt).toBeNull();

		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS * 2);
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("re-arms when the turn ends (idle)", () => {
		store.setEnabled("tab-1", true);
		store.onTurnActive("tab-1");
		store.onTurnEnded("tab-1");
		expect(store.stateFor("tab-1").nextFireAt).not.toBeNull();
	});

	it("a real user message disables+resets the pending timer", async () => {
		const fetchMock = makeFetchOk({ inputTokens: 10, cacheReadTokens: 5 });
		vi.stubGlobal("fetch", fetchMock);
		store.setEnabled("tab-1", true);
		store.onUserMessage("tab-1");
		expect(store.stateFor("tab-1").nextFireAt).toBeNull();

		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
		await flush();
		// The pending fire was cancelled by onUserMessage; nothing fired.
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("error surfacing", () => {
	it("captures a non-OK HTTP error into state.error", async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: "provider exploded" }),
			}),
		) as unknown as typeof fetch;
		vi.stubGlobal("fetch", fetchMock);

		store.setEnabled("tab-1", true);
		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
		await flush();

		expect(store.stateFor("tab-1").error).toBe("provider exploded");
	});

	it("captures a network rejection into state.error", async () => {
		const fetchMock = vi.fn(() =>
			Promise.reject(new Error("network down")),
		) as unknown as typeof fetch;
		vi.stubGlobal("fetch", fetchMock);

		store.setEnabled("tab-1", true);
		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
		await flush();

		expect(store.stateFor("tab-1").error).toBe("network down");
	});
});

describe("forgetTab / removeTab", () => {
	it("forgetTab clears state, timers, and persisted preference for a closed tab", async () => {
		const fetchMock = makeFetchOk({ inputTokens: 10, cacheReadTokens: 5 });
		vi.stubGlobal("fetch", fetchMock);
		store.setEnabled("tab-1", true);
		store.forgetTab("tab-1");

		// A fresh stateFor after removal is a default-off entry.
		expect(store.stateFor("tab-1").enabled).toBe(false);
		await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS * 2);
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
