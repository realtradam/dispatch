import type { Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createHyperFetcher, type FetchFn } from "./fetchers.js";
import {
  applySettingsPatch,
  buildDailyCredits,
  DEFAULT_DAILY_CREDITS_SETTINGS,
  isRefill,
  nextDailyReset,
  parseDailyCreditsSettings,
  parseHyperCredits,
} from "./hyper.js";
import { createAccountUsageService, SUCCESS_TTL_MS } from "./service.js";
import { DAY_MS, HOUR_MS } from "./shared.js";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  span() {
    throw new Error("unused");
  },
};

describe("hyper pure logic", () => {
  it("parses the live { balance } shape", () => {
    expect(parseHyperCredits({ balance: 250 })).toBe(250);
    expect(parseHyperCredits({ balance: "12.5" })).toBe(12.5);
    expect(parseHyperCredits({})).toBeNull();
    expect(parseHyperCredits("x")).toBeNull();
  });

  it("next daily reset recurs every 24h from any anchor (past or future)", () => {
    const anchor = Date.UTC(2026, 0, 1, 9, 0); // 09:00 UTC
    const now = Date.UTC(2026, 9, 14, 15, 30);
    expect(nextDailyReset(anchor, now)).toBe(Date.UTC(2026, 9, 15, 9, 0));
    expect(nextDailyReset(anchor, Date.UTC(2026, 9, 14, 8, 0))).toBe(Date.UTC(2026, 9, 14, 9, 0));
    // exactly at a reset → the NEXT one
    expect(nextDailyReset(anchor, Date.UTC(2026, 9, 14, 9, 0))).toBe(Date.UTC(2026, 9, 15, 9, 0));
    // future anchor
    expect(nextDailyReset(now + 3 * DAY_MS + HOUR_MS, now)).toBe(now + HOUR_MS);
  });

  it("builds a 250-credit daily limit (used = allowance − balance)", () => {
    const now = 1_000_000_000_000;
    const { detail, limit } = buildDailyCredits(
      100,
      { ...DEFAULT_DAILY_CREDITS_SETTINGS, manualAnchor: now - 6 * HOUR_MS },
      now,
    );
    expect(detail).toEqual({
      balance: 100,
      allowance: 250,
      resetAnchor: now - 6 * HOUR_MS,
      resetSource: "manual",
    });
    expect(limit).toMatchObject({
      id: "hyper:daily",
      unit: "credits",
      used: 150,
      limit: 250,
      remaining: 100,
      usedFraction: 0.6,
      durationMs: DAY_MS,
      resetsAt: now + 18 * HOUR_MS,
      status: "ok",
    });
  });

  it("clamps bundle balances above the allowance and flags empty balance", () => {
    const over = buildDailyCredits(400, DEFAULT_DAILY_CREDITS_SETTINGS, 0).limit;
    expect(over).toMatchObject({ used: 0, usedFraction: 0, resetsAt: null });
    expect(buildDailyCredits(0, DEFAULT_DAILY_CREDITS_SETTINGS, 0).limit.status).toBe("exhausted");
  });

  it("manual anchor wins over a detected one; source reported", () => {
    const s = { dailyAllowance: 250, manualAnchor: null, detectedAnchor: 42 };
    expect(buildDailyCredits(10, s, 100).detail.resetSource).toBe("detected");
    expect(buildDailyCredits(10, { ...s, manualAnchor: 7 }, 100).detail).toMatchObject({
      resetAnchor: 7,
      resetSource: "manual",
    });
  });

  it("refill detection: rise to ≥95% of the allowance", () => {
    expect(isRefill(40, 250, 250)).toBe(true);
    expect(isRefill(40, 120, 250)).toBe(false); // small bundle top-up
    expect(isRefill(250, 250, 250)).toBe(false); // no change
  });

  it("validates settings patches", () => {
    const base = DEFAULT_DAILY_CREDITS_SETTINGS;
    expect(applySettingsPatch(base, { dailyAllowance: 300, resetAnchor: 5 })).toEqual({
      ok: true,
      settings: { dailyAllowance: 300, manualAnchor: 5, detectedAnchor: null },
    });
    expect(applySettingsPatch({ ...base, manualAnchor: 5 }, { resetAnchor: null })).toMatchObject({
      ok: true,
      settings: { manualAnchor: null },
    });
    expect(applySettingsPatch(base, { dailyAllowance: 1.5 }).ok).toBe(false);
    expect(applySettingsPatch(base, { resetAnchor: "noon" }).ok).toBe(false);
    expect(applySettingsPatch(base, "x").ok).toBe(false);
  });

  it("parses stored settings tolerantly", () => {
    expect(parseDailyCreditsSettings(null)).toEqual(DEFAULT_DAILY_CREDITS_SETTINGS);
    expect(parseDailyCreditsSettings("garbage")).toEqual(DEFAULT_DAILY_CREDITS_SETTINGS);
    expect(parseDailyCreditsSettings('{"dailyAllowance":0,"manualAnchor":9}')).toEqual({
      dailyAllowance: 250,
      manualAnchor: 9,
      detectedAnchor: null,
    });
  });
});

describe("hyper fetcher", () => {
  it("GETs <base>/credits with the bearer key; not-configured without a key", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ balance: 250 }), { status: 200 });
    };
    const f = createHyperFetcher({
      fetchFn,
      resolveConfig: () => ({ apiKey: "sk-hyper-x", baseURL: "https://h.example/v1/" }),
      logger: noopLogger,
    });
    const r = await f();
    expect(r).toMatchObject({ ok: true, usage: { dailyBalance: 250, canServe: true } });
    expect(seen).toEqual([{ url: "https://h.example/v1/credits", auth: "Bearer sk-hyper-x" }]);
    const none = createHyperFetcher({ fetchFn, resolveConfig: () => null, logger: noopLogger });
    expect(await none()).toMatchObject({ ok: false, kind: "not-configured" });
  });
});

describe("hyper in the service", () => {
  function setup(balances: number[]) {
    let now = 1_000_000_000_000;
    let stored: string | null = null;
    const queue = [...balances];
    const svc = createAccountUsageService({
      fetchers: {
        claude: async () => ({ ok: false, kind: "not-configured", error: "" }),
        codex: async () => ({ ok: false, kind: "not-configured", error: "" }),
        hyper: async () => ({
          ok: true,
          usage: {
            account: { accountId: null, email: null, planType: null },
            limits: [],
            limitReached: null,
            canServe: true,
            creditOverage: false,
            credits: null,
            dailyBalance: queue.shift() ?? 0,
          },
        }),
      },
      now: () => now,
      random: () => 0.5,
      logger: noopLogger,
      settingsStore: {
        load: async () => stored,
        save: async (raw) => {
          stored = raw;
        },
      },
    });
    return {
      svc,
      advance: (ms: number) => {
        now += ms;
      },
      get now() {
        return now;
      },
      get stored() {
        return stored;
      },
    };
  }

  it("no reset time until set; a manual anchor persists and drives resetsAt", async () => {
    const h = setup([100, 100]);
    const r = await h.svc.get("hyper");
    expect(r.dailyCredits).toMatchObject({ balance: 100, allowance: 250, resetSource: null });
    expect(r.limits[0]?.resetsAt).toBeNull();
    const upd = await h.svc.updateSettings("hyper", { resetAnchor: h.now - 2 * HOUR_MS });
    expect(upd.ok).toBe(true);
    if (upd.ok) expect(upd.report.limits[0]?.resetsAt).toBe(h.now + 22 * HOUR_MS);
    expect(JSON.parse(h.stored ?? "{}")).toMatchObject({ manualAnchor: h.now - 2 * HOUR_MS });
  });

  it("detects a refill between polls and anchors at the midpoint", async () => {
    const h = setup([30, 250]);
    const t0 = h.now;
    await h.svc.get("hyper");
    h.advance(SUCCESS_TTL_MS);
    const r = await h.svc.get("hyper");
    expect(r.dailyCredits?.resetSource).toBe("detected");
    expect(r.dailyCredits?.resetAnchor).toBe(t0 + SUCCESS_TTL_MS / 2);
  });

  it("settings for other providers are rejected as not-found", async () => {
    const h = setup([1]);
    expect(await h.svc.updateSettings("claude", {})).toMatchObject({ ok: false, notFound: true });
  });
});
