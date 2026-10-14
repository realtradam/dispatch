/**
 * Provider usage FETCHERS — the effectful shell around the pure parsers.
 * Every effect (fetch, credential resolution, sleep, clock) is injected so
 * the retry/fallback logic is testable against a fake outermost edge.
 *
 * Credentials come from the kernel auth registry (`claude-oauth` /
 * `codex-oauth`), which already refreshes OAuth tokens nearing expiry. Tokens
 * are only ever placed in request headers — never logged, never returned.
 */
import type { Credentials, Logger } from "@dispatch/kernel";
import {
  buildClaudeUsageHeaders,
  claudeOAuthBaseUrls,
  isClaudeOAuthToken,
  looksLikeClaudeUsagePayload,
  parseClaudeProfile,
  parseClaudeUsagePayload,
} from "./claude.js";
import {
  buildCodexUsageHeaders,
  CODEX_USAGE_PATH,
  extractCodexIdentity,
  normalizeCodexAccountBase,
  parseCodexUsagePayload,
} from "./codex.js";
import { HYPER_DEFAULT_BASE_URL, parseHyperCredits } from "./hyper.js";
import { isRecord, type ProviderUsage } from "./shared.js";

/** Outcome of one usage fetch. `identity` lets the cache isolate accounts even on failure. */
export type UsageFetchResult =
  | { readonly ok: true; readonly usage: ProviderUsage }
  | {
      readonly ok: false;
      readonly kind: "not-configured" | "unsupported" | "error";
      readonly error: string;
      /** Account identity known before the request (Codex JWT), if any. */
      readonly accountId?: string;
    };

/** The subset of `fetch` the fetchers use (easy to fake at the outermost edge). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface FetcherDeps {
  readonly fetchFn: FetchFn;
  /** Resolve current credentials (null = not configured / auth extension absent). */
  readonly resolveCredentials: () => Promise<Credentials | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: Logger;
  /** Per-request timeout (ms). Default 15s. */
  readonly timeoutMs?: number;
}

export type UsageFetcher = () => Promise<UsageFetchResult>;

const DEFAULT_TIMEOUT_MS = 15_000;
const CLAUDE_MAX_ATTEMPTS = 3;
const CLAUDE_BASE_RETRY_MS = 500;
const ENDPOINT_ABSENT = new Set([404, 405, 410, 501]);

function errMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isAbortLike(err: unknown): boolean {
  return isRecord(err) && (err.name === "AbortError" || err.name === "TimeoutError");
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status >= 500;
}

/** Retry-After (seconds or HTTP date) vs. exponential baseline — the larger wins. */
export function claudeRetryDelayMs(
  attempt: number,
  retryAfter: string | null,
  nowMs: number,
): number {
  const baseline = CLAUDE_BASE_RETRY_MS * 2 ** attempt;
  if (!retryAfter?.trim()) return baseline;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(baseline, seconds * 1000);
  const date = Date.parse(retryAfter) - nowMs;
  return Number.isFinite(date) ? Math.max(baseline, date) : baseline;
}

interface ClaudePayloadAttempt {
  readonly payload: Record<string, unknown> | null;
  readonly endpointAbsent: boolean;
  readonly error: string | null;
}

async function fetchClaudePayload(
  deps: FetcherDeps,
  url: string,
  headers: Record<string, string>,
): Promise<ClaudePayloadAttempt> {
  let lastPayload: Record<string, unknown> | null = null;
  let endpointAbsent = false;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < CLAUDE_MAX_ATTEMPTS; attempt++) {
    const canRetry = attempt < CLAUDE_MAX_ATTEMPTS - 1;
    try {
      const res = await deps.fetchFn(url, {
        headers,
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const absent = ENDPOINT_ABSENT.has(res.status);
        // 429 is NOT retried in-band (the endpoint stays throttled for minutes);
        // the outer failure cooldown handles it.
        const retryable = !absent && res.status !== 429 && isTransientStatus(res.status);
        lastError = `HTTP ${res.status}`;
        deps.logger.warn("account-usage: claude usage fetch failed", {
          status: res.status,
          attempt,
          willRetry: retryable && canRetry,
        });
        if (!retryable || !canRetry)
          return { payload: null, endpointAbsent: absent, error: lastError };
        await deps.sleep(claudeRetryDelayMs(attempt, res.headers.get("retry-after"), deps.now()));
        continue;
      }
      const body = await res.text();
      if (body.trim() === "")
        return { payload: lastPayload, endpointAbsent: true, error: "empty body" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        const claimsJson = /json/i.test(res.headers.get("content-type") ?? "");
        lastError = "non-JSON response";
        if (!claimsJson) return { payload: lastPayload, endpointAbsent: true, error: lastError };
        if (!canRetry) break;
        await deps.sleep(claudeRetryDelayMs(attempt, null, deps.now()));
        continue;
      }
      if (isRecord(parsed)) {
        lastPayload = parsed;
        const usage = parseClaudeUsagePayload(parsed);
        if (usage && usage.limits.length > 0)
          return { payload: parsed, endpointAbsent: false, error: null };
        endpointAbsent = !looksLikeClaudeUsagePayload(parsed);
      } else {
        endpointAbsent = true;
      }
      lastError = "response missing usage data";
      if (!canRetry) break;
      await deps.sleep(claudeRetryDelayMs(attempt, null, deps.now()));
    } catch (err) {
      lastError = errMessage(err);
      // Aborts / timeouts are not retried.
      if (isAbortLike(err)) return { payload: null, endpointAbsent: false, error: lastError };
      deps.logger.warn("account-usage: claude usage fetch error", {
        error: lastError,
        attempt,
        willRetry: canRetry,
      });
      if (!canRetry) break;
      await deps.sleep(claudeRetryDelayMs(attempt, null, deps.now()));
    }
  }
  return { payload: lastPayload, endpointAbsent, error: lastError };
}

/** Extract the bearer usable for Claude subscription usage, or null (unsupported). */
function claudeToken(creds: Credentials): string | null {
  if (creds.type === "bearer-token") return creds.token;
  return isClaudeOAuthToken(creds.apiKey) ? creds.apiKey : null;
}

export function createClaudeFetcher(deps: FetcherDeps): UsageFetcher {
  return async () => {
    const creds = await deps.resolveCredentials();
    if (!creds) return { ok: false, kind: "not-configured", error: "No Claude OAuth credentials" };
    const token = claudeToken(creds);
    if (!token) {
      return {
        ok: false,
        kind: "unsupported",
        error: "Anthropic API keys cannot query subscription usage",
      };
    }
    const headers = buildClaudeUsageHeaders(token, process.env.ANTHROPIC_CLI_VERSION || undefined);

    let base: string | null = null;
    let payload: Record<string, unknown> | null = null;
    let error = "usage request failed";
    for (const candidate of claudeOAuthBaseUrls(creds.baseURL)) {
      const r = await fetchClaudePayload(deps, `${candidate}/usage`, headers);
      if (r.payload) {
        const u = parseClaudeUsagePayload(r.payload);
        if (u && u.limits.length > 0) {
          base = candidate;
          payload = r.payload;
          break;
        }
        if (!payload) {
          base = candidate;
          payload = r.payload;
        }
      }
      if (r.error) error = r.error;
      // Only "endpoint absent" justifies falling back to the canonical host.
      if (!r.endpointAbsent) break;
    }
    const usage = payload ? parseClaudeUsagePayload(payload) : null;
    if (!usage || usage.limits.length === 0 || base === null) {
      return { ok: false, kind: "error", error };
    }

    let { accountId, email } = usage.account;
    if (!accountId || !email) {
      try {
        const res = await deps.fetchFn(`${base}/profile`, {
          headers,
          signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (res.ok) {
          const p = parseClaudeProfile(await res.json());
          accountId ??= p.accountId ?? null;
          email ??= p.email ?? null;
        }
      } catch (err) {
        deps.logger.debug("account-usage: claude profile fetch error", { error: errMessage(err) });
      }
    }
    return { ok: true, usage: { ...usage, account: { ...usage.account, accountId, email } } };
  };
}

export function createCodexFetcher(deps: FetcherDeps): UsageFetcher {
  return async () => {
    const creds = await deps.resolveCredentials();
    if (!creds) return { ok: false, kind: "not-configured", error: "No Codex OAuth credentials" };
    if (creds.type !== "bearer-token") {
      return {
        ok: false,
        kind: "unsupported",
        error: "Only ChatGPT OAuth credentials can query Codex usage",
      };
    }
    const identity = extractCodexIdentity(creds.token);
    const idField = identity.accountId ? { accountId: identity.accountId } : {};
    const url = `${normalizeCodexAccountBase(creds.baseURL)}/${CODEX_USAGE_PATH}`;
    let payload: unknown;
    try {
      const res = await deps.fetchFn(url, {
        headers: buildCodexUsageHeaders(creds.token, identity.accountId),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        deps.logger.warn("account-usage: codex usage fetch failed", { status: res.status });
        return { ok: false, kind: "error", error: `HTTP ${res.status}`, ...idField };
      }
      payload = await res.json();
    } catch (err) {
      const error = errMessage(err);
      deps.logger.warn("account-usage: codex usage fetch error", { error });
      return { ok: false, kind: "error", error, ...idField };
    }
    const usage = parseCodexUsagePayload(payload, deps.now(), identity);
    if (!usage)
      return { ok: false, kind: "error", error: "response missing usage data", ...idField };
    return { ok: true, usage };
  };
}

export interface HyperFetcherDeps {
  readonly fetchFn: FetchFn;
  /** The Hyper API key + base URL (from `HYPER_API_KEY` / `HYPER_BASE_URL`), or null. */
  readonly resolveConfig: () => { readonly apiKey: string; readonly baseURL?: string } | null;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

/**
 * Hyper `GET <base>/credits` → `{ balance }`. The daily allowance + reset
 * time are applied by the service from user settings.
 */
export function createHyperFetcher(deps: HyperFetcherDeps): UsageFetcher {
  return async () => {
    const cfg = deps.resolveConfig();
    if (!cfg) return { ok: false, kind: "not-configured", error: "No HYPER_API_KEY configured" };
    const base = (cfg.baseURL?.trim() || HYPER_DEFAULT_BASE_URL).replace(/\/+$/, "");
    let payload: unknown;
    try {
      const res = await deps.fetchFn(`${base}/credits`, {
        headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        deps.logger.warn("account-usage: hyper credits fetch failed", { status: res.status });
        return { ok: false, kind: "error", error: `HTTP ${res.status}` };
      }
      payload = await res.json();
    } catch (err) {
      const error = errMessage(err);
      deps.logger.warn("account-usage: hyper credits fetch error", { error });
      return { ok: false, kind: "error", error };
    }
    const balance = parseHyperCredits(payload);
    if (balance === null) return { ok: false, kind: "error", error: "response missing balance" };
    return {
      ok: true,
      usage: {
        account: { accountId: null, email: null, planType: null },
        limits: [],
        limitReached: null,
        canServe: balance > 0,
        creditOverage: false,
        credits: null,
        dailyBalance: balance,
      },
    };
  };
}
