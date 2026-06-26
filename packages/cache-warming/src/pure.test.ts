import { describe, expect, it } from "vitest";
import type { ConversationState } from "./pure.js";
import {
  buildConversationSpec,
  buildDefaultSpec,
  computeCachePct,
  computeExpectedCacheRate,
  isTokenCurrent,
  MIN_INTERVAL_MS,
  msToSeconds,
  parseIntervalPayload,
  parseSettings,
  secondsToMs,
  serializeSettings,
  shouldWarm,
} from "./pure.js";

describe("computeCachePct", () => {
  it("cacheRead/input rounded and clamped to 0..100", () => {
    expect(computeCachePct(1000, 800)).toBe(80);
    expect(computeCachePct(1000, 1200)).toBe(100);
    expect(computeCachePct(1000, -100)).toBe(0);
    expect(computeCachePct(1000, 0)).toBe(0);
    expect(computeCachePct(1000, 333)).toBe(33);
  });

  it("zero input tokens → 0", () => {
    expect(computeCachePct(0, 500)).toBe(0);
    expect(computeCachePct(-1, 500)).toBe(0);
  });
});

describe("computeExpectedCacheRate", () => {
  it("cacheRead/(cacheRead+cacheWrite) rounded", () => {
    expect(computeExpectedCacheRate(800, 200)).toBe(80);
    expect(computeExpectedCacheRate(500, 500)).toBe(50);
    expect(computeExpectedCacheRate(1000, 0)).toBe(100);
    expect(computeExpectedCacheRate(0, 1000)).toBe(0);
    expect(computeExpectedCacheRate(333, 667)).toBe(33);
  });

  it("0 when cacheRead+cacheWrite is 0", () => {
    expect(computeExpectedCacheRate(0, 0)).toBe(0);
  });
});

describe("shouldWarm", () => {
  it("returns true when enabled, idle, and token matches", () => {
    const state: ConversationState = {
      enabled: true,
      intervalMs: 240_000,
      active: false,
      lastPct: null,
      lastExpectedPct: null,
      lastWarmAt: null,
      nextWarmAt: null,
      token: 5,
    };
    expect(shouldWarm(state, 5)).toBe(true);
  });

  it("returns false when disabled", () => {
    const state: ConversationState = {
      enabled: false,
      intervalMs: 240_000,
      active: false,
      lastPct: null,
      lastExpectedPct: null,
      lastWarmAt: null,
      nextWarmAt: null,
      token: 5,
    };
    expect(shouldWarm(state, 5)).toBe(false);
  });

  it("returns false when active", () => {
    const state: ConversationState = {
      enabled: true,
      intervalMs: 240_000,
      active: true,
      lastPct: null,
      lastExpectedPct: null,
      lastWarmAt: null,
      nextWarmAt: null,
      token: 5,
    };
    expect(shouldWarm(state, 5)).toBe(false);
  });

  it("returns false when token is superseded", () => {
    const state: ConversationState = {
      enabled: true,
      intervalMs: 240_000,
      active: false,
      lastPct: null,
      lastExpectedPct: null,
      lastWarmAt: null,
      nextWarmAt: null,
      token: 5,
    };
    expect(shouldWarm(state, 6)).toBe(false);
  });
});

describe("isTokenCurrent", () => {
  it("returns true when tokens match", () => {
    expect(isTokenCurrent(5, 5)).toBe(true);
  });

  it("returns false when tokens differ", () => {
    expect(isTokenCurrent(5, 6)).toBe(false);
  });
});

describe("parseSettings/serializeSettings round-trip", () => {
  it("round-trips enabled + intervalMs", () => {
    const original = { enabled: false, intervalMs: 120_000 };
    const serialized = serializeSettings(original);
    const parsed = parseSettings(serialized);
    expect(parsed).toEqual(original);
  });

  it("returns defaults for null input (warming OFF by default — CR-4a)", () => {
    const parsed = parseSettings(null);
    expect(parsed).toEqual({ enabled: false, intervalMs: 240_000 });
  });

  it("returns defaults for malformed JSON (warming OFF by default — CR-4a)", () => {
    const parsed = parseSettings("not-json{{{");
    expect(parsed).toEqual({ enabled: false, intervalMs: 240_000 });
  });

  it("clamps non-positive interval to MIN_INTERVAL_MS", () => {
    const parsed = parseSettings(JSON.stringify({ enabled: true, intervalMs: -500 }));
    expect(parsed.intervalMs).toBe(1000);
  });

  it("uses default for NaN interval", () => {
    const parsed = parseSettings(JSON.stringify({ enabled: true, intervalMs: Number.NaN }));
    expect(parsed.intervalMs).toBe(240_000);
  });
});

describe("msToSeconds", () => {
  it("converts ms to seconds, rounded", () => {
    expect(msToSeconds(240_000)).toBe(240);
    expect(msToSeconds(1500)).toBe(2);
    expect(msToSeconds(1000)).toBe(1);
    expect(msToSeconds(0)).toBe(0);
  });
});

describe("secondsToMs", () => {
  it("converts seconds to ms, floors at MIN_INTERVAL_MS", () => {
    expect(secondsToMs(240)).toBe(240_000);
    expect(secondsToMs(1)).toBe(1000);
    expect(secondsToMs(0.5)).toBe(MIN_INTERVAL_MS);
  });

  it("returns null for NaN / non-positive", () => {
    expect(secondsToMs(Number.NaN)).toBeNull();
    expect(secondsToMs(0)).toBeNull();
    expect(secondsToMs(-5)).toBeNull();
    expect(secondsToMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseIntervalPayload", () => {
  it("accepts a bare positive number", () => {
    expect(parseIntervalPayload(30)).toBe(30);
    expect(parseIntervalPayload(1)).toBe(1);
  });

  it("accepts { value: number }", () => {
    expect(parseIntervalPayload({ value: 30 })).toBe(30);
    expect(parseIntervalPayload({ value: 1 })).toBe(1);
  });

  it("returns null for NaN / non-positive / wrong shape", () => {
    expect(parseIntervalPayload(Number.NaN)).toBeNull();
    expect(parseIntervalPayload(0)).toBeNull();
    expect(parseIntervalPayload(-5)).toBeNull();
    expect(parseIntervalPayload("30")).toBeNull();
    expect(parseIntervalPayload({ value: "30" })).toBeNull();
    expect(parseIntervalPayload({})).toBeNull();
    expect(parseIntervalPayload(null)).toBeNull();
    expect(parseIntervalPayload(undefined)).toBeNull();
  });
});

describe("buildConversationSpec", () => {
  it("builds a per-conversation spec with toggle + number(interval) + last-% + retention + timer fields", () => {
    const spec = buildConversationSpec(true, 240_000, 80, 95, 1000, 500);
    expect(spec.id).toBe("cache-warming");
    expect(spec.region).toBe("side");
    expect(spec.title).toBe("Cache Warming");
    expect(spec.fields).toHaveLength(5);

    const toggle = spec.fields[0];
    expect(toggle).toEqual({
      kind: "toggle",
      label: "Enabled",
      value: true,
      action: { actionId: "cache-warming/toggle" },
    });

    const number = spec.fields[1];
    expect(number).toEqual({
      kind: "number",
      label: "Refresh Interval",
      value: 240,
      min: 1,
      step: 1,
      unit: "s",
      action: { actionId: "cache-warming/set-interval" },
    });

    const stat = spec.fields[2];
    expect(stat).toEqual({
      kind: "stat",
      label: "Last Cache %",
      value: "80%",
    });

    const retention = spec.fields[3];
    expect(retention).toEqual({
      kind: "stat",
      label: "Cache retention",
      value: "95%",
    });

    const timer = spec.fields[4];
    expect(timer).toEqual({
      kind: "custom",
      rendererId: "cache-warming-timer",
      payload: { nextWarmAt: 1000, lastWarmAt: 500 },
    });
  });

  it("shows — when lastPct and lastExpectedPct are null", () => {
    const spec = buildConversationSpec(true, 240_000, null, null, null, null);
    const stat = spec.fields[2];
    expect(stat).toEqual({
      kind: "stat",
      label: "Last Cache %",
      value: "—",
    });
    const retention = spec.fields[3];
    expect(retention).toEqual({
      kind: "stat",
      label: "Cache retention",
      value: "—",
    });
    const timer = spec.fields[4];
    expect(timer).toEqual({
      kind: "custom",
      rendererId: "cache-warming-timer",
      payload: { nextWarmAt: null, lastWarmAt: null },
    });
  });

  it("reflects disabled state", () => {
    const spec = buildConversationSpec(false, 120_000, 50, 75, null, null);
    const toggle = spec.fields[0];
    expect(toggle).toEqual({
      kind: "toggle",
      label: "Enabled",
      value: false,
      action: { actionId: "cache-warming/toggle" },
    });
    const number = spec.fields[1];
    expect(number).toEqual({
      kind: "number",
      label: "Refresh Interval",
      value: 120,
      min: 1,
      step: 1,
      unit: "s",
      action: { actionId: "cache-warming/set-interval" },
    });
  });
});

describe("buildDefaultSpec", () => {
  it("returns a default spec with no conversationId", () => {
    const spec = buildDefaultSpec();
    expect(spec.id).toBe("cache-warming");
    expect(spec.region).toBe("side");
    expect(spec.title).toBe("Cache Warming");
    expect(spec.fields).toHaveLength(1);
    expect(spec.fields[0]).toEqual({
      kind: "stat",
      label: "Status",
      value: "No conversation focused",
    });
  });
});
