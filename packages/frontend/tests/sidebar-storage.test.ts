/**
 * Tests for `src/lib/sidebar-storage.ts` — the localStorage round-trip
 * for the sidebar panel layout (`panels[].selected`).
 *
 * Bun's `localStorage` shim is partial (`getItem` is missing on a fresh
 * `globalThis`), so we install a clean in-memory polyfill per-test
 * rather than relying on whatever environment-default exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSidebarPanels, saveSidebarPanels } from "../src/lib/sidebar-storage.js";

const LS_KEY = "dispatch-sidebar-panels";

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

describe("loadSidebarPanels", () => {
	it("returns the default single-panel layout when localStorage is empty", () => {
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});

	it("returns the parsed array when valid JSON is stored", () => {
		localStorage.setItem(LS_KEY, JSON.stringify(["Tasks", "Skills", "Tools"]));
		expect(loadSidebarPanels()).toEqual(["Tasks", "Skills", "Tools"]);
	});

	it("preserves order across the round-trip (storage is render-order)", () => {
		const layout = ["Settings", "Chat Settings", "Key Usage", "Config"];
		localStorage.setItem(LS_KEY, JSON.stringify(layout));
		expect(loadSidebarPanels()).toEqual(layout);
	});

	it("returns the default when the stored JSON is malformed", () => {
		localStorage.setItem(LS_KEY, "not valid json {[");
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});

	it("returns the default when the stored value is a non-array JSON value", () => {
		localStorage.setItem(LS_KEY, JSON.stringify({ panels: ["Tasks"] }));
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});

	it("returns the default when the stored value is a JSON null", () => {
		localStorage.setItem(LS_KEY, "null");
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});

	it("filters out non-string array entries while keeping the valid ones", () => {
		localStorage.setItem(LS_KEY, JSON.stringify(["Tasks", 42, null, "Skills", true, undefined]));
		expect(loadSidebarPanels()).toEqual(["Tasks", "Skills"]);
	});

	it("returns the default when filtering leaves an empty array", () => {
		// Preserves the SidebarPanel "minimum one panel" invariant (the
		// remove-button is hidden on `idx === 0` so the UI can't drop
		// below one panel; load must match).
		localStorage.setItem(LS_KEY, JSON.stringify([1, 2, false, null]));
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});

	it("returns the default when localStorage.getItem throws (SecurityError etc.)", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError: storage disabled");
			},
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			length: 0,
			key: () => null,
		});
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});

	it("returns a fresh array on each call (callers can mutate the result safely)", () => {
		const a = loadSidebarPanels();
		const b = loadSidebarPanels();
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
		a.push("Tasks");
		expect(b).toEqual(["Chat Settings"]);
	});
});

describe("saveSidebarPanels", () => {
	it("writes the array as JSON under the canonical key", () => {
		saveSidebarPanels(["Chat Settings", "Tasks"]);
		const raw = localStorage.getItem(LS_KEY);
		expect(raw).toBe(JSON.stringify(["Chat Settings", "Tasks"]));
	});

	it("round-trips through load to recover the same value", () => {
		const layout = ["Chat Settings", "Skills", "Tools", "Config"];
		saveSidebarPanels(layout);
		expect(loadSidebarPanels()).toEqual(layout);
	});

	it("silently ignores storage errors (quota exceeded, SecurityError, etc.)", () => {
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
		expect(() => saveSidebarPanels(["Tasks"])).not.toThrow();
	});

	it("overwrites a prior layout (no append semantics)", () => {
		saveSidebarPanels(["Tasks", "Skills"]);
		saveSidebarPanels(["Config"]);
		expect(loadSidebarPanels()).toEqual(["Config"]);
	});

	it("can save an empty array (load will fall back to default on next read)", () => {
		// We don't refuse empty saves at the save site — the layout
		// component enforces the minimum-one-panel invariant by hiding
		// the remove-button on idx 0. If somehow an empty array is
		// passed, we store it; load substitutes the default on read.
		saveSidebarPanels([]);
		expect(localStorage.getItem(LS_KEY)).toBe("[]");
		expect(loadSidebarPanels()).toEqual(["Chat Settings"]);
	});
});
