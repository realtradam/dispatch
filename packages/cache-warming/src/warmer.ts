import type { Logger, StorageNamespace } from "@dispatch/kernel";
import type { WarmCompletedPayload, WarmService } from "@dispatch/session-orchestrator";
import {
	type ConversationContext,
	type ConversationSettings,
	type ConversationState,
	computeCachePct,
	computeExpectedCacheRate,
	DEFAULT_INTERVAL_MS,
	MIN_INTERVAL_MS,
	parseSettings,
	serializeSettings,
	settingsKey,
	shouldWarm,
} from "./pure.js";

// --- Timer abstraction (injectable for tests) ---

export interface TimerDeps {
	readonly setTimer: (fn: () => void, ms: number) => number;
	readonly clearTimer: (id: number) => void;
}

// --- Warmer interface ---

export interface CacheWarmer {
	/** Handle a turnStarted event — mark conversation active, cancel pending warm. */
	readonly onTurnStarted: (conversationId: string) => void;

	/** Handle a turnSettled event — mark idle, store context, arm timer if enabled. */
	readonly onTurnSettled: (conversationId: string, ctx: ConversationContext) => void;

	/** Handle a warmCompleted event — process warm result, update surface, re-arm timer. */
	readonly onWarmCompleted: (payload: WarmCompletedPayload) => void;

	/** Get the current state for a conversation (for surface rendering). */
	readonly getState: (conversationId: string) => ConversationState;

	/** Get the stored context for a conversation. */
	readonly getContext: (conversationId: string) => ConversationContext;

	/** Toggle enabled for a conversation. Returns updated settings. */
	readonly setEnabled: (conversationId: string, enabled: boolean) => Promise<ConversationSettings>;

	/** Set the refresh interval for a conversation. Returns updated settings. */
	readonly setIntervalMs: (
		conversationId: string,
		intervalMs: number,
	) => Promise<ConversationSettings>;

	/** Dispose all timers (for cleanup). */
	readonly dispose: () => void;
}

export interface CacheWarmerDeps {
	readonly warm: WarmService["warm"];
	readonly storage: StorageNamespace;
	readonly logger: Logger;
	readonly timers: TimerDeps;
	/** Injected clock — returns epoch-ms. */
	readonly now: () => number;
	/** Called when surface subscribers should re-fetch the spec. */
	readonly onSurfaceChange: () => void;
}

const DEFAULT_STATE: ConversationState = {
	enabled: true,
	intervalMs: DEFAULT_INTERVAL_MS,
	active: false,
	lastPct: null,
	lastExpectedPct: null,
	lastWarmAt: null,
	nextWarmAt: null,
	token: 0,
};

export function createCacheWarmer(deps: CacheWarmerDeps): CacheWarmer {
	// Per-conversation runtime state (not persisted — reconstructed from storage + events)
	const states = new Map<string, ConversationState>();
	// Per-conversation context from latest lifecycle event
	const contexts = new Map<string, ConversationContext>();
	// Per-conversation pending timer id
	const timers = new Map<string, number>();
	// Monotonic token per conversation for in-flight invalidation
	let nextToken = 1;

	function getState(conversationId: string): ConversationState {
		return states.get(conversationId) ?? DEFAULT_STATE;
	}

	function getContext(conversationId: string): ConversationContext {
		return contexts.get(conversationId) ?? {};
	}

	function setState(conversationId: string, state: ConversationState): void {
		states.set(conversationId, state);
	}

	function cancelTimer(conversationId: string): void {
		const existing = timers.get(conversationId);
		if (existing !== undefined) {
			deps.timers.clearTimer(existing);
			timers.delete(conversationId);
		}
		mergeState(conversationId, { nextWarmAt: null });
	}

	function armTimer(conversationId: string): void {
		cancelTimer(conversationId);
		const state = getState(conversationId);
		if (!state.enabled || state.active) return;

		const token = nextToken++;
		const nowMs = deps.now();
		const nextWarmAt = nowMs + state.intervalMs;
		setState(conversationId, { ...state, token, nextWarmAt });

		const timerId = deps.timers.setTimer(() => {
			timers.delete(conversationId);
			void fireWarm(conversationId, token);
		}, state.intervalMs);

		timers.set(conversationId, timerId);
	}

	async function fireWarm(conversationId: string, token: number): Promise<void> {
		const state = getState(conversationId);
		if (!shouldWarm(state, token)) {
			deps.logger.debug("cache-warming: skip warm (superseded or disabled)", {
				conversationId,
			});
			return;
		}

		const ctx = getContext(conversationId);
		deps.logger.debug("cache-warming: firing warm", { conversationId });

		await deps.warm(conversationId, {
			...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
			...(ctx.modelName !== undefined ? { modelName: ctx.modelName } : {}),
		});

		// Result processing is handled by the warmCompleted event handler.
		// Timer re-arm is also handled there on success.
	}

	async function loadSettings(conversationId: string): Promise<ConversationSettings> {
		const raw = await deps.storage.get(settingsKey(conversationId));
		return parseSettings(raw);
	}

	async function persistSettings(
		conversationId: string,
		settings: ConversationSettings,
	): Promise<void> {
		await deps.storage.set(settingsKey(conversationId), serializeSettings(settings));
	}

	function mergeState(
		conversationId: string,
		partial: Partial<ConversationState>,
	): ConversationState {
		const current = getState(conversationId);
		const updated = { ...current, ...partial };
		setState(conversationId, updated);
		return updated;
	}

	return {
		onTurnStarted(conversationId) {
			deps.logger.debug("cache-warming: turn started", { conversationId });
			mergeState(conversationId, { active: true });
			cancelTimer(conversationId);
		},

		onTurnSettled(conversationId, ctx) {
			deps.logger.debug("cache-warming: turn settled", { conversationId });
			contexts.set(conversationId, ctx);
			mergeState(conversationId, { active: false });

			const state = getState(conversationId);
			if (state.enabled) {
				armTimer(conversationId);
			}
		},

		onWarmCompleted(payload) {
			const { conversationId, usage } = payload;
			const state = getState(conversationId);

			// Drop if the conversation became active while the warm was in flight
			if (state.active) {
				deps.logger.debug("cache-warming: dropping warm result (conversation active)", {
					conversationId,
				});
				return;
			}

			const pct = computeCachePct(usage.inputTokens, usage.cacheReadTokens);
			const expectedPct = computeExpectedCacheRate(usage.cacheReadTokens, usage.cacheWriteTokens);
			const nowMs = deps.now();
			setState(conversationId, {
				...state,
				lastPct: pct,
				lastExpectedPct: expectedPct,
				lastWarmAt: nowMs,
			});
			deps.onSurfaceChange();
			deps.logger.debug("cache-warming: warm complete", {
				conversationId,
				pct,
				expectedPct,
			});

			// Re-arm the automatic timer if enabled and not active
			const updated = getState(conversationId);
			if (updated.enabled && !updated.active) {
				armTimer(conversationId);
			}
		},

		getState,
		getContext,

		async setEnabled(conversationId, enabled) {
			const settings = await loadSettings(conversationId);
			const updated = { ...settings, enabled };
			await persistSettings(conversationId, updated);
			mergeState(conversationId, { enabled });

			if (enabled) {
				const state = getState(conversationId);
				if (!state.active) {
					armTimer(conversationId);
				}
			} else {
				cancelTimer(conversationId);
			}

			deps.onSurfaceChange();
			return updated;
		},

		async setIntervalMs(conversationId, intervalMs) {
			const clamped =
				!Number.isFinite(intervalMs) || intervalMs <= 0
					? MIN_INTERVAL_MS
					: Math.max(MIN_INTERVAL_MS, Math.round(intervalMs));
			const settings = await loadSettings(conversationId);
			const updated = { ...settings, intervalMs: clamped };
			await persistSettings(conversationId, updated);
			mergeState(conversationId, { intervalMs: clamped });

			// Re-arm with new interval if currently armed
			const state = getState(conversationId);
			if (state.enabled && !state.active && timers.has(conversationId)) {
				armTimer(conversationId);
			}

			deps.onSurfaceChange();
			return updated;
		},

		dispose() {
			for (const [conversationId] of timers) {
				cancelTimer(conversationId);
			}
		},
	};
}
