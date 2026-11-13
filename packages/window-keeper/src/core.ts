/**
 * window-keeper core — PURE policy: constants, clock parsing, and report
 * classification. No I/O, no timers, no module state.
 *
 * "Server time" always means `localNow + clockOffsetMs`; the offset comes from
 * the provider's `Date` response header.
 */
import type { AccountUsageLimit, AccountUsageReport } from "@dispatch/transport-contract";

export const CHECK_DELAY_MS = 5_000;
export const FALLBACK_KICK_DELAY_MS = 30_000;
export const REKICK_INTERVAL_MS = 15_000;
export const MAX_REKICKS = 5;
export const UNKNOWN_RECHECK_MS = 5 * 60_000;
export const KICK_BACKOFF_MS = 10 * 60_000;
export const MAX_KICK_BACKOFF_MS = 6 * 60 * 60_000;
export const MAX_SLEEP_MS = 30 * 60_000;
export const RUNNING_MARGIN_MS = 60_000;
export const FLOATING_MARGIN_MS = 120_000;
export const REPORT_MAX_AGE_MS = 60_000;
export const BOOT_DELAY_MS = 10_000;
export const DATE_HEADER = "date";

/** Anthropic clock minus the local clock (ms) from the `date` header, or null. */
export function parseClockOffset(
  headers: Readonly<Record<string, string>>,
  localNow: number,
): number | null {
  const value = headers[DATE_HEADER];
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed - localNow : null;
}

/**
 * True when the window has not started counting down: zero usage and either no
 * reset at all, or a reset a full `durationMs` away (within FLOATING_MARGIN_MS).
 */
export function isFloatingIdle(row: AccountUsageLimit, serverNow: number): boolean {
  if (row.usedFraction !== 0) return false;
  if (row.resetsAt === null) return true;
  return row.durationMs !== null && row.resetsAt - serverNow >= row.durationMs - FLOATING_MARGIN_MS;
}

/** What a usage report says about the watched window right now. */
export type ReportVerdict =
  | { readonly kind: "running"; readonly resetsAt: number }
  | { readonly kind: "blocked"; readonly until: number }
  | { readonly kind: "idle" }
  | { readonly kind: "unknown" };

/** Classify a usage report; rule order is significant (running wins over blocked). */
export function classifyReport(
  report: AccountUsageReport | null,
  limitId: string,
  serverNow: number,
  localNow: number,
): ReportVerdict {
  if (
    report === null ||
    report.state !== "fresh" ||
    report.fetchedAt === null ||
    localNow - report.fetchedAt > REPORT_MAX_AGE_MS
  ) {
    return { kind: "unknown" };
  }
  const row = report.limits.find((limit) => limit.id === limitId);
  if (
    row !== undefined &&
    row.resetsAt !== null &&
    row.resetsAt > serverNow &&
    !isFloatingIdle(row, serverNow)
  ) {
    return { kind: "running", resetsAt: row.resetsAt };
  }
  let blockedUntil: number | null = null;
  for (const limit of report.limits) {
    if (limit.status !== "exhausted") continue;
    if (limit.resetsAt === null || limit.resetsAt <= serverNow) continue;
    if (blockedUntil === null || limit.resetsAt > blockedUntil) blockedUntil = limit.resetsAt;
  }
  if (blockedUntil !== null) return { kind: "blocked", until: blockedUntil };
  if (row !== undefined && isFloatingIdle(row, serverNow)) {
    return { kind: "idle" };
  }
  return { kind: "unknown" };
}

/** True when `resetsAt` is far enough in the future to count as a running window. */
export function windowIsRunning(resetsAt: number | null, serverNow: number): boolean {
  return resetsAt !== null && resetsAt > serverNow + RUNNING_MARGIN_MS;
}

/** Exponential back-off after consecutive failed kick sequences: 10, 20, 40, … capped at 6 h. */
export function kickBackoffMs(consecutiveFailures: number): number {
  return Math.min(
    KICK_BACKOFF_MS * 2 ** (Math.max(consecutiveFailures, 1) - 1),
    MAX_KICK_BACKOFF_MS,
  );
}
