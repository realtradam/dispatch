/**
 * Single source of truth for the app's theme picker.
 *
 * Two callers care about themes:
 *  - `App.svelte`'s `onMount`, which applies the persisted theme on boot
 *    so the first paint is the right color.
 *  - `SettingsPanel.svelte`'s theme `<select>`, which lets the user
 *    change theme at runtime.
 *
 * Both used to hand-roll their own `localStorage` key, default value,
 * and DOM-attribute write. That drift produced a real bug: `App.svelte`
 * left the DOM untouched on first load (so daisyUI fell back to the
 * first theme in `app.css`, `light`), while `SettingsPanel` showed
 * `"dark"` as the selected value — UI and reality disagreed until the
 * user manually picked a theme. Centralizing here closes that gap.
 *
 * The theme list also intentionally mirrors the `@plugin "daisyui"`
 * block in `app.css`. Drift between the two is harmless (a theme name
 * present here but not in CSS just falls back to the default daisyUI
 * theme at render time), but they should be kept in sync by hand —
 * daisyUI's plugin config is a CSS-time concern and can't be imported
 * from TS.
 */

export const THEMES = [
	"light",
	"dark",
	"dracula",
	"night",
	"nord",
	"sunset",
	"cyberpunk",
	"forest",
	"cmyk",
	"coffee",
	"caramellatte",
	"garden",
	"luxury",
] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = "dispatch-theme";

/**
 * The fallback theme used both at first-boot apply (when nothing is
 * persisted) and as the UI's default-selected value. They MUST match —
 * if they ever diverged again, the UI would show one theme and the
 * page would render another.
 */
export const DEFAULT_THEME: Theme = "dark";

/**
 * Read the persisted theme. Returns `DEFAULT_THEME` when nothing is
 * stored, when access throws (private mode / SecurityError), or when
 * the stored value isn't one of the known themes. Never throws.
 *
 * SSR-safe: if `localStorage` is undefined (e.g. `vite build` during
 * prerender, if that's ever wired up), returns the default.
 */
export function loadStoredTheme(): Theme {
	try {
		if (typeof localStorage === "undefined") return DEFAULT_THEME;
		const raw = localStorage.getItem(THEME_STORAGE_KEY);
		if (raw && (THEMES as readonly string[]).includes(raw)) {
			return raw as Theme;
		}
		return DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

/**
 * Apply a theme to the live document and persist it. The DOM write is
 * unconditional (daisyUI keys off `data-theme` on the `<html>`
 * element); the storage write is best-effort and swallows quota /
 * SecurityError failures because the session continues to work either
 * way — only cross-reload persistence degrades.
 */
export function applyTheme(theme: Theme): void {
	if (typeof document !== "undefined") {
		document.documentElement.setAttribute("data-theme", theme);
	}
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		}
	} catch {
		// Best-effort.
	}
}
