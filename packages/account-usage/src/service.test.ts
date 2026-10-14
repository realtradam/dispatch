import type { Credentials, Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  claudeRetryDelayMs,
  createClaudeFetcher,
  createCodexFetcher,
  type FetcherDeps,
  type FetchFn,
  type UsageFetcher,
  type UsageFetchResult,
} from "./fetchers.js";
import {
  CLAUDE_FAILURE_COOLDOWN_MS,
  createAccountUsageService,
  DEFAULT_FAILURE_COOLDOWN_MS,
  LAST_GOOD_RETENTION_MS,
  SUCCESS_TTL_MS,
} from "./service.js";
import type { ProviderUsage } from "./shared.js";

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

function jwt(accountId: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({})}.${enc({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.s`;
}

function usage(accountId: string | null, used = 10): ProviderUsage {
  return {
    account: { accountId, email: null, planType: null },
    limits: [
      {
        id: "claude:5h",
        label: "5 Hour",
        kind: "window",
        windowId: "5h",
        shared: true,
        tier: null,
        durationMs: 18_000_000,
        resetsAt: null,
        unit: "percent",
        used,
        limit: 100,
        remaining: 100 - used,
        usedFraction: used / 100,
        remainingFraction: 1 - used / 100,
        status: "ok",
      },
    ],
    limitReached: null,
    canServe: null,
    creditOverage: false,
    credits: null,
  };
}

function harness(script: Partial<Record<"claude" | "codex", () => Promise<UsageFetchResult>>>) {
  let now = 1_000_000;
  const calls = { claude: 0, codex: 0 };
  const mk =
    (p: "claude" | "codex"): UsageFetcher =>
    () => {
      calls[p]++;
      const f = script[p];
      return f ? f() : Promise.resolve({ ok: false, kind: "not-configured", error: "none" });
    };
  const svc = createAccountUsageService({
    fetchers: { claude: mk("claude"), codex: mk("codex") },
    now: () => now,
    random: () => 0.5, // jitter = exactly base
    logger: noopLogger,
  });
  return {
    svc,
    calls,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe("account usage service", () => {
  it("caches success for the TTL and reports fresh", async () => {
    const h = harness({ claude: async () => ({ ok: true, usage: usage("a") }) });
    const r1 = await h.svc.get("claude");
    expect(r1.state).toBe("fresh");
    expect(r1.fetchedAt).toBe(h.now);
    expect(r1.nextRefreshAt).toBe(h.now + SUCCESS_TTL_MS);
    h.advance(SUCCESS_TTL_MS - 1);
    await h.svc.get("claude");
    expect(h.calls.claude).toBe(1);
    h.advance(1);
    await h.svc.get("claude");
    expect(h.calls.claude).toBe(2);
  });

  it("deduplicates concurrent fetches", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      claude: async () => {
        await gate;
        return { ok: true, usage: usage("a") };
      },
    });
    const ps = [h.svc.get("claude"), h.svc.get("claude"), h.svc.getAll()];
    release();
    await Promise.all(ps);
    expect(h.calls.claude).toBe(1);
  });

  it("serves last-good as stale through failures, with cooldown", async () => {
    let fail = false;
    const h = harness({
      claude: async () =>
        fail
          ? { ok: false, kind: "error", error: "HTTP 503" }
          : { ok: true, usage: usage("a", 33) },
    });
    const fetchedAt = (await h.svc.get("claude")).fetchedAt;
    fail = true;
    h.advance(SUCCESS_TTL_MS);
    const r = await h.svc.get("claude");
    expect(r.state).toBe("stale");
    expect(r.limits[0]?.used).toBe(33);
    expect(r.fetchedAt).toBe(fetchedAt);
    expect(r.error).toBe("HTTP 503");
    expect(r.nextRefreshAt).toBe(h.now + CLAUDE_FAILURE_COOLDOWN_MS);
    // refresh=true never bypasses the failure cooldown.
    await h.svc.get("claude", { refresh: true });
    expect(h.calls.claude).toBe(2);
    // past retention → unavailable
    h.advance(LAST_GOOD_RETENTION_MS);
    const gone = await h.svc.get("claude");
    expect(gone.state).toBe("unavailable");
    expect(gone.limits).toEqual([]);
  });

  it("codex uses the shorter default failure cooldown", async () => {
    const h = harness({ codex: async () => ({ ok: false, kind: "error", error: "x" }) });
    const r = await h.svc.get("codex");
    expect(r.state).toBe("unavailable");
    expect(r.nextRefreshAt).toBe(h.now + DEFAULT_FAILURE_COOLDOWN_MS);
  });

  it("refresh=true bypasses the success TTL only after the min interval", async () => {
    const h = harness({ claude: async () => ({ ok: true, usage: usage("a") }) });
    await h.svc.get("claude");
    await h.svc.get("claude", { refresh: true });
    expect(h.calls.claude).toBe(1);
    h.advance(30_000);
    await h.svc.get("claude", { refresh: true });
    expect(h.calls.claude).toBe(2);
  });

  it("isolates accounts: a different account never inherits stale data", async () => {
    let next: UsageFetchResult = { ok: true, usage: usage("acct-A", 80) };
    const h = harness({ codex: async () => next });
    await h.svc.get("codex");
    next = { ok: false, kind: "error", error: "HTTP 500", accountId: "acct-B" };
    h.advance(SUCCESS_TTL_MS);
    const r = await h.svc.get("codex");
    expect(r.state).toBe("unavailable");
    expect(r.limits).toEqual([]);
  });

  it("not-configured / unsupported states carry no data", async () => {
    const h = harness({
      claude: async () => ({ ok: false, kind: "unsupported", error: "api key" }),
    });
    const all = await h.svc.getAll();
    expect(all.providers.map((p) => [p.provider, p.state])).toEqual([
      ["claude", "unsupported"],
      ["codex", "not-configured"],
    ]);
  });

  it("header ingestion merges rows without extending expiry; throttled", async () => {
    const h = harness({ claude: async () => ({ ok: true, usage: usage("a", 10) }) });
    const first = await h.svc.get("claude");
    h.svc.ingestHeaders("claude", { "anthropic-ratelimit-unified-5h-utilization": "0.2" });
    let r = await h.svc.get("claude");
    expect(r.limits[0]?.used).toBe(20);
    expect(r.fetchedAt).toBe(first.fetchedAt);
    expect(r.nextRefreshAt).toBe(first.nextRefreshAt);
    // throttled (non-exhausted within a minute)
    h.svc.ingestHeaders("claude", { "anthropic-ratelimit-unified-5h-utilization": "0.3" });
    r = await h.svc.get("claude");
    expect(r.limits[0]?.used).toBe(20);
    // exhausted bypasses the throttle
    h.svc.ingestHeaders("claude", { "anthropic-ratelimit-unified-5h-utilization": "1" });
    r = await h.svc.get("claude");
    expect(r.limits[0]?.status).toBe("exhausted");
  });
});

// ─── fetchers (fake only the outermost edge: fetch + credentials) ────────────

function fetcherDeps(
  creds: Credentials | null,
  responses: Array<Response | Error>,
  seen: Array<{ url: string; headers: Record<string, string> }> = [],
): FetcherDeps {
  const fetchFn: FetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    fetchFn,
    resolveCredentials: async () => creds,
    now: () => 1_760_000_000_000,
    sleep: async () => {},
    logger: noopLogger,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("claude fetcher", () => {
  const creds: Credentials = {
    type: "bearer-token",
    token: "tok-secret",
    baseURL: "https://api.anthropic.com/v1",
  };

  it("sends OAuth headers, retries transient 5xx, and fetches profile for identity", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = createClaudeFetcher(
      fetcherDeps(
        creds,
        [
          new Response("", { status: 503 }),
          json({ five_hour: { utilization: 5 } }),
          json({ account: { uuid: "u-1", email: "me@x" } }),
        ],
        seen,
      ),
    );
    const r = await f();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage.account).toMatchObject({ accountId: "u-1", email: "me@x" });
    expect(seen[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(seen[0]?.headers.authorization).toBe("Bearer tok-secret");
    expect(seen[0]?.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(seen[2]?.url).toBe("https://api.anthropic.com/api/oauth/profile");
  });

  it("does not retry 429 in-band", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = createClaudeFetcher(fetcherDeps(creds, [new Response("", { status: 429 })], seen));
    const r = await f();
    expect(r).toMatchObject({ ok: false, kind: "error", error: "HTTP 429" });
    expect(seen).toHaveLength(1);
  });

  it("gives up after 3 attempts", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = createClaudeFetcher(
      fetcherDeps(creds, [new Error("net"), new Error("net"), new Error("net")], seen),
    );
    expect((await f()).ok).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it("falls back to canonical only when a custom endpoint is absent", async () => {
    const proxy: Credentials = {
      type: "bearer-token",
      token: "t",
      baseURL: "https://p.example/v1",
    };
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = createClaudeFetcher(
      fetcherDeps(
        proxy,
        [
          new Response("", { status: 404 }),
          json({ five_hour: { utilization: 1 }, account_id: "a", email: "e" }),
        ],
        seen,
      ),
    );
    expect((await f()).ok).toBe(true);
    expect(seen.map((s) => s.url)).toEqual([
      "https://p.example/api/oauth/usage",
      "https://api.anthropic.com/api/oauth/usage",
    ]);
    const seen2: Array<{ url: string; headers: Record<string, string> }> = [];
    const f2 = createClaudeFetcher(fetcherDeps(proxy, [new Response("", { status: 401 })], seen2));
    expect((await f2()).ok).toBe(false);
    expect(seen2).toHaveLength(1);
  });

  it("reports unsupported for plain API keys and not-configured for null", async () => {
    expect(
      await createClaudeFetcher(fetcherDeps({ type: "api-key", apiKey: "sk-ant-api03-x" }, []))(),
    ).toMatchObject({ ok: false, kind: "unsupported" });
    expect(await createClaudeFetcher(fetcherDeps(null, []))()).toMatchObject({
      kind: "not-configured",
    });
  });

  it("retry delay honors Retry-After", () => {
    expect(claudeRetryDelayMs(0, null, 0)).toBe(500);
    expect(claudeRetryDelayMs(1, null, 0)).toBe(1000);
    expect(claudeRetryDelayMs(0, "3", 0)).toBe(3000);
  });
});

describe("codex fetcher", () => {
  it("sends account id header and parses the response", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const token = jwt("acc-9");
    const f = createCodexFetcher(
      fetcherDeps(
        { type: "bearer-token", token, baseURL: "https://chatgpt.com/backend-api" },
        [json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 7 } } })],
        seen,
      ),
    );
    const r = await f();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage.account).toMatchObject({ accountId: "acc-9", planType: "plus" });
    expect(seen[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(seen[0]?.headers["chatgpt-account-id"]).toBe("acc-9");
  });

  it("failure carries the JWT account id for cache isolation", async () => {
    const f = createCodexFetcher(
      fetcherDeps({ type: "bearer-token", token: jwt("acc-2") }, [
        new Response("", { status: 500 }),
      ]),
    );
    expect(await f()).toMatchObject({ ok: false, accountId: "acc-2", error: "HTTP 500" });
  });

  it("rotated token for the same account keeps the cache identity", async () => {
    let token = jwt("same");
    const responses = [
      json({ rate_limit: { primary_window: { used_percent: 40 } } }),
      new Response("", { status: 500 }),
    ];
    const deps = fetcherDeps(null, responses);
    const fetcher = createCodexFetcher({
      ...deps,
      resolveCredentials: async () => ({ type: "bearer-token", token }),
    });
    let now = 0;
    const svc = createAccountUsageService({
      fetchers: {
        claude: async () => ({ ok: false, kind: "not-configured", error: "" }),
        codex: fetcher,
      },
      now: () => now,
      random: () => 0.5,
      logger: noopLogger,
    });
    await svc.get("codex");
    token = `${jwt("same")}x`; // rotated token, same account
    now += SUCCESS_TTL_MS;
    const r = await svc.get("codex");
    expect(r.state).toBe("stale");
    expect(r.limits[0]?.used).toBe(40);
  });
});

describe("provider response-headers routing", () => {
  it("routes by auth id, then by header prefix", async () => {
    const { providerForResponse } = await import("./service.js");
    expect(
      providerForResponse({
        providerId: "anthropic",
        authId: "claude-oauth",
        status: 200,
        headers: {},
      }),
    ).toBe("claude");
    expect(
      providerForResponse({
        providerId: "openai",
        authId: "codex-oauth",
        status: 200,
        headers: {},
      }),
    ).toBe("codex");
    expect(
      providerForResponse({
        providerId: "x",
        authId: "apikey",
        status: 200,
        headers: { "x-codex-primary-used-percent": "1" },
      }),
    ).toBeNull();
    expect(
      providerForResponse({
        providerId: "x",
        status: 200,
        headers: { "x-codex-primary-used-percent": "1" },
      }),
    ).toBe("codex");
    expect(providerForResponse({ providerId: "x", status: 200, headers: {} })).toBeNull();
  });

  it("codex 100% on a successful response is a warning, not exhausted", async () => {
    const { parseCodexRateLimitHeaders } = await import("./codex.js");
    const h = { "x-codex-primary-used-percent": "100" };
    expect(parseCodexRateLimitHeaders(h, 0, 200)[0]?.status).toBe("warning");
    expect(parseCodexRateLimitHeaders(h, 0, 429)[0]?.status).toBe("exhausted");
  });
});
