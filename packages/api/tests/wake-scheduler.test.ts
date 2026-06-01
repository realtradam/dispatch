import { describe, expect, it } from "vitest";
import {
	CLAUDE_RESET_OFFSET_HOURS,
	DAILY_INTERVAL_MS,
	MISSED_WAKE_GRACE_MS,
	nextDailyAfter,
	recoverScheduleEntry,
	resetHourFor,
} from "../src/wake-scheduler.js";

const HOUR = 60 * 60 * 1000;

describe("nextDailyAfter", () => {
	it("returns the input when it is already strictly in the future", () => {
		const now = 1_700_000_000_000;
		const future = now + 60_000;
		expect(nextDailyAfter(future, now)).toBe(future);
	});

	it("advances by exactly 24h when the input is 1ms in the past", () => {
		const now = 1_700_000_000_000;
		const previous = now - 1;
		expect(nextDailyAfter(previous, now)).toBe(previous + DAILY_INTERVAL_MS);
	});

	it("skips multiple missed days in a single step when far in the past", () => {
		const now = 1_700_000_000_000;
		const previous = now - 3 * DAILY_INTERVAL_MS - HOUR; // 3d 1h ago
		const next = nextDailyAfter(previous, now);
		expect(next).toBeGreaterThan(now);
		// Should be the next 24h-multiple boundary, not just +24h.
		expect((next - previous) % DAILY_INTERVAL_MS).toBe(0);
		expect(next - previous).toBe(4 * DAILY_INTERVAL_MS);
	});

	it("returns previous + 1 day exactly when previous == now", () => {
		const now = 1_700_000_000_000;
		expect(nextDailyAfter(now, now)).toBe(now + DAILY_INTERVAL_MS);
	});
});

describe("recoverScheduleEntry", () => {
	const now = 1_700_000_000_000;

	it("leaves a future entry unchanged and does not fire", () => {
		const stored = now + 5 * HOUR;
		expect(recoverScheduleEntry(stored, now)).toEqual({
			nextWakeAt: stored,
			shouldFireNow: false,
		});
	});

	it("fires now for an entry missed by less than the grace window", () => {
		const stored = now - HOUR; // 1h ago, within 2h grace
		const recovered = recoverScheduleEntry(stored, now);
		expect(recovered.shouldFireNow).toBe(true);
		expect(recovered.nextWakeAt).toBeGreaterThan(now);
	});

	it("fires now for an entry missed by exactly the grace window", () => {
		const stored = now - MISSED_WAKE_GRACE_MS;
		expect(recoverScheduleEntry(stored, now).shouldFireNow).toBe(true);
	});

	it("does NOT fire for an entry missed by more than the grace window", () => {
		const stored = now - MISSED_WAKE_GRACE_MS - 1;
		const recovered = recoverScheduleEntry(stored, now);
		expect(recovered.shouldFireNow).toBe(false);
		expect(recovered.nextWakeAt).toBeGreaterThan(now);
	});

	it("always returns a future nextWakeAt for past entries (regardless of grace)", () => {
		for (const ageDays of [0.1, 0.5, 1, 2, 7, 30]) {
			const stored = now - ageDays * DAILY_INTERVAL_MS;
			const { nextWakeAt } = recoverScheduleEntry(stored, now);
			expect(nextWakeAt, `age=${ageDays}d`).toBeGreaterThan(now);
		}
	});

	it("respects a custom grace window", () => {
		const stored = now - 10 * 60_000; // 10 min ago
		expect(recoverScheduleEntry(stored, now, 5 * 60_000).shouldFireNow).toBe(false);
		expect(recoverScheduleEntry(stored, now, 15 * 60_000).shouldFireNow).toBe(true);
	});
});

describe("resetHourFor / CLAUDE_RESET_OFFSET_HOURS", () => {
	it("adds the offset modulo 24", () => {
		expect(resetHourFor(0)).toBe(CLAUDE_RESET_OFFSET_HOURS);
		expect(resetHourFor(20)).toBe((20 + CLAUDE_RESET_OFFSET_HOURS) % 24);
		expect(resetHourFor(23)).toBe((23 + CLAUDE_RESET_OFFSET_HOURS) % 24);
	});

	it("wraps cleanly across midnight", () => {
		// Wake at 22:15, +5h = 03:00
		expect(resetHourFor(22)).toBe(3);
	});
});
