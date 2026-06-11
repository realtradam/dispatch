/**
 * Pure core for cache-warming — zero I/O, zero ambient state.
 * Every function is input → output; testable without mocks.
 */

// --- Types ---

/** Persisted per-conversation settings (storage-facing). */
export interface ConversationSettings {
	readonly enabled: boolean;
	readonly intervalMs: number;
}

/** Full per-conversation runtime state (in-memory, not persisted). */
export interface ConversationState extends ConversationSettings {
	readonly active: boolean;
	readonly lastPct: number | null;
	readonly token: number;
}

/** Context stored per-conversation from the latest lifecycle event. */
export interface ConversationContext {
	readonly cwd?: string;
	readonly modelName?: string;
}

export const DEFAULT_INTERVAL_MS = 240_000;
export const MIN_INTERVAL_MS = 1000;

// --- Pure functions ---

/**
 * Compute cache-hit percentage from token counts.
 * Returns an integer in [0, 100]. inputTokens ≤ 0 → 0.
 */
export function computeCachePct(inputTokens: number, cacheReadTokens: number): number {
	if (inputTokens <= 0) return 0;
	const ratio = cacheReadTokens / inputTokens;
	const clamped = Math.max(0, Math.min(1, ratio));
	return Math.round(clamped * 100);
}

/**
 * Decide whether a conversation should be warmed right now.
 * Requires: enabled, idle (not active), and the token is current (not superseded).
 */
export function shouldWarm(state: ConversationState, currentToken: number): boolean {
	return state.enabled && !state.active && state.token === currentToken;
}

/**
 * Check whether a token is still current (not superseded by a newer cancel/fire).
 */
export function isTokenCurrent(current: number, expected: number): boolean {
	return current === expected;
}

const SETTINGS_KEY = "settings";

/**
 * Parse settings from a raw storage string.
 * Returns defaults if null or malformed.
 */
export function parseSettings(raw: string | null): ConversationSettings {
	if (raw === null) return { enabled: true, intervalMs: DEFAULT_INTERVAL_MS };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return { enabled: true, intervalMs: DEFAULT_INTERVAL_MS };
		}
		const obj = parsed as Record<string, unknown>;
		const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
		const rawInterval = obj.intervalMs;
		let intervalMs = DEFAULT_INTERVAL_MS;
		if (typeof rawInterval === "number" && Number.isFinite(rawInterval)) {
			intervalMs =
				rawInterval <= 0 ? MIN_INTERVAL_MS : Math.max(MIN_INTERVAL_MS, Math.round(rawInterval));
		}
		return { enabled, intervalMs };
	} catch {
		return { enabled: true, intervalMs: DEFAULT_INTERVAL_MS };
	}
}

/**
 * Serialize settings for storage.
 */
export function serializeSettings(settings: ConversationSettings): string {
	return JSON.stringify(settings);
}

/** The storage key for a conversation's settings. */
export function settingsKey(conversationId: string): string {
	return `${SETTINGS_KEY}:${conversationId}`;
}
