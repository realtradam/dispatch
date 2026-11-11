import type { Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createOpenCodeFetcher, type FetchFn, type UsageFetcher } from "./fetchers.js";
import {
  monthlyWindowMs,
  OPENCODE_DEFAULT_BASE_URL,
  parseOpenCodeErrorCode,
  parseOpenCodeUsagePayload,
} from "./opencode.js";
import { createAccountUsageService } from "./service.js";
import { DAY_MS, HOUR_MS, WEEK_MS } from "./shared.js";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The shape OpenCode's own client reads from `GET /zen/go/v1/usage`. */
const meter = (status: string, percent: number, resetsAt: string) => ({
  status,
  percent,
  resetsAt,
});
const payload = {
  usage: {
    rolling: meter("ok", 42, "2026-11-11T17:00:00.000Z"),
    weekly: meter("ok", 18, "2026-11-16T00:00:00.000Z"),
    monthly: meter("ok", 95, "2026-12-01T00:00:00.000Z"),
  },
};

describe("opencode pure logic", () => {
  it("parses the three Go allowance windows into percent meters", () => {
    const usage = parseOpenCodeUsagePayload(payload);
    expect(usage?.limits.map((l) => [l.id, l.label, l.windowId, l.used, l.status])).toEqual([
      ["opencode:5h", "5 Hour", "5h", 42, "ok"],
      ["opencode:7d", "Weekly", "7d", 18, "ok"],
      ["opencode:30d", "Monthly", "30d", 95, "warning"],
    ]);
    expect(usage?.limits[0]).toEqual({
      id: "opencode:5h",
      label: "5 Hour",
      kind: "window",
      windowId: "5h",
      shared: true,
      tier: null,
      durationMs: 5 * HOUR_MS,
      resetsAt: Date.parse("2026-11-11T17:00:00.000Z"),
      unit: "percent",
      used: 42,
      limit: 100,
      remaining: 58,
      usedFraction: 0.42,
      remainingFraction: expect.closeTo(0.58, 10),
      status: "ok",
    });
    expect(usage?.limits[1]?.durationMs).toBe(WEEK_MS);
    // Nov 1 → Dec 1 is a 30-day window.
    expect(usage?.limits[2]?.durationMs).toBe(30 * DAY_MS);
    expect(usage?.limitReached).toBe(false);
    expect(usage?.canServe).toBe(true);
    expect(usage?.account).toEqual({ accountId: null, email: null, planType: null });
  });

  it("a rate-limited window is exhausted and blocks serving, whatever its percent", () => {
    const usage = parseOpenCodeUsagePayload({
      usage: {
        ...payload.usage,
        rolling: meter("rate-limited", 100, "2026-11-11T17:00:00.000Z"),
        weekly: meter("rate-limited", 97, "2026-11-16T00:00:00.000Z"),
      },
    });
    expect(usage?.limits.map((l) => l.status)).toEqual(["exhausted", "exhausted", "warning"]);
    expect(usage?.limitReached).toBe(true);
    expect(usage?.canServe).toBe(false);
  });

  it("clamps percent to 0..100 and derives status from it", () => {
    const usage = parseOpenCodeUsagePayload({
      usage: {
        rolling: meter("ok", 140, "2026-11-11T17:00:00.000Z"),
        weekly: meter("ok", -5, "2026-11-16T00:00:00.000Z"),
      },
    });
    expect(usage?.limits.map((l) => [l.used, l.status])).toEqual([
      [100, "exhausted"],
      [0, "ok"],
    ]);
  });

  it("skips missing/malformed windows instead of failing the report", () => {
    const usage = parseOpenCodeUsagePayload({
      usage: {
        rolling: meter("ok", 10, "2026-11-11T17:00:00.000Z"),
        weekly: { status: "ok" }, // no percent
        monthly: "nope",
      },
    });
    expect(usage?.limits.map((l) => l.id)).toEqual(["opencode:5h"]);
  });

  it("tolerates an unknown/absent reset instant (no pace marker, default month)", () => {
    const usage = parseOpenCodeUsagePayload({
      usage: { monthly: { status: "ok", percent: 5 }, weekly: meter("ok", 1, "garbage") },
    });
    expect(usage?.limits.map((l) => [l.id, l.resetsAt])).toEqual([
      ["opencode:7d", null],
      ["opencode:30d", null],
    ]);
    expect(usage?.limits[1]?.durationMs).toBe(30 * DAY_MS);
  });

  it("accepts an epoch reset instant (seconds or milliseconds)", () => {
    const ms = Date.parse("2026-11-11T17:00:00.000Z");
    const usage = parseOpenCodeUsagePayload({
      usage: {
        rolling: { status: "ok", percent: 1, resetsAt: ms / 1000 },
        weekly: { status: "ok", percent: 1, resetsAt: ms },
      },
    });
    expect(usage?.limits.map((l) => l.resetsAt)).toEqual([ms, ms]);
  });

  it("returns null when no allowance window is recognizable", () => {
    expect(parseOpenCodeUsagePayload(null)).toBeNull();
    expect(parseOpenCodeUsagePayload("x")).toBeNull();
    expect(parseOpenCodeUsagePayload({})).toBeNull();
    expect(parseOpenCodeUsagePayload({ usage: {} })).toBeNull();
    // The Umans-style concurrency shape is not an allowance report.
    expect(parseOpenCodeUsagePayload({ usage: { concurrent_sessions: 2 } })).toBeNull();
  });

  it("monthlyWindowMs spans back one calendar month from the reset", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(monthlyWindowMs(at("2026-12-01T00:00:00Z"))).toBe(30 * DAY_MS); // Nov has 30 days
    expect(monthlyWindowMs(at("2026-11-11T08:30:00Z"))).toBe(31 * DAY_MS); // from Oct 11
    expect(monthlyWindowMs(at("2026-03-15T00:00:00Z"))).toBe(28 * DAY_MS); // from Feb 15
    // Day-of-month the previous month lacks → clamps to its last day (Feb 28).
    expect(monthlyWindowMs(at("2026-03-31T00:00:00Z"))).toBe(31 * DAY_MS);
    // January → the previous December.
    expect(monthlyWindowMs(at("2027-01-11T00:00:00Z"))).toBe(31 * DAY_MS);
    expect(monthlyWindowMs(null)).toBe(30 * DAY_MS);
  });

  it("parseOpenCodeErrorCode returns only a short identifier-shaped code", () => {
    expect(
      parseOpenCodeErrorCode({
        error: { type: "authentication_error", code: "api_key_expired", message: "long text" },
      }),
    ).toBe("api_key_expired");
    expect(parseOpenCodeErrorCode({ error: { code: "has spaces and <html>" } })).toBeNull();
    expect(parseOpenCodeErrorCode({ error: { code: "x".repeat(65) } })).toBeNull();
    expect(parseOpenCodeErrorCode({ error: { message: "no code" } })).toBeNull();
    expect(parseOpenCodeErrorCode({ type: "error" })).toBeNull();
    expect(parseOpenCodeErrorCode(null)).toBeNull();
  });
});

function fetcher(
  response: () => Response | Promise<Response>,
  config: { apiKey: string; baseURL?: string } | null = { apiKey: "sk-opencode-x" },
): { run: UsageFetcher; seen: Array<{ url: string; auth: string | undefined }> } {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return response();
  };
  return {
    run: createOpenCodeFetcher({ fetchFn, resolveConfig: () => config, logger: noopLogger }),
    seen,
  };
}

describe("opencode fetcher", () => {
  it("GETs <base>/usage with the API key as a bearer and parses the windows", async () => {
    const f = fetcher(() => json(payload), {
      apiKey: "sk-opencode-x",
      baseURL: "https://oc.example/zen/go/v1/",
    });
    const r = await f.run();
    expect(f.seen).toEqual([
      { url: "https://oc.example/zen/go/v1/usage", auth: "Bearer sk-opencode-x" },
    ]);
    expect(r.ok && r.usage.limits.map((l) => l.id)).toEqual([
      "opencode:5h",
      "opencode:7d",
      "opencode:30d",
    ]);
  });

  it("defaults to the OpenCode Go base URL", async () => {
    const f = fetcher(() => json(payload));
    await f.run();
    expect(f.seen[0]?.url).toBe(`${OPENCODE_DEFAULT_BASE_URL}/usage`);
    expect(f.seen[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  it("is not-configured without a key (and makes no request)", async () => {
    const f = fetcher(() => json(payload), null);
    expect(await f.run()).toMatchObject({ ok: false, kind: "not-configured" });
    expect(f.seen).toEqual([]);
  });

  it("surfaces the upstream error code of a rejected key, never the key or message", async () => {
    const f = fetcher(() =>
      json(
        {
          error: {
            type: "authentication_error",
            code: "api_key_expired",
            message: "This API key has expired. sk-opencode-x",
          },
        },
        401,
      ),
    );
    const r = await f.run();
    expect(r).toEqual({ ok: false, kind: "error", error: "HTTP 401 (api_key_expired)" });
    expect(JSON.stringify(r)).not.toContain("sk-opencode-x");
  });

  it("reports a bare status when the error body is not JSON", async () => {
    const f = fetcher(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await f.run()).toEqual({ ok: false, kind: "error", error: "HTTP 502" });
  });

  it("maps 403 (no Go subscription / no usage access) to unsupported", async () => {
    const f = fetcher(() => json({ type: "error" }, 403));
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, kind: "unsupported" });
    expect(!r.ok && r.error).toContain("Go subscription");
  });

  it("errors on a 200 without allowance windows, and on a network failure", async () => {
    expect(await fetcher(() => json({ usage: { concurrent_sessions: 1 } })).run()).toEqual({
      ok: false,
      kind: "error",
      error: "response missing usage data",
    });
    const down = fetcher(() => Promise.reject(new TypeError("fetch failed")));
    expect(await down.run()).toEqual({
      ok: false,
      kind: "error",
      error: "TypeError: fetch failed",
    });
  });
});

describe("opencode in the service", () => {
  function service(opencode: UsageFetcher) {
    let now = 1_000_000;
    const notConfigured: UsageFetcher = async () => ({
      ok: false,
      kind: "not-configured",
      error: "none",
    });
    const svc = createAccountUsageService({
      fetchers: { claude: notConfigured, codex: notConfigured, opencode },
      now: () => now,
      random: () => 0.5,
      logger: noopLogger,
    });
    return {
      svc,
      advance(ms: number) {
        now += ms;
      },
      get now() {
        return now;
      },
    };
  }

  it("serves the OpenCode report third, labelled, with its three windows", async () => {
    const h = service(fetcher(() => json(payload)).run);
    const all = await h.svc.getAll();
    expect(all.providers.map((p) => p.provider)).toEqual(["claude", "codex", "opencode"]);
    const report = all.providers[2];
    expect(report).toMatchObject({
      provider: "opencode",
      label: "OpenCode",
      state: "fresh",
      limitReached: false,
      canServe: true,
      fetchedAt: h.now,
      error: null,
    });
    expect(report?.limits.map((l) => [l.label, l.used])).toEqual([
      ["5 Hour", 42],
      ["Weekly", 18],
      ["Monthly", 95],
    ]);
  });

  it("an expired key shows as unavailable with the upstream code", async () => {
    const h = service(fetcher(() => json({ error: { code: "api_key_expired" } }, 401)).run);
    const r = await h.svc.get("opencode");
    expect(r).toMatchObject({
      state: "unavailable",
      limits: [],
      error: "HTTP 401 (api_key_expired)",
    });
  });

  it("ignores inference response headers (only Claude + Codex report them)", async () => {
    const h = service(fetcher(() => json(payload)).run);
    const before = await h.svc.get("opencode");
    h.svc.ingestHeaders("opencode", { "x-codex-primary-used-percent": "99" }, 200);
    expect(await h.svc.get("opencode")).toEqual(before);
  });
});
