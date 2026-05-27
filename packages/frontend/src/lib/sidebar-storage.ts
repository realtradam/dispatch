/**
 * LocalStorage persistence for the sidebar panel layout.
 *
 * The sidebar (`SidebarPanel.svelte`) is a variable-length stack of
 * "slot" components; each slot has a dropdown that picks one of N view
 * components to render (Chat Settings, Tasks, Skills, etc.). The
 * source-of-truth `panels` array in the component records the order
 * and selection of each slot. This module persists that array's
 * `selected` field across browser refreshes/loads.
 *
 * Why localStorage and not the backend `settings` table:
 *   - The sidebar layout is a UI preference, not domain state. It
 *     matches the precedent set by `dispatch-theme` and
 *     `dispatch-api-url`, both of which are localStorage.
 *   - Per-device layout is reasonable (a phone may want different
 *     panels than a desktop).
 *   - No backend round-trip on every layout change.
 *
 * Why only the `selected` strings and not the full `Panel` objects:
 *   - The `id` field is a session-ephemeral counter
 *     (`SidebarPanel.svelte:61`) that exists only to keep Svelte's
 *     `{#each ... (panel.id)}` block keyed across reorders. Restoring
 *     ids verbatim would have no benefit, and would collide with the
 *     module-scoped `nextId` counter on remount.
 *   - The `selected` string is everything we need to reconstruct the
 *     visible layout.
 */

const LS_KEY = "dispatch-sidebar-panels";

/**
 * The fallback layout when nothing is stored or the stored value is
 * unusable. Matches the hardcoded initial state at
 * `SidebarPanel.svelte:62` so first-ever load is unchanged: a single
 * "Chat Settings" panel.
 */
const DEFAULT_LAYOUT: ReadonlyArray<string> = ["Chat Settings"];

/**
 * Read the persisted sidebar layout. Returns an array of
 * `panel.selected` strings in render order (top-to-bottom).
 *
 * Falls back to `DEFAULT_LAYOUT` on any of:
 *   - localStorage key absent (first-ever load)
 *   - JSON.parse throws (corrupt write from a prior session)
 *   - parsed value is not an array (someone hand-edited storage)
 *   - parsed array, after filtering non-string entries, is empty
 *     (preserves the "minimum one panel" invariant the UI enforces
 *     via `{#if idx > 0}` on the remove button)
 *
 * Never throws.
 */
export function loadSidebarPanels(): string[] {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return [...DEFAULT_LAYOUT];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [...DEFAULT_LAYOUT];
		// Discard any non-string entries — they could only come from a
		// hand-edited localStorage or a future schema mismatch. Either
		// way, we don't want to render `undefined` as a panel name.
		const cleaned = parsed.filter((x): x is string => typeof x === "string");
		return cleaned.length > 0 ? cleaned : [...DEFAULT_LAYOUT];
	} catch {
		// localStorage access threw (SecurityError in restricted browser
		// contexts, etc.). Fall through to default.
		return [...DEFAULT_LAYOUT];
	}
}

/**
 * Persist the current sidebar layout. Best-effort: errors are
 * swallowed (quota exceeded, localStorage disabled in private mode,
 * SecurityError, etc.). The next save attempt may succeed; even if
 * none do, the current session continues to work — only the cross-
 * reload restore is degraded.
 */
export function saveSidebarPanels(selected: string[]): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(selected));
	} catch {
		// Best-effort.
	}
}
