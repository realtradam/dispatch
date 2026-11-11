/**
 * OpenCode Go subscription allowance — PURE logic.
 *
 * `GET <base>/usage` (base = the OpenCode Go inference base URL, default
 * `https://opencode.ai/zen/go/v1`), authenticated with the same API key the
 * provider streams with, returns the three Go allowance windows:
 *
 *     { "usage": {
 *         "rolling": { "status": "ok" | "rate-limited", "percent": 42, "resetsAt": "<ISO>" },
 *         "weekly":  { ... },
 *         "monthly": { ... } } }
 *
 * `rolling` is the 5-hour window. `percent` is 0..100 of that window's
 * allowance; `status: "rate-limited"` means Go refuses requests until the
 * window resets. The endpoint is not in OpenCode's public docs — this shape is
 * the one OpenCode's own open-source client reads (`UsageLimits` in
 * anomalyco/opencode), so the parser is deliberately tolerant: a missing or
 * malformed window is skipped rather than failing the whole report.
 */
import type { AccountUsageLimit } from "@dispatch/transport-contract";
import {
  DAY_MS,
  epochToMs,
  HOUR_MS,
  isRecord,
  nonEmptyString,
  type ProviderUsage,
  parseIsoTimestamp,
  percentAmount,
  toNumber,
  usageStatus,
  WEEK_MS,
} from "./shared.js";

export const OPENCODE_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Fallback monthly window length when the reset instant is unknown. */
const DEFAULT_MONTH_MS = 30 * DAY_MS;

/**
 * Length of the monthly window ENDING at `resetsAt`: the span back to the same
 * day-of-month one calendar month earlier (28–31 days). The endpoint reports
 * only the reset instant, so the window start is derived; it only positions
 * the pace marker, never the reported usage.
 */
export function monthlyWindowMs(resetsAt: number | null): number {
  if (resetsAt === null) return DEFAULT_MONTH_MS;
  const end = new Date(resetsAt);
  const start = new Date(resetsAt);
  start.setUTCMonth(start.getUTCMonth() - 1);
  // A day-of-month the previous month lacks (e.g. Mar 31 → "Feb 31") overflows
  // forward into the reset month — clamp to the previous month's last day.
  if (start.getUTCMonth() === end.getUTCMonth()) start.setUTCDate(0);
  const ms = end.getTime() - start.getTime();
  return ms > 0 ? ms : DEFAULT_MONTH_MS;
}

interface WindowSpec {
  /** Key under `usage` in the payload. */
  readonly key: "rolling" | "weekly" | "monthly";
  readonly windowId: string;
  readonly label: string;
  readonly durationMs: (resetsAt: number | null) => number;
}

const WINDOWS: readonly WindowSpec[] = [
  { key: "rolling", windowId: "5h", label: "5 Hour", durationMs: () => 5 * HOUR_MS },
  { key: "weekly", windowId: "7d", label: "Weekly", durationMs: () => WEEK_MS },
  { key: "monthly", windowId: "30d", label: "Monthly", durationMs: monthlyWindowMs },
];

/** ISO string or epoch (seconds/ms) → epoch-ms, else null. */
function parseResetsAt(value: unknown): number | null {
  const iso = parseIsoTimestamp(value);
  if (iso !== undefined) return iso;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return epochToMs(value);
}

function parseWindow(spec: WindowSpec, raw: unknown): AccountUsageLimit | null {
  if (!isRecord(raw)) return null;
  const percent = toNumber(raw.percent);
  if (percent === undefined) return null;
  const amount = percentAmount(percent);
  const resetsAt = parseResetsAt(raw.resetsAt);
  const limited = raw.status === "rate-limited";
  return {
    id: `opencode:${spec.windowId}`,
    label: spec.label,
    kind: "window",
    windowId: spec.windowId,
    shared: true,
    tier: null,
    durationMs: spec.durationMs(resetsAt),
    resetsAt,
    ...amount,
    status: limited ? "exhausted" : usageStatus(amount.usedFraction),
  };
}

/**
 * Parse the `GET <base>/usage` body into the provider-agnostic report body, or
 * null when it carries no recognizable allowance window.
 */
export function parseOpenCodeUsagePayload(raw: unknown): ProviderUsage | null {
  if (!isRecord(raw) || !isRecord(raw.usage)) return null;
  const usage = raw.usage;
  const limits: AccountUsageLimit[] = [];
  for (const spec of WINDOWS) {
    const limit = parseWindow(spec, usage[spec.key]);
    if (limit !== null) limits.push(limit);
  }
  if (limits.length === 0) return null;
  // A rate-limited window means Go refuses requests until that window resets.
  const limitReached = limits.some((l) => l.status === "exhausted");
  return {
    account: { accountId: null, email: null, planType: null },
    limits,
    limitReached,
    canServe: !limitReached,
    creditOverage: false,
    credits: null,
  };
}

/**
 * The machine-readable error code of an OpenCode error body
 * (`{ "error": { "code": "api_key_expired", … } }`), or null. Only a short
 * identifier-shaped code is returned, so nothing free-form (and nothing
 * secret) is ever echoed into a report.
 */
export function parseOpenCodeErrorCode(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.error)) return null;
  const code = nonEmptyString(raw.error.code);
  return code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
}
