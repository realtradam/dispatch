/**
 * Tests for `src/lib/theme.ts` — the shared theme picker module.
 *
 * Covers the post-Gemini-review fix where `App.svelte` (boot apply)
 * and `SettingsPanel.svelte` (UI picker) used to hand-roll their own
 * defaults and could disagree. After consolidation, both call into
 * this module and the bug class is gone — these tests pin that
 * invariant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, DEFAULT_THEME, loadStoredTheme, THEMES } from "../src/lib/theme.js";

const LS_KEY = "dispatch-theme";

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

function makeDocumentMock(): { documentElement: { setAttribute: (k: string, v: string) => void } } {
	const attrs = new Map<string, string>();
	return {
		documentElement: {
			setAttribute: (k: string, v: string) => {
				attrs.set(k, v);
			},
			// expose for assertions
			// @ts-expect-error — test-only escape hatch
			_attrs: attrs,
		},
	};
}

beforeEach(() => {
	vi.stubGlobal("localStorage", makeLocalStorageMock());
	vi.stubGlobal("document", makeDocumentMock());
});

describe("DEFAULT_THEME", () => {
	it("is one of the THEMES (sanity check that they can't drift)", () => {
		expect((THEMES as readonly string[]).includes(DEFAULT_THEME)).toBe(true);
	});
});

describe("loadStoredTheme", () => {
	it("returns DEFAULT_THEME when localStorage is empty (first-ever load)", () => {
		expect(loadStoredTheme()).toBe(DEFAULT_THEME);
	});

	it("returns the stored theme when it's a known theme", () => {
		localStorage.setItem(LS_KEY, "dracula");
		expect(loadStoredTheme()).toBe("dracula");
	});

	it("returns DEFAULT_THEME when the stored value isn't a known theme", () => {
		// Guards against a stale storage entry from a removed theme,
		// or a hand-edited bad value, falling through to daisyUI's own
		// fallback (which is `light`, not our DEFAULT).
		localStorage.setItem(LS_KEY, "solarized-rainbow");
		expect(loadStoredTheme()).toBe(DEFAULT_THEME);
	});

	it("returns DEFAULT_THEME when localStorage.getItem throws", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			length: 0,
			key: () => null,
		});
		expect(loadStoredTheme()).toBe(DEFAULT_THEME);
	});

	it("returns DEFAULT_THEME when localStorage is undefined (SSR)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(loadStoredTheme()).toBe(DEFAULT_THEME);
	});
});

describe("applyTheme", () => {
	it("writes data-theme on the document element", () => {
		applyTheme("nord");
		// @ts-expect-error — test mock exposes `_attrs`
		expect(document.documentElement._attrs.get("data-theme")).toBe("nord");
	});

	it("persists the theme to localStorage", () => {
		applyTheme("forest");
		expect(localStorage.getItem(LS_KEY)).toBe("forest");
	});

	it("round-trips through loadStoredTheme", () => {
		applyTheme("luxury");
		expect(loadStoredTheme()).toBe("luxury");
	});

	it("does not throw when localStorage.setItem throws (quota etc.)", () => {
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
		expect(() => applyTheme("cyberpunk")).not.toThrow();
	});

	it("still writes to the DOM even if localStorage write throws", () => {
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
		applyTheme("coffee");
		// @ts-expect-error — test mock exposes `_attrs`
		expect(document.documentElement._attrs.get("data-theme")).toBe("coffee");
	});
});
