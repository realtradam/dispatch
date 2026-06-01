/**
 * Pure helpers for the Claude wake scheduler. Kept side-effect-free so the
 * recovery & rescheduling logic can be unit-tested without spinning up the
 * Hono app or touching SQLite.
 *
 * Semantics — read this before editing:
 *
 *   1. The user picks an hour (0-23) on the frontend. The frontend computes
 *      the *first* fire timestamp in **its** local timezone (target HH:15
 *      tomorrow, or today if still future) and sends absolute Unix ms to
 *      the backend. That absolute ms is the source of truth.
 *
 *   2. After each successful (or attempted) fire we advance by exactly
 *      24h from the previous `next_wake_at`. This preserves the user's
 *      original local wall-clock intent regardless of the *server*'s
 *      timezone (Docker is often UTC, the user is often not). DST can
 *      drift the fire by ±1h on transition day; it self-corrects the next
 *      time the user toggles the hour.
 *
 *   3. On server boot, any persisted entry whose `next_wake_at` is in the
 *      past is "recovered": if it was missed by ≤ MISSED_WAKE_GRACE_MS we
 *      fire it *now* (signal: `shouldFireNow = true`) and then jump
 *      forward 24h at a time until the next slot is in the future. If
 *      missed by more than the grace window we silently skip and jump
 *      forward without firing. Either way the entry stays scheduled.
 */

/** How long after a missed fire we still consider it worth running. */
export const MISSED_WAKE_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Day length used when advancing recurring wakes. */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Fixed offset (hours) from a wake to the "Claude session reset" display. */
export const CLAUDE_RESET_OFFSET_HOURS = 5;

/**
 * Advance `previous` by 24-hour increments until strictly after `now`.
 * Pure: only does math on the given numbers.
 */
export function nextDailyAfter(previous: number, now: number): number {
	if (previous > now) return previous;
	const deltaMs = now - previous;
	// Ceiling division so the result is strictly > now.
	const stepsAhead = Math.floor(deltaMs / DAILY_INTERVAL_MS) + 1;
	return previous + stepsAhead * DAILY_INTERVAL_MS;
}

export interface RecoveredEntry {
	/** New `next_wake_at` to persist (always strictly in the future). */
	nextWakeAt: number;
	/** True if the caller should fire a wake *right now* before scheduling. */
	shouldFireNow: boolean;
}

/**
 * Compute the post-boot state for a single persisted schedule entry.
 *
 *   - Entry still in the future → keep as-is, no fire.
 *   - Missed by ≤ grace window  → fire now, then advance to next day.
 *   - Missed by > grace window  → skip the fire, advance to next day.
 */
export function recoverScheduleEntry(
	storedNextWakeAt: number,
	now: number,
	graceMs: number = MISSED_WAKE_GRACE_MS,
): RecoveredEntry {
	if (storedNextWakeAt > now) {
		return { nextWakeAt: storedNextWakeAt, shouldFireNow: false };
	}
	const overdueBy = now - storedNextWakeAt;
	const shouldFireNow = overdueBy <= graceMs;
	return {
		nextWakeAt: nextDailyAfter(storedNextWakeAt, now),
		shouldFireNow,
	};
}

/** Display hour (0-23) for the "reset" label paired with a wake hour. */
export function resetHourFor(wakeHour: number): number {
	return (wakeHour + CLAUDE_RESET_OFFSET_HOURS) % 24;
}
