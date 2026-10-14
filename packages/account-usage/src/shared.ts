/**
 * Shared PURE helpers for account-usage normalization (no I/O).
 */
import type {
  AccountUsageCredits,
  AccountUsageLimit,
  AccountUsageLimitStatus,
} from "@dispatch/transport-contract";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/**
 * The provider-agnostic body of a usage report produced by a provider fetch /
 * header parse: everything except freshness bookkeeping (which the cache owns).
 */
export interface ProviderUsage {
  readonly account: {
    readonly accountId: string | null;
    readonly email: string | null;
    readonly planType: string | null;
  };
  readonly limits: readonly AccountUsageLimit[];
  readonly limitReached: boolean | null;
  readonly canServe: boolean | null;
  readonly creditOverage: boolean;
  readonly credits: AccountUsageCredits | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite number from a number or numeric string, else undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** ISO timestamp → epoch-ms, else undefined. */
export function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Epoch seconds OR milliseconds → epoch-ms (values < 1e12 are treated as seconds). */
export function epochToMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/** Standard thresholds: ≥1 exhausted, ≥0.9 warning. */
export function usageStatus(usedFraction: number | null | undefined): AccountUsageLimitStatus {
  if (usedFraction === null || usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

/** A percent meter (used 0..100 clamped, limit 100). */
export function percentAmount(
  usedPercent: number,
): Pick<
  AccountUsageLimit,
  "unit" | "used" | "limit" | "remaining" | "usedFraction" | "remainingFraction"
> {
  const used = Math.min(Math.max(usedPercent, 0), 100);
  const usedFraction = used / 100;
  return {
    unit: "percent",
    used,
    limit: 100,
    remaining: 100 - used,
    usedFraction,
    remainingFraction: 1 - usedFraction,
  };
}

/** "5 hours" / "7 days" / "1 day" from a window length in seconds. */
export function windowLabelFromSeconds(seconds: number): { id: string; label: string } {
  if (seconds >= 86_400) {
    const days = Math.round(seconds / 86_400);
    return { id: `${days}d`, label: `${days} ${days === 1 ? "day" : "days"}` };
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return { id: `${hours}h`, label: `${hours} ${hours === 1 ? "hour" : "hours"}` };
}

/** Lower-case kebab slug. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Two reset timestamps within this tolerance are the same window instance. */
const SAME_WINDOW_TOLERANCE_MS = 5 * 60_000;

/**
 * Pick the row to keep when a header row replaces an existing one. Within the
 * SAME window instance usage only grows, and inference headers are coarser
 * than the endpoint (e.g. `0.1` vs `11%`) — so never move usage backwards
 * unless the window has reset (its `resetsAt` moved).
 */
function pickRow(existing: AccountUsageLimit, incoming: AccountUsageLimit): AccountUsageLimit {
  const sameWindow =
    existing.resetsAt === null ||
    incoming.resetsAt === null ||
    Math.abs(existing.resetsAt - incoming.resetsAt) <= SAME_WINDOW_TOLERANCE_MS;
  if (sameWindow && incoming.used < existing.used) return existing;
  return incoming;
}

/**
 * Merge header-derived limits into an existing report: rows with the same id
 * are replaced (monotonic within a window — see `pickRow`); endpoint-only rows
 * (e.g. spend, scoped meters) are kept.
 */
export function mergeLimits(
  base: readonly AccountUsageLimit[],
  incoming: readonly AccountUsageLimit[],
): AccountUsageLimit[] {
  const byId = new Map(incoming.map((l) => [l.id, l] as const));
  const merged = base.map((l) => {
    const next = byId.get(l.id);
    return next ? pickRow(l, next) : l;
  });
  for (const l of incoming) if (!base.some((b) => b.id === l.id)) merged.push(l);
  return merged;
}
