import type { AccountUsageLimit, AccountUsageReport } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import {
  classifyReport,
  DATE_HEADER,
  FLOATING_MARGIN_MS,
  isFloatingIdle,
  KICK_BACKOFF_MS,
  kickBackoffMs,
  MAX_KICK_BACKOFF_MS,
  parseClockOffset,
  REPORT_MAX_AGE_MS,
  RUNNING_MARGIN_MS,
  windowIsRunning,
} from "./core.js";

const NOW = 1_760_000_000_000;
const FIVE_HOURS = 5 * 3_600_000;

function limit(overrides: Partial<AccountUsageLimit> & { id: string }): AccountUsageLimit {
  const { id, ...rest } = overrides;
  return {
    id,
    label: id,
    kind: "window",
    windowId: "5h",
    shared: true,
    tier: null,
    durationMs: null,
    resetsAt: null,
    unit: "percent",
    used: 0,
    limit: 100,
    remaining: 100,
    usedFraction: 0,
    remainingFraction: 1,
    status: "ok",
    ...rest,
  };
}

function report(overrides: Partial<AccountUsageReport> = {}): AccountUsageReport {
  return {
    provider: "claude",
    label: "Claude",
    state: "fresh",
    account: null,
    limits: [],
    limitReached: null,
    canServe: null,
    creditOverage: false,
    credits: null,
    fetchedAt: NOW - 1_000,
    lastAttemptAt: NOW - 1_000,
    nextRefreshAt: NOW + 1_000,
    error: null,
    ...overrides,
  };
}

describe("parseClockOffset", () => {
  it("is the Date header minus the local clock", () => {
    const server = Date.parse("Thu, 13 Nov 2026 00:00:00 GMT");
    const headers = { [DATE_HEADER]: new Date(server).toUTCString() };
    expect(parseClockOffset(headers, server)).toBe(0);
    expect(parseClockOffset(headers, server - 90_000)).toBe(90_000);
    expect(parseClockOffset(headers, server + 90_000)).toBe(-90_000);
  });

  it("returns null when the header is absent or unparseable", () => {
    expect(parseClockOffset({}, NOW)).toBeNull();
    expect(parseClockOffset({ [DATE_HEADER]: "not a date" }, NOW)).toBeNull();
  });
});

describe("isFloatingIdle", () => {
  it("is true for zero use with no reset at all", () => {
    expect(isFloatingIdle(limit({ id: "claude:5h" }), NOW)).toBe(true);
  });

  it("is true for zero use with a reset a full duration away (inclusive boundary)", () => {
    const full = limit({ id: "claude:5h", durationMs: FIVE_HOURS, resetsAt: NOW + FIVE_HOURS });
    expect(isFloatingIdle(full, NOW)).toBe(true);
    const boundary = limit({
      id: "claude:5h",
      durationMs: FIVE_HOURS,
      resetsAt: NOW + FIVE_HOURS - FLOATING_MARGIN_MS,
    });
    expect(isFloatingIdle(boundary, NOW)).toBe(true);
  });

  it("is false once the reset is more than the margin inside the window", () => {
    const inside = limit({
      id: "claude:5h",
      durationMs: FIVE_HOURS,
      resetsAt: NOW + FIVE_HOURS - FLOATING_MARGIN_MS - 1,
    });
    expect(isFloatingIdle(inside, NOW)).toBe(false);
  });

  it("is false for zero use with a reset but an unknown duration", () => {
    expect(isFloatingIdle(limit({ id: "claude:5h", resetsAt: NOW + FIVE_HOURS }), NOW)).toBe(false);
  });

  it("is false for any use, and for a null usage fraction", () => {
    expect(
      isFloatingIdle(
        limit({ id: "claude:5h", usedFraction: 0.1, resetsAt: NOW + FIVE_HOURS }),
        NOW,
      ),
    ).toBe(false);
    expect(isFloatingIdle(limit({ id: "claude:5h", usedFraction: null }), NOW)).toBe(false);
  });
});

describe("classifyReport", () => {
  it("is unknown without a fresh, recent report", () => {
    expect(classifyReport(null, "claude:5h", NOW, NOW)).toEqual({ kind: "unknown" });
    for (const state of ["stale", "unavailable", "unsupported", "not-configured"] as const) {
      expect(classifyReport(report({ state }), "claude:5h", NOW, NOW)).toEqual({
        kind: "unknown",
      });
    }
    expect(classifyReport(report({ fetchedAt: null }), "claude:5h", NOW, NOW)).toEqual({
      kind: "unknown",
    });
    expect(
      classifyReport(report({ fetchedAt: NOW - REPORT_MAX_AGE_MS - 1 }), "claude:5h", NOW, NOW),
    ).toEqual({ kind: "unknown" });
  });

  it("accepts a report at exactly the max age", () => {
    const r = report({
      fetchedAt: NOW - REPORT_MAX_AGE_MS,
      limits: [limit({ id: "claude:5h", resetsAt: NOW + 1_000 })],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({
      kind: "running",
      resetsAt: NOW + 1_000,
    });
  });

  it("reports running when the watched row resets in the future", () => {
    const r = report({ limits: [limit({ id: "claude:5h", resetsAt: NOW + 1_000 })] });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({
      kind: "running",
      resetsAt: NOW + 1_000,
    });
  });

  it("treats a floating-idle row (zero use, reset a full duration away) as idle, not running", () => {
    const r = report({
      limits: [
        limit({
          id: "claude:5h",
          usedFraction: 0,
          durationMs: FIVE_HOURS,
          resetsAt: NOW + FIVE_HOURS,
        }),
      ],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({ kind: "idle" });
  });

  it("treats the same row as running once it has usage", () => {
    const r = report({
      limits: [
        limit({
          id: "claude:5h",
          usedFraction: 0.2,
          used: 20,
          durationMs: FIVE_HOURS,
          resetsAt: NOW + FIVE_HOURS,
        }),
      ],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({
      kind: "running",
      resetsAt: NOW + FIVE_HOURS,
    });
  });

  it("treats zero use with a reset well inside the window as running", () => {
    const r = report({
      limits: [
        limit({
          id: "claude:5h",
          usedFraction: 0,
          durationMs: FIVE_HOURS,
          resetsAt: NOW + 3_600_000,
        }),
      ],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({
      kind: "running",
      resetsAt: NOW + 3_600_000,
    });
  });

  it("a running watched row wins over exhausted rows (classification order)", () => {
    const r = report({
      limits: [
        limit({ id: "claude:5h", resetsAt: NOW + 10_000 }),
        limit({ id: "claude:7d", resetsAt: NOW + 5_000, status: "exhausted" }),
      ],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({
      kind: "running",
      resetsAt: NOW + 10_000,
    });
  });

  it("is blocked (with the latest reset) when the watched row is idle and another is exhausted", () => {
    const r = report({
      limits: [
        limit({
          id: "claude:5h",
          usedFraction: 0,
          durationMs: FIVE_HOURS,
          resetsAt: NOW + FIVE_HOURS,
        }),
        limit({ id: "claude:7d", resetsAt: NOW + 5_000, status: "exhausted" }),
        limit({ id: "claude:7d:opus", resetsAt: NOW + 9_000, status: "exhausted" }),
      ],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({
      kind: "blocked",
      until: NOW + 9_000,
    });
  });

  it("ignores exhausted rows without a future reset", () => {
    const r = report({
      limits: [
        limit({ id: "claude:5h" }),
        limit({ id: "claude:7d", resetsAt: NOW, status: "exhausted" }),
        limit({ id: "claude:7d:opus", resetsAt: null, status: "exhausted" }),
      ],
    });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({ kind: "idle" });
  });

  it("reports idle for a present watched row with no reset and zero usage", () => {
    const r = report({ limits: [limit({ id: "claude:5h" })] });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({ kind: "idle" });
  });

  it("is unknown when the watched row carries usage but no future reset", () => {
    const used = report({ limits: [limit({ id: "claude:5h", usedFraction: 0.5 })] });
    expect(classifyReport(used, "claude:5h", NOW, NOW)).toEqual({ kind: "unknown" });
    const atNow = report({ limits: [limit({ id: "claude:5h", resetsAt: NOW })] });
    expect(classifyReport(atNow, "claude:5h", NOW, NOW)).toEqual({ kind: "unknown" });
  });

  it("is unknown when the watched row is absent", () => {
    const r = report({ limits: [limit({ id: "claude:7d", resetsAt: NOW + 1_000 })] });
    expect(classifyReport(r, "claude:5h", NOW, NOW)).toEqual({ kind: "unknown" });
  });

  it("uses the supplied limitId, not a hard-coded one", () => {
    const r = report({
      limits: [
        limit({ id: "claude:5h", resetsAt: NOW + 1_000 }),
        limit({ id: "codex:primary", resetsAt: NOW + 2_000 }),
      ],
    });
    expect(classifyReport(r, "codex:primary", NOW, NOW)).toEqual({
      kind: "running",
      resetsAt: NOW + 2_000,
    });
  });

  it("classifies against server time, not local time, for the freshness window", () => {
    // The report was fetched 1 s ago on the local clock; server time is
    // local + 90 s, so the report is still fresh by the local age check.
    const r = report({ limits: [limit({ id: "claude:5h" })] });
    expect(classifyReport(r, "claude:5h", NOW + 90_000, NOW)).toEqual({ kind: "idle" });
  });
});

describe("windowIsRunning", () => {
  it("requires a reset strictly beyond now + margin", () => {
    expect(windowIsRunning(null, NOW)).toBe(false);
    expect(windowIsRunning(NOW + RUNNING_MARGIN_MS, NOW)).toBe(false);
    expect(windowIsRunning(NOW + RUNNING_MARGIN_MS + 1, NOW)).toBe(true);
    expect(windowIsRunning(NOW - 1, NOW)).toBe(false);
  });
});

describe("kickBackoffMs", () => {
  it("backs off 10, 20, 40, 80 … minutes from the first failure", () => {
    expect(kickBackoffMs(0)).toBe(KICK_BACKOFF_MS);
    expect(kickBackoffMs(1)).toBe(KICK_BACKOFF_MS);
    expect(kickBackoffMs(2)).toBe(2 * KICK_BACKOFF_MS);
    expect(kickBackoffMs(3)).toBe(4 * KICK_BACKOFF_MS);
    expect(kickBackoffMs(4)).toBe(8 * KICK_BACKOFF_MS);
  });

  it("caps at six hours", () => {
    expect(kickBackoffMs(7)).toBe(MAX_KICK_BACKOFF_MS);
    expect(kickBackoffMs(100)).toBe(MAX_KICK_BACKOFF_MS);
  });
});
