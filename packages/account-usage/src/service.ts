/**
 * Account usage SERVICE — per-provider caching, request dedup, failure
 * cooldown, last-good retention, and header ingestion. Mirrors OMP
 * `auth/usage.ts` + `auth/usage-cache.ts`:
 *
 * - success  → cached for 5 min ±25% jitter (staggers refreshes)
 * - failure  → cooldown 10 s (Codex) / 60 s (Claude) ±25% jitter; the last
 *              good report (≤ 24 h old, same account) is served as `stale`
 * - concurrent requests share ONE in-flight fetch
 * - cache identity is the ACCOUNT (accountId), never the access token, so a
 *   rotated OAuth token keeps the cache; a different account never inherits
 *   another account's numbers
 * - `refresh: true` bypasses the success TTL but never the failure cooldown
 *   nor a 30 s minimum interval, so clients cannot hammer the provider
 *
 * State is owned by the returned closure (no module state). Clock + random
 * are injected for deterministic tests.
 */
import {
  defineService,
  type Logger,
  type ProviderResponseHeadersPayload,
  type ServiceHandle,
} from "@dispatch/kernel";
import type {
  AccountUsageProviderId,
  AccountUsageReport,
  AccountUsageResponse,
  AccountUsageState,
} from "@dispatch/transport-contract";
import { parseClaudeRateLimitHeaders } from "./claude.js";
import { parseCodexRateLimitHeaders } from "./codex.js";
import type { UsageFetcher, UsageFetchResult } from "./fetchers.js";
import { mergeLimits, type ProviderUsage } from "./shared.js";

export const SUCCESS_TTL_MS = 5 * 60_000;
export const LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
export const DEFAULT_FAILURE_COOLDOWN_MS = 10_000;
export const CLAUDE_FAILURE_COOLDOWN_MS = 60_000;
/** Cooldown when credentials are missing/unsupported (cheap local check, no network). */
export const NOT_CONFIGURED_RECHECK_MS = 30_000;
/** Minimum spacing between network attempts even for `refresh: true`. */
export const MIN_FORCED_INTERVAL_MS = 30_000;
export const HEADER_INGEST_THROTTLE_MS = 60_000;
export const JITTER_FRACTION = 0.25;

export const PROVIDER_ORDER: readonly AccountUsageProviderId[] = ["claude", "codex"];
const LABELS: Record<AccountUsageProviderId, string> = { claude: "Claude", codex: "Codex" };

export interface AccountUsageService {
  /** Every provider's report (fixed order). Refreshes expired entries (deduped). */
  readonly getAll: (opts?: { readonly refresh?: boolean }) => Promise<AccountUsageResponse>;
  /** One provider's report. */
  readonly get: (
    provider: AccountUsageProviderId,
    opts?: { readonly refresh?: boolean },
  ) => Promise<AccountUsageReport>;
  /**
   * Passive ingestion of inference rate-limit headers (lower-cased keys).
   * Throttled to once/minute unless a window is exhausted; merges rows by id
   * into the cached report WITHOUT extending its refresh expiry.
   */
  readonly ingestHeaders: (
    provider: AccountUsageProviderId,
    headers: Readonly<Record<string, string>>,
    responseStatus?: number,
  ) => void;
}

export const accountUsageServiceHandle: ServiceHandle<AccountUsageService> =
  defineService<AccountUsageService>("account-usage/service");

export interface AccountUsageServiceDeps {
  readonly fetchers: Readonly<Record<AccountUsageProviderId, UsageFetcher>>;
  readonly now: () => number;
  /** 0..1 random source for jitter. */
  readonly random: () => number;
  readonly logger: Logger;
}

interface LastGood {
  readonly usage: ProviderUsage;
  readonly fetchedAt: number;
  /** Account identity at fetch time (null = unknown). */
  readonly accountId: string | null;
}

interface Entry {
  /** Last good report per account id ("" = unknown account). */
  readonly lastGood: Map<string, LastGood>;
  /** The account the provider's credentials currently belong to. */
  currentAccount: string | null;
  lastAttemptAt: number | null;
  nextRefreshAt: number | null;
  error: string | null;
  kind: "ok" | "error" | "not-configured" | "unsupported" | null;
  inflight: Promise<void> | null;
  headerIngestedAt: number | null;
}

/**
 * Map a provider response-headers event to the account it bills. Keyed by the
 * auth id (the claude/codex extensions' OAuth auth providers); falls back to
 * header presence so a provider that omits `authId` still routes.
 */
export function providerForResponse(
  payload: ProviderResponseHeadersPayload,
): AccountUsageProviderId | null {
  if (payload.authId === "claude-oauth") return "claude";
  if (payload.authId === "codex-oauth") return "codex";
  if (payload.authId !== undefined) return null;
  const keys = Object.keys(payload.headers);
  if (keys.some((k) => k.startsWith("anthropic-ratelimit-unified-"))) return "claude";
  if (keys.some((k) => k.startsWith("x-codex-"))) return "codex";
  return null;
}

export function jitter(baseMs: number, random: () => number): number {
  return Math.round(baseMs * (1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random()));
}

export function createAccountUsageService(deps: AccountUsageServiceDeps): AccountUsageService {
  const entries = new Map<AccountUsageProviderId, Entry>();
  const log = deps.logger;

  function entryFor(p: AccountUsageProviderId): Entry {
    let e = entries.get(p);
    if (!e) {
      e = {
        lastGood: new Map(),
        currentAccount: null,
        lastAttemptAt: null,
        nextRefreshAt: null,
        error: null,
        kind: null,
        inflight: null,
        headerIngestedAt: null,
      };
      entries.set(p, e);
    }
    return e;
  }

  function currentLastGood(e: Entry): LastGood | undefined {
    const lg = e.lastGood.get(e.currentAccount ?? "");
    if (!lg) return undefined;
    if (deps.now() - lg.fetchedAt > LAST_GOOD_RETENTION_MS) return undefined;
    return lg;
  }

  function apply(p: AccountUsageProviderId, e: Entry, r: UsageFetchResult): void {
    const now = deps.now();
    e.lastAttemptAt = now;
    if (r.ok) {
      const accountId = r.usage.account.accountId;
      e.currentAccount = accountId;
      e.lastGood.set(accountId ?? "", { usage: r.usage, fetchedAt: now, accountId });
      // Prune expired accounts.
      for (const [k, v] of e.lastGood) {
        if (now - v.fetchedAt > LAST_GOOD_RETENTION_MS) e.lastGood.delete(k);
      }
      e.kind = "ok";
      e.error = null;
      e.nextRefreshAt = now + jitter(SUCCESS_TTL_MS, deps.random);
      log.info("account-usage: refreshed", { provider: p, limits: r.usage.limits.length });
      return;
    }
    e.kind = r.kind;
    e.error = r.error;
    // A failure that reveals the account (Codex JWT) re-anchors the cache, so
    // a different account never inherits the previous account's report.
    if (r.accountId !== undefined) e.currentAccount = r.accountId;
    if (r.kind === "error") {
      const base = p === "claude" ? CLAUDE_FAILURE_COOLDOWN_MS : DEFAULT_FAILURE_COOLDOWN_MS;
      e.nextRefreshAt = now + jitter(base, deps.random);
      log.warn("account-usage: refresh failed", { provider: p, error: r.error });
    } else {
      e.nextRefreshAt = now + NOT_CONFIGURED_RECHECK_MS;
    }
  }

  async function refresh(p: AccountUsageProviderId, e: Entry): Promise<void> {
    if (e.inflight) return e.inflight;
    const run = (async () => {
      let result: UsageFetchResult;
      try {
        result = await deps.fetchers[p]();
      } catch (err) {
        result = {
          ok: false,
          kind: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      apply(p, e, result);
    })().finally(() => {
      e.inflight = null;
    });
    e.inflight = run;
    return run;
  }

  function shouldRefresh(e: Entry, force: boolean): boolean {
    const now = deps.now();
    if (e.nextRefreshAt === null) return true;
    if (now >= e.nextRefreshAt) return true;
    if (!force || e.kind !== "ok") return false; // never bypass a failure cooldown
    return e.lastAttemptAt === null || now - e.lastAttemptAt >= MIN_FORCED_INTERVAL_MS;
  }

  function build(p: AccountUsageProviderId, e: Entry): AccountUsageReport {
    const lg = currentLastGood(e);
    let state: AccountUsageState;
    switch (e.kind) {
      case "ok":
        state = lg ? "fresh" : "unavailable";
        break;
      case "not-configured":
        state = "not-configured";
        break;
      case "unsupported":
        state = "unsupported";
        break;
      default:
        state = lg ? "stale" : "unavailable";
    }
    const showData = state === "fresh" || state === "stale";
    const u = showData && lg ? lg.usage : null;
    return {
      provider: p,
      label: LABELS[p],
      state,
      account: u ? u.account : null,
      limits: u ? u.limits : [],
      limitReached: u ? u.limitReached : null,
      canServe: u ? u.canServe : null,
      creditOverage: u ? u.creditOverage : false,
      credits: u ? u.credits : null,
      fetchedAt: showData && lg ? lg.fetchedAt : null,
      lastAttemptAt: e.lastAttemptAt,
      nextRefreshAt: e.nextRefreshAt,
      error: e.error,
    };
  }

  async function get(
    p: AccountUsageProviderId,
    opts?: { readonly refresh?: boolean },
  ): Promise<AccountUsageReport> {
    const e = entryFor(p);
    if (e.inflight) await e.inflight;
    else if (shouldRefresh(e, opts?.refresh === true)) await refresh(p, e);
    return build(p, e);
  }

  return {
    get,
    async getAll(opts) {
      const providers = await Promise.all(PROVIDER_ORDER.map((p) => get(p, opts)));
      return { providers, servedAt: deps.now() };
    },
    ingestHeaders(p, headers, responseStatus) {
      const now = deps.now();
      const incoming =
        p === "claude"
          ? parseClaudeRateLimitHeaders(headers)
          : parseCodexRateLimitHeaders(headers, now, responseStatus);
      if (incoming.length === 0) return;
      const e = entryFor(p);
      const exhausted = incoming.some((l) => l.status === "exhausted");
      if (
        !exhausted &&
        e.headerIngestedAt !== null &&
        now - e.headerIngestedAt < HEADER_INGEST_THROTTLE_MS
      ) {
        return;
      }
      const lg = currentLastGood(e);
      // Only merge into an existing full report: header rows alone would mask
      // endpoint-only fields; the next poll fills the report instead.
      if (!lg) return;
      e.headerIngestedAt = now;
      // fetchedAt is NOT advanced — headers must not keep endpoint-only data
      // (spend, scoped meters) looking fresh, nor extend nextRefreshAt.
      e.lastGood.set(e.currentAccount ?? "", {
        ...lg,
        usage: { ...lg.usage, limits: mergeLimits(lg.usage.limits, incoming) },
      });
    },
  };
}
