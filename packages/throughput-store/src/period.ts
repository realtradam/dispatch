/**
 * Pure period math for throughput aggregation.
 *
 * All boundaries are computed in the SERVER'S LOCAL timezone (a single-operator
 * self-hosted assumption):
 *   - day:   `YYYY-MM-DD` → [local midnight, next local midnight)
 *   - week:  `YYYY-MM-DD` → the ISO week (Mon–Sun) CONTAINING that date
 *   - month: `YYYY-MM`    → [first of month, first of next month)
 *
 * A resolved period yields the half-open `[start, end)` epoch-ms range plus the
 * list of local `YYYY-MM-DD` day keys it spans (used to address the per-day
 * sample buckets in storage).
 */

export type Period = "day" | "week" | "month";

export interface ResolvedPeriod {
  readonly ok: true;
  /** Inclusive start, epoch-ms (local midnight). */
  readonly start: number;
  /** Exclusive end, epoch-ms (local midnight). */
  readonly end: number;
  /** Local `YYYY-MM-DD` day keys this period spans, in order. */
  readonly dayKeys: readonly string[];
  /** The normalized input date string. */
  readonly date: string;
}

export interface PeriodError {
  readonly ok: false;
  readonly error: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local `YYYY-MM-DD` key for an epoch-ms timestamp. */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local `YYYY-MM-DD` key for a local calendar date. */
function dayKey(year: number, monthIndex: number, day: number): string {
  const d = new Date(year, monthIndex, day);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(date: string): { y: number; m: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible dates (e.g. 2026-02-30) by round-tripping through Date.
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function parseYm(date: string): { y: number; m: number } | null {
  if (!/^\d{4}-\d{2}$/.test(date)) return null;
  const [y, m] = date.split("-").map(Number) as [number, number];
  if (m < 1 || m > 12) return null;
  return { y, m };
}

/**
 * Resolve a `(period, date)` pair into a concrete `[start, end)` range + the day
 * keys it covers. Returns a `PeriodError` for malformed input.
 */
export function resolvePeriod(period: Period, date: string): ResolvedPeriod | PeriodError {
  if (period === "day") {
    const p = parseYmd(date);
    if (!p) return { ok: false, error: `invalid day date "${date}" (expected YYYY-MM-DD)` };
    const start = new Date(p.y, p.m - 1, p.d).getTime();
    const end = new Date(p.y, p.m - 1, p.d + 1).getTime();
    return { ok: true, start, end, dayKeys: [dayKey(p.y, p.m - 1, p.d)], date };
  }

  if (period === "week") {
    const p = parseYmd(date);
    if (!p) return { ok: false, error: `invalid week date "${date}" (expected YYYY-MM-DD)` };
    // ISO week: Monday-based. JS getDay() is 0=Sun..6=Sat.
    const base = new Date(p.y, p.m - 1, p.d);
    const offset = (base.getDay() + 6) % 7; // days since Monday
    const monStart = new Date(p.y, p.m - 1, p.d - offset);
    const start = monStart.getTime();
    const end = new Date(
      monStart.getFullYear(),
      monStart.getMonth(),
      monStart.getDate() + 7,
    ).getTime();
    const dayKeys: string[] = [];
    for (let i = 0; i < 7; i++) {
      dayKeys.push(dayKey(monStart.getFullYear(), monStart.getMonth(), monStart.getDate() + i));
    }
    return { ok: true, start, end, dayKeys, date };
  }

  // month
  const p = parseYm(date);
  if (!p) return { ok: false, error: `invalid month date "${date}" (expected YYYY-MM)` };
  const start = new Date(p.y, p.m - 1, 1).getTime();
  const end = new Date(p.y, p.m, 1).getTime();
  const lastDay = new Date(p.y, p.m, 0).getDate();
  const dayKeys: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    dayKeys.push(dayKey(p.y, p.m - 1, d));
  }
  return { ok: true, start, end, dayKeys, date };
}
