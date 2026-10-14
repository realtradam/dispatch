/**
 * Hyper (charm.land) daily Hypercredits — PURE logic.
 *
 * `GET <base>/credits` returns ONLY `{ "balance": N }` (verified live; the
 * docs list no other field or endpoint). The plan allowance and the refresh
 * time are therefore user SETTINGS:
 * - `dailyAllowance` (default 250) — the daily refill amount;
 * - `resetAnchor` — any epoch-ms instant at which a refresh happens; resets
 *   recur every 24h from it. Set manually, or DETECTED from an observed refill
 *   (balance jumps up to ≥ the allowance between two polls).
 */
import type { AccountUsageDailyCredits, AccountUsageLimit } from "@dispatch/transport-contract";
import { DAY_MS, isRecord, toNumber, usageStatus } from "./shared.js";

export const HYPER_DEFAULT_BASE_URL = "https://hyper.charm.land/v1";
export const HYPER_DEFAULT_DAILY_ALLOWANCE = 250;

export interface DailyCreditsSettings {
  readonly dailyAllowance: number;
  /** User-set reset anchor (epoch-ms), or null. Wins over `detectedAnchor`. */
  readonly manualAnchor: number | null;
  /** Anchor inferred from an observed refill (epoch-ms), or null. */
  readonly detectedAnchor: number | null;
}

export const DEFAULT_DAILY_CREDITS_SETTINGS: DailyCreditsSettings = {
  dailyAllowance: HYPER_DEFAULT_DAILY_ALLOWANCE,
  manualAnchor: null,
  detectedAnchor: null,
};

/** Parse `{ balance }` from `/v1/credits`; null when absent/malformed. */
export function parseHyperCredits(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const balance = toNumber(raw.balance);
  return balance === undefined ? null : balance;
}

/** The next reset strictly after `now`, recurring every 24h from `anchor`. */
export function nextDailyReset(anchor: number, now: number): number {
  const elapsed = now - anchor;
  const periods = Math.floor(elapsed / DAY_MS) + 1;
  return anchor + periods * DAY_MS;
}

/**
 * Did a refill happen between two balances? A refill tops the plan balance
 * back up, so the balance ROSE and is now at least ~the allowance. (A bundle
 * purchase can also raise it — the 95% floor plus "rose" keeps small bundle
 * top-ups from counting, but a large purchase may mis-detect; a manual anchor
 * always wins.)
 */
export function isRefill(prev: number, next: number, allowance: number): boolean {
  return next > prev && next >= allowance * 0.95;
}

/** Parse + validate stored settings (tolerant of partial/legacy JSON). */
export function parseDailyCreditsSettings(raw: string | null): DailyCreditsSettings {
  if (raw === null) return DEFAULT_DAILY_CREDITS_SETTINGS;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v)) return DEFAULT_DAILY_CREDITS_SETTINGS;
    const allowance = toNumber(v.dailyAllowance);
    const manual = toNumber(v.manualAnchor);
    const detected = toNumber(v.detectedAnchor);
    return {
      dailyAllowance:
        allowance !== undefined && Number.isInteger(allowance) && allowance > 0
          ? allowance
          : HYPER_DEFAULT_DAILY_ALLOWANCE,
      manualAnchor: manual ?? null,
      detectedAnchor: detected ?? null,
    };
  } catch {
    return DEFAULT_DAILY_CREDITS_SETTINGS;
  }
}

export type SettingsPatchResult =
  | { readonly ok: true; readonly settings: DailyCreditsSettings }
  | { readonly ok: false; readonly error: string };

/** Validate + apply a `PUT /usage/hyper/settings` body. */
export function applySettingsPatch(
  current: DailyCreditsSettings,
  body: unknown,
): SettingsPatchResult {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  let next = current;
  if ("dailyAllowance" in body) {
    const a = body.dailyAllowance;
    if (typeof a !== "number" || !Number.isInteger(a) || a <= 0 || a > 1_000_000_000) {
      return { ok: false, error: "dailyAllowance must be a positive integer" };
    }
    next = { ...next, dailyAllowance: a };
  }
  if ("resetAnchor" in body) {
    const r = body.resetAnchor;
    if (r === null) next = { ...next, manualAnchor: null };
    else if (typeof r === "number" && Number.isFinite(r) && r > 0) {
      next = { ...next, manualAnchor: Math.round(r) };
    } else return { ok: false, error: "resetAnchor must be an epoch-ms number or null" };
  }
  return { ok: true, settings: next };
}

/** The daily-credits detail + the limit row for the current balance/settings. */
export function buildDailyCredits(
  balance: number,
  settings: DailyCreditsSettings,
  now: number,
): { readonly detail: AccountUsageDailyCredits; readonly limit: AccountUsageLimit } {
  const allowance = settings.dailyAllowance;
  const anchor = settings.manualAnchor ?? settings.detectedAnchor;
  const source = settings.manualAnchor !== null ? "manual" : anchor !== null ? "detected" : null;
  const used = Math.min(allowance, Math.max(0, allowance - balance));
  const usedFraction = used / allowance;
  const status = balance <= 0 ? "exhausted" : usageStatus(usedFraction);
  return {
    detail: { balance, allowance, resetAnchor: anchor, resetSource: source },
    limit: {
      id: "hyper:daily",
      label: "Daily credits",
      kind: "window",
      windowId: "1d",
      shared: true,
      tier: null,
      durationMs: DAY_MS,
      resetsAt: anchor === null ? null : nextDailyReset(anchor, now),
      unit: "credits",
      used,
      limit: allowance,
      remaining: allowance - used,
      usedFraction,
      remainingFraction: 1 - usedFraction,
      status,
    },
  };
}
