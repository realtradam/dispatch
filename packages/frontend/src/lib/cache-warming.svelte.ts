/**
 * Prompt-cache WARMING — frontend timer/orchestration store.
 *
 * Keeps a tab's provider prompt-cache warm while the tab is IDLE by firing a
 * cheap "warm" request (`POST /chat/warm`) on a repeating ~4-minute cadence.
 * The backend replays the tab's EXACT cached prefix plus one trivial throwaway
 * turn (see `Agent.warmCache`), which registers a cache READ and refreshes the
 * provider's ~5-min prompt-cache TTL so the user's next real message lands on a
 * warm cache.
 *
 * Lifecycle (driven by the tab store via the `onTurn*` / `onUserMessage` hooks):
 *  - A turn ENDS (tab goes idle)         → arm: schedule a fire in 4 minutes.
 *  - The timer fires                      → warm, then re-arm 4 minutes out
 *                                           (repeats; resets the countdown each
 *                                           cycle).
 *  - A turn is ONGOING (generation active) → never fires; the pending timer is
 *                                            cancelled.
 *  - The user sends a real message        → disable+reset the timer immediately;
 *                                            the turn it starts re-arms warming
 *                                            once it ends.
 *
 * CRITICAL: the warming request is debug-only. Its cache data is surfaced ONLY
 * as a warming-specific "Last request" percentage here — it is NEVER folded
 * into the real Cache Rate metric, never persisted, never counted toward
 * context. The backend route returns just the request's `usage`; nothing else.
 */

import type { AgentModelEntry } from "@dispatch/core/src/types/index.js";
import {
	clearCacheWarmEnabled,
	loadCacheWarmEnabled,
	saveCacheWarmEnabled,
} from "./cache-warm-storage.js";
import { config } from "./config.js";

/** Re-warm cadence. Comfortably under Claude's ~5-min prompt-cache expiry. */
export const WARM_INTERVAL_MS = 4 * 60 * 1000;

/** Per-tab request parameters the warm POST needs (resolved from the tab). */
export interface WarmRequestParams {
	keyId: string | null;
	modelId: string | null;
	agentModels: AgentModelEntry[] | null;
}

/** Reactive, per-tab warming UI state (read by the Chat Settings debug strip). */
export interface WarmState {
	/** User toggle (persisted per-tab in localStorage). */
	enabled: boolean;
	/** Epoch ms of the next scheduled fire, or null when not armed. */
	nextFireAt: number | null;
	/**
	 * Cache-read % of the most recent warming request (0–100), or null if it
	 * has never fired this session. Drives the "-%" → number display.
	 */
	lastPct: number | null;
	/** Last warming error (provider/network), surfaced in the debug strip. */
	error: string | null;
	/** True while a warm request is in flight. */
	firing: boolean;
}

function defaultState(enabled: boolean): WarmState {
	return { enabled, nextFireAt: null, lastPct: null, error: null, firing: false };
}

function computeCachePct(inputTokens: number, cacheReadTokens: number): number {
	if (inputTokens <= 0) return 0;
	return Math.round(Math.max(0, Math.min(1, cacheReadTokens / inputTokens)) * 100);
}

export function createCacheWarmingStore() {
	// Reactive per-tab state. Nested mutation is reactive via Svelte 5 proxies;
	// new keys are assigned wholesale (also reactive).
	const states = $state<Record<string, WarmState>>({});
	// Ticking clock so the countdown display refreshes once per second. Only
	// ticked while at least one tab is armed (see (re)startTicker).
	let now = $state(Date.now());

	// Non-reactive bookkeeping (timers, in-flight tokens, running set, resolver).
	const fireTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const fireTokens = new Map<string, number>();
	const runningTabs = new Set<string>();
	let ticker: ReturnType<typeof setInterval> | null = null;
	let resolveParams: ((tabId: string) => WarmRequestParams | null) | null = null;

	function ensure(tabId: string): WarmState {
		let s = states[tabId];
		if (!s) {
			s = defaultState(loadCacheWarmEnabled(tabId));
			states[tabId] = s;
		}
		return s;
	}

	function anyArmed(): boolean {
		for (const s of Object.values(states)) {
			if (s.nextFireAt !== null) return true;
		}
		return false;
	}

	function startTickerIfNeeded(): void {
		if (ticker !== null) return;
		if (typeof setInterval !== "function") return;
		ticker = setInterval(() => {
			now = Date.now();
			// Self-stop once nothing is armed, so we don't tick forever.
			if (!anyArmed()) stopTicker();
		}, 1000);
	}

	function stopTicker(): void {
		if (ticker !== null) {
			clearInterval(ticker);
			ticker = null;
		}
	}

	function clearFireTimer(tabId: string): void {
		const t = fireTimers.get(tabId);
		if (t !== undefined) {
			clearTimeout(t);
			fireTimers.delete(tabId);
		}
	}

	/** Cancel any pending fire / in-flight request and clear the countdown. */
	function cancel(tabId: string): void {
		clearFireTimer(tabId);
		// Invalidate any in-flight warm so its late result is ignored.
		fireTokens.set(tabId, (fireTokens.get(tabId) ?? 0) + 1);
		const s = states[tabId];
		if (s) s.nextFireAt = null;
		if (!anyArmed()) stopTicker();
	}

	/** Schedule the next fire 4 minutes out — only when enabled AND idle. */
	function arm(tabId: string): void {
		const s = ensure(tabId);
		if (!s.enabled) return;
		if (runningTabs.has(tabId)) return;
		clearFireTimer(tabId);
		s.nextFireAt = Date.now() + WARM_INTERVAL_MS;
		startTickerIfNeeded();
		if (typeof setTimeout === "function") {
			fireTimers.set(
				tabId,
				setTimeout(() => {
					fireTimers.delete(tabId);
					void fire(tabId);
				}, WARM_INTERVAL_MS),
			);
		}
	}

	/** Perform one warming request, then (if still eligible) re-arm. */
	async function fire(tabId: string): Promise<void> {
		const s = ensure(tabId);
		if (!s.enabled || runningTabs.has(tabId) || s.firing) {
			return;
		}
		const token = (fireTokens.get(tabId) ?? 0) + 1;
		fireTokens.set(tabId, token);
		const params = resolveParams?.(tabId) ?? null;

		s.firing = true;
		s.error = null;
		// Clear the countdown while the request is in flight.
		s.nextFireAt = null;
		try {
			const res = await fetch(`${config.apiBase}/chat/warm`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tabId,
					...(params?.keyId ? { keyId: params.keyId } : {}),
					...(params?.modelId ? { modelId: params.modelId } : {}),
					...(params?.agentModels ? { agentModels: params.agentModels } : {}),
				}),
			});
			// A newer cancel/fire superseded this request — drop its result so it
			// can't clobber fresher state (e.g. user sent a real message meanwhile).
			if (fireTokens.get(tabId) !== token) return;

			if (!res.ok) {
				let msg = `warm failed (HTTP ${res.status})`;
				try {
					const body = (await res.json()) as { error?: string };
					if (body?.error) msg = body.error;
				} catch {
					/* non-JSON error body — keep the HTTP status message */
				}
				s.error = msg;
			} else {
				const data = (await res.json()) as {
					usage?: { inputTokens?: number; cacheReadTokens?: number };
				};
				const u = data.usage ?? {};
				s.lastPct = computeCachePct(u.inputTokens ?? 0, u.cacheReadTokens ?? 0);
				s.error = null;
			}
		} catch (err) {
			if (fireTokens.get(tabId) !== token) return;
			s.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (fireTokens.get(tabId) === token) {
				s.firing = false;
				// Re-arm for the next cycle (resets the 4-min countdown), but only
				// if still enabled and the tab is still idle.
				if (s.enabled && !runningTabs.has(tabId)) arm(tabId);
				else if (!anyArmed()) stopTicker();
			}
		}
	}

	// ─── Public lifecycle hooks (called by the tab store) ────────────

	/**
	 * Register the resolver the store uses to fetch a tab's request params
	 * (key/model/agentModels) at fire time. Called once by the tab store.
	 */
	function setRequestResolver(fn: (tabId: string) => WarmRequestParams | null): void {
		resolveParams = fn;
	}

	/** Seed a tab's state from persistence. Arms immediately if enabled+idle. */
	function initTab(tabId: string): void {
		const s = ensure(tabId);
		if (s.enabled && !runningTabs.has(tabId) && s.nextFireAt === null) {
			arm(tabId);
		}
	}

	/** Toggle warming for a tab (persisted). Arms or cancels accordingly. */
	function setEnabled(tabId: string, enabled: boolean): void {
		const s = ensure(tabId);
		s.enabled = enabled;
		saveCacheWarmEnabled(tabId, enabled);
		if (enabled) arm(tabId);
		else cancel(tabId);
	}

	/** A turn started / generation is active — never warm during a turn. */
	function onTurnActive(tabId: string): void {
		runningTabs.add(tabId);
		cancel(tabId);
	}

	/** A turn ended (tab idle) — re-arm the 4-minute countdown if enabled. */
	function onTurnEnded(tabId: string): void {
		runningTabs.delete(tabId);
		const s = ensure(tabId);
		if (s.enabled) arm(tabId);
	}

	/**
	 * The user sent a real message — disable+reset the timer immediately. The
	 * turn this message starts will re-arm warming via `onTurnEnded` once it
	 * settles, so the real message lands on a cache with no throwaway turns.
	 */
	function onUserMessage(tabId: string): void {
		cancel(tabId);
	}

	/** Forget a closed tab's timers/state. */
	function removeTab(tabId: string): void {
		cancel(tabId);
		fireTimers.delete(tabId);
		fireTokens.delete(tabId);
		runningTabs.delete(tabId);
		delete states[tabId];
		if (!anyArmed()) stopTicker();
	}

	/**
	 * Forget a tab AND drop its persisted preference — for an explicit user
	 * close/archive. (`removeTab` keeps the persisted flag so an ephemeral
	 * idle-cleanup or a later reopen restores the user's choice.)
	 */
	function forgetTab(tabId: string): void {
		removeTab(tabId);
		clearCacheWarmEnabled(tabId);
	}

	/** Reactive state for a tab (creates a default-off entry if absent). */
	function stateFor(tabId: string | null | undefined): WarmState {
		if (!tabId) return defaultState(false);
		return ensure(tabId);
	}

	return {
		setRequestResolver,
		initTab,
		setEnabled,
		onTurnActive,
		onTurnEnded,
		onUserMessage,
		removeTab,
		forgetTab,
		stateFor,
		/** Reactive ticking clock (epoch ms) for countdown rendering. */
		get now() {
			return now;
		},
		// Exposed for tests to drive a fire without waiting 4 minutes.
		fireNow: fire,
	};
}

export const cacheWarming = createCacheWarmingStore();
