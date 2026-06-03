/**
 * LocalStorage persistence for the per-tab "prompt cache warming" toggle.
 *
 * Cache warming keeps a tab's provider prompt-cache warm while the tab is idle
 * by periodically replaying its exact cached conversation plus a trivial
 * throwaway turn (see `cache-warming.svelte.ts`). Whether warming is enabled is
 * a per-tab preference that must survive a browser reload.
 *
 * Why localStorage and not the backend `settings` table:
 *   - It's a per-device UI preference, not domain state — the same precedent as
 *     `dispatch-sidebar-panels`, `dispatch-theme`, and `dispatch-api-url`.
 *   - No backend round-trip on every toggle.
 *   - Warming itself is a frontend-driven timer; keeping its on/off flag on the
 *     frontend keeps the whole feature self-contained.
 *
 * Shape: a single JSON object mapping `tabId -> boolean` under one key, so a
 * closed tab's stale entry is cheap and easy to prune.
 */

const LS_KEY = "dispatch-cache-warming";

type WarmMap = Record<string, boolean>;

/** Read the whole tab→enabled map. Never throws; returns {} on any failure. */
function readMap(): WarmMap {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: WarmMap = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "boolean") out[k] = v;
		}
		return out;
	} catch {
		// localStorage unavailable (private mode / restricted context) or corrupt
		// write from a prior session. Degrade to "nothing persisted".
		return {};
	}
}

/** Persist the whole map. Best-effort — swallows quota / access errors. */
function writeMap(map: WarmMap): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(map));
	} catch {
		// Best-effort: the in-memory store remains the source of truth for the
		// current session even if persistence fails.
	}
}

/** Whether cache warming is enabled for `tabId` (default: false). */
export function loadCacheWarmEnabled(tabId: string): boolean {
	return readMap()[tabId] === true;
}

/**
 * Persist the warming toggle for one tab. Writing `false` removes the entry
 * (default is off, so absence is the natural "disabled" representation and
 * keeps stale tabs from accumulating).
 */
export function saveCacheWarmEnabled(tabId: string, enabled: boolean): void {
	const map = readMap();
	if (enabled) map[tabId] = true;
	else delete map[tabId];
	writeMap(map);
}

/** Drop a tab's persisted toggle entirely (called when the tab is closed). */
export function clearCacheWarmEnabled(tabId: string): void {
	const map = readMap();
	if (tabId in map) {
		delete map[tabId];
		writeMap(map);
	}
}
