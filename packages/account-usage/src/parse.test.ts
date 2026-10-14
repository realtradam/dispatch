import { describe, expect, it } from "vitest";
import {
  claudeOAuthBaseUrls,
  isClaudeOAuthToken,
  parseClaudeProfile,
  parseClaudeRateLimitHeaders,
  parseClaudeUsagePayload,
} from "./claude.js";
import {
  extractCodexIdentity,
  normalizeCodexAccountBase,
  parseCodexRateLimitHeaders,
  parseCodexUsagePayload,
} from "./codex.js";
import { mergeLimits, WEEK_MS } from "./shared.js";

const NOW = 1_760_000_000_000;

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

describe("claude usage payload", () => {
  it("parses legacy buckets as percentages with ISO resets", () => {
    const u = parseClaudeUsagePayload({
      five_hour: { utilization: 42, resets_at: "2026-10-14T20:00:00Z" },
      seven_day: { utilization: 12.5, resets_at: "2026-10-18T00:00:00Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 3, resets_at: null },
    });
    expect(u?.limits.map((l) => l.id)).toEqual(["claude:5h", "claude:7d", "claude:7d:sonnet"]);
    const five = u?.limits[0];
    expect(five).toMatchObject({
      used: 42,
      limit: 100,
      remaining: 58,
      usedFraction: 0.42,
      unit: "percent",
      shared: true,
      durationMs: 5 * 3_600_000,
      resetsAt: Date.parse("2026-10-14T20:00:00Z"),
      status: "ok",
    });
    expect(u?.limits[2]).toMatchObject({ shared: false, tier: "sonnet", resetsAt: null });
  });

  it("falls back to generic limits[] and keeps inactive-but-valid rows", () => {
    const u = parseClaudeUsagePayload({
      five_hour: null,
      seven_day: null,
      seven_day_opus: null,
      limits: [
        { kind: "session", percent: 10, resets_at: "2026-10-14T20:00:00Z", is_active: false },
        { kind: "weekly_all", percent: 77, resets_at: "2026-10-18T00:00:00Z", is_active: false },
        {
          kind: "weekly_scoped",
          percent: 100,
          resets_at: "2026-10-18T00:00:00Z",
          scope: { model: { display_name: "Fable" } },
          is_active: true,
        },
        { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Opus 5" } } },
      ],
    });
    expect(u?.limits.map((l) => l.id)).toEqual([
      "claude:5h",
      "claude:7d",
      "claude:7d:fable",
      "claude:7d:opus-5",
    ]);
    expect(u?.limits[1]?.used).toBe(77);
    expect(u?.limits[2]).toMatchObject({ status: "exhausted", tier: "fable", shared: false });
    expect(u?.limits[3]).toMatchObject({ label: "7 Day (Opus 5)", durationMs: WEEK_MS });
  });

  it("missing/null fields produce no rows rather than zeros", () => {
    const u = parseClaudeUsagePayload({ five_hour: { resets_at: "2026-10-14T20:00:00Z" } });
    expect(u?.limits).toEqual([]);
    expect(parseClaudeUsagePayload("nope")).toBeNull();
  });

  it("parses spend extra usage; unlimited cap is limit:null not $0", () => {
    const capped = parseClaudeUsagePayload({
      spend: {
        enabled: true,
        used: { amount_minor: 1250, exponent: 2, currency: "USD" },
        limit: { amount_minor: 5000, exponent: 2, currency: "USD" },
      },
    });
    expect(capped?.limits[0]).toMatchObject({
      id: "claude:extra",
      kind: "spend",
      unit: "usd",
      used: 12.5,
      limit: 50,
      remaining: 37.5,
      usedFraction: 0.25,
    });
    const unlimited = parseClaudeUsagePayload({
      spend: {
        enabled: true,
        used: { amount_minor: 300, exponent: 2, currency: "USD" },
        limit: null,
      },
    });
    expect(unlimited?.limits[0]).toMatchObject({ used: 3, limit: null, usedFraction: null });
    const legacy = parseClaudeUsagePayload({
      extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500 },
    });
    expect(legacy?.limits[0]).toMatchObject({ used: 5, limit: 20 });
    const eur = parseClaudeUsagePayload({
      spend: {
        enabled: true,
        used: { amount_minor: 1, exponent: 2, currency: "EUR" },
        limit: null,
      },
    });
    expect(eur?.limits).toEqual([]);
  });

  it("header utilization is a FRACTION and reset is unix seconds", () => {
    const limits = parseClaudeRateLimitHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1760003600",
      "anthropic-ratelimit-unified-7d-utilization": "1",
    });
    expect(limits[0]).toMatchObject({ id: "claude:5h", used: 42, resetsAt: 1_760_003_600_000 });
    expect(limits[1]).toMatchObject({ id: "claude:7d", used: 100, status: "exhausted" });
  });

  it("recognizes oauth-shaped API keys and normalizes base URLs", () => {
    expect(isClaudeOAuthToken("sk-ant-oat01-abc")).toBe(true);
    expect(isClaudeOAuthToken("sk-ant-api03-abc")).toBe(false);
    expect(claudeOAuthBaseUrls("https://api.anthropic.com/v1")).toEqual([
      "https://api.anthropic.com/api/oauth",
    ]);
    expect(claudeOAuthBaseUrls("https://proxy.example/x/v1")).toEqual([
      "https://proxy.example/x/api/oauth",
      "https://api.anthropic.com/api/oauth",
    ]);
  });

  it("parses profile identity", () => {
    expect(parseClaudeProfile({ account: { uuid: "u1", email: "a@b.c" } })).toEqual({
      accountId: "u1",
      email: "a@b.c",
    });
  });
});

describe("codex usage payload", () => {
  const base = {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_760_010_000 },
      secondary_window: {
        used_percent: 55,
        limit_window_seconds: 604_800,
        reset_after_seconds: 3600,
      },
    },
  };

  it("parses windows, durations, and both reset styles", () => {
    const u = parseCodexUsagePayload(base, NOW, { accountId: "acct", email: "e@x" });
    expect(u?.account).toEqual({ accountId: "acct", email: "e@x", planType: "pro" });
    expect(u?.limits[0]).toMatchObject({
      id: "codex:primary",
      label: "5 hours",
      windowId: "5h",
      durationMs: 18_000_000,
      resetsAt: 1_760_010_000_000,
      used: 30,
    });
    expect(u?.limits[1]).toMatchObject({
      label: "7 days",
      windowId: "7d",
      resetsAt: NOW + 3_600_000,
    });
    expect(u?.canServe).toBe(true);
  });

  it("accepts millisecond reset_at", () => {
    const u = parseCodexUsagePayload(
      { rate_limit: { primary_window: { used_percent: 1, reset_at: 1_760_010_000_000 } } },
      NOW,
    );
    expect(u?.limits[0]?.resetsAt).toBe(1_760_010_000_000);
    expect(u?.limits[0]?.durationMs).toBeNull();
  });

  it("credit-funded overage keeps 100% but stays servable", () => {
    const u = parseCodexUsagePayload(
      {
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
        },
        credits: {
          has_credits: true,
          unlimited: false,
          overage_limit_reached: false,
          balance: "12.5",
        },
        spend_control: { reached: false },
      },
      NOW,
    );
    expect(u?.creditOverage).toBe(true);
    expect(u?.limitReached).toBe(true);
    expect(u?.canServe).toBe(true);
    expect(u?.limits[0]).toMatchObject({ used: 100, status: "warning" });
    expect(u?.credits).toMatchObject({ hasCredits: true, balance: 12.5 });
  });

  it("no overage when spend control reached", () => {
    const u = parseCodexUsagePayload(
      {
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: { used_percent: 100 },
        },
        credits: { has_credits: true },
        spend_control: { reached: true },
      },
      NOW,
    );
    expect(u?.creditOverage).toBe(false);
    expect(u?.canServe).toBe(false);
    expect(u?.limits[0]?.status).toBe("exhausted");
  });

  it("additional meters are independent of plan credits", () => {
    const u = parseCodexUsagePayload(
      {
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: { used_percent: 100 },
        },
        credits: { unlimited: true },
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            metered_feature: "codex_bengalfox",
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
            },
          },
        ],
      },
      NOW,
    );
    expect(u?.limits[0]?.status).toBe("warning");
    const spark = u?.limits.find((l) => l.id === "codex:spark:primary");
    expect(spark).toMatchObject({ tier: "spark", status: "exhausted", label: "Spark · 5 hours" });
  });

  it("returns null when no rate limit data", () => {
    expect(parseCodexUsagePayload({ plan_type: "pro" }, NOW)).toBeNull();
  });

  it("parses headers (percent, minutes, unix seconds)", () => {
    const l = parseCodexRateLimitHeaders(
      {
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1760010000",
      },
      NOW,
    );
    expect(l[0]).toMatchObject({ used: 12, durationMs: 18_000_000, resetsAt: 1_760_010_000_000 });
  });

  it("extracts identity from the JWT and normalizes account base", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
      "https://api.openai.com/profile": { email: "Me@X.com" },
    });
    expect(extractCodexIdentity(token)).toEqual({ accountId: "acc-1", email: "me@x.com" });
    expect(extractCodexIdentity("garbage")).toEqual({});
    expect(normalizeCodexAccountBase("https://chatgpt.com/backend-api/codex/responses")).toBe(
      "https://chatgpt.com/backend-api",
    );
    expect(normalizeCodexAccountBase("https://proxy.example/v1")).toBe(
      "https://chatgpt.com/backend-api",
    );
  });
});

describe("mergeLimits", () => {
  it("replaces by id and keeps endpoint-only rows", () => {
    const a = parseClaudeUsagePayload({
      five_hour: { utilization: 10 },
      spend: {
        enabled: true,
        used: { amount_minor: 1, exponent: 2, currency: "USD" },
        limit: null,
      },
    });
    const merged = mergeLimits(
      a?.limits ?? [],
      parseClaudeRateLimitHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
      }),
    );
    expect(merged.map((l) => [l.id, l.used])).toEqual([
      ["claude:5h", 50],
      ["claude:extra", 0.01],
    ]);
  });
});
