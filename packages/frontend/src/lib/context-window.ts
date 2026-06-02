import type { CacheStats } from "./types.js";

/**
 * Context-window occupancy for the current tab/model.
 *
 * `current` is the size of the model's context on the MOST RECENT request —
 * the last turn's full prompt (`inputTokens`, which already includes cached
 * tokens for Anthropic) plus what the model generated that turn
 * (`outputTokens`). This mirrors how opencode derives context fullness from
 * the last assistant message, and reflects what actually occupies the model's
 * window — NOT the session-cumulative totals shown by the Cache Rate view.
 *
 * `max` is the model's maximum context window from models.dev (or `null` when
 * unknown). `percent` is `current / max * 100` clamped to [0, 100] (unrounded;
 * the UI decides the displayed precision), or `null` when
 * `max` is unknown — in which case the UI shows the bare token count with no
 * denominator or progress bar.
 */
export interface ContextUsage {
	current: number;
	max: number | null;
	percent: number | null;
}

export function computeContextUsage(
	cacheStats: CacheStats | null | undefined,
	contextLimit: number | null | undefined,
): ContextUsage {
	const last = cacheStats?.last ?? null;
	const current = last ? last.inputTokens + last.outputTokens : 0;
	const max = typeof contextLimit === "number" && contextLimit > 0 ? contextLimit : null;
	// Precise (unrounded) percentage clamped to [0, 100]; the UI formats the
	// decimal places. Kept unrounded so small contexts against huge windows
	// (e.g. a few thousand tokens vs. 1,000,000) still read non-zero.
	const percent = max ? Math.max(0, Math.min(100, (current / max) * 100)) : null;
	return { current, max, percent };
}
