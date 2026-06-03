/**
 * Tests for `src/lib/cache-warm-storage.ts` — the per-tab localStorage
 * round-trip for the "keep prompt cache warm" toggle.
 *
 * As in `sidebar-storage.test.ts`, Bun's `localStorage` shim is partial, so we
 * install a clean in-memory polyfill per-test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCacheWarmEnabled,
	loadCacheWarmEnabled,
	saveCacheWarmEnabled,
} from "../src/lib/cache-warm-storage.js";

const LS_KEY = "dispatch-cache-warming";

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

beforeEach(() => {
	vi.stubGlobal("localStorage", makeLocalStorageMock());
});

describe("loadCacheWarmEnabled", () => {
	it("defaults to false when nothing is stored", () => {
		expect(loadCacheWarmEnabled("tab-1")).toBe(false);
	});

	it("returns true after enabling a tab", () => {
		saveCacheWarmEnabled("tab-1", true);
		expect(loadCacheWarmEnabled("tab-1")).toBe(true);
	});

	it("is scoped per-tab (one tab's flag doesn't leak to another)", () => {
		saveCacheWarmEnabled("tab-1", true);
		expect(loadCacheWarmEnabled("tab-2")).toBe(false);
	});

	it("returns false when the stored JSON is malformed", () => {
		localStorage.setItem(LS_KEY, "not json {[");
		expect(loadCacheWarmEnabled("tab-1")).toBe(false);
	});

	it("ignores non-boolean entries", () => {
		localStorage.setItem(LS_KEY, JSON.stringify({ "tab-1": "yes", "tab-2": true }));
		expect(loadCacheWarmEnabled("tab-1")).toBe(false);
		expect(loadCacheWarmEnabled("tab-2")).toBe(true);
	});
});

describe("saveCacheWarmEnabled", () => {
	it("removes the entry when set to false (default-off representation)", () => {
		saveCacheWarmEnabled("tab-1", true);
		saveCacheWarmEnabled("tab-1", false);
		const raw = localStorage.getItem(LS_KEY);
		expect(raw).toBe(JSON.stringify({}));
		expect(loadCacheWarmEnabled("tab-1")).toBe(false);
	});

	it("preserves other tabs' flags when toggling one", () => {
		saveCacheWarmEnabled("tab-1", true);
		saveCacheWarmEnabled("tab-2", true);
		saveCacheWarmEnabled("tab-1", false);
		expect(loadCacheWarmEnabled("tab-1")).toBe(false);
		expect(loadCacheWarmEnabled("tab-2")).toBe(true);
	});

	it("silently ignores storage write errors", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
			removeItem: () => {},
			clear: () => {},
			length: 0,
			key: () => null,
		});
		expect(() => saveCacheWarmEnabled("tab-1", true)).not.toThrow();
	});
});

describe("clearCacheWarmEnabled", () => {
	it("drops a tab's persisted flag", () => {
		saveCacheWarmEnabled("tab-1", true);
		clearCacheWarmEnabled("tab-1");
		expect(loadCacheWarmEnabled("tab-1")).toBe(false);
	});

	it("is a no-op when the tab has no stored flag", () => {
		expect(() => clearCacheWarmEnabled("tab-x")).not.toThrow();
		expect(localStorage.getItem(LS_KEY)).toBeNull();
	});
});
