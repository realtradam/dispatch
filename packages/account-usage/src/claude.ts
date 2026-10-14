/**
 * Claude (Pro/Max OAuth) subscription usage — PURE parsing + request building.
 *
 * Endpoint: `GET https://api.anthropic.com/api/oauth/usage` (OAuth bearer).
 * Endpoint utilization values are PERCENTAGES (0..100); `resets_at` is ISO.
 * Inference response headers (`anthropic-ratelimit-unified-*`) carry
 * utilization as a FRACTION (0..1) and reset as Unix SECONDS.
 *
 * Mirrors oh-my-pi `packages/ai/src/usage/claude.ts` + `claude-api.ts`.
 */
import type { AccountUsageLimit } from "@dispatch/transport-contract";
import {
  HOUR_MS,
  isRecord,
  nonEmptyString,
  type ProviderUsage,
  parseIsoTimestamp,
  percentAmount,
  slugify,
  toNumber,
  usageStatus,
  WEEK_MS,
} from "./shared.js";

export const CLAUDE_API_ROOT = "https://api.anthropic.com";
export const CLAUDE_OAUTH_BASE = `${CLAUDE_API_ROOT}/api/oauth`;

/** Reverse-engineered beta list OMP sends to `/api/oauth/usage` (version-locked; expected to rot). */
export const CLAUDE_USAGE_BETAS =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

/** Claude Code CLI version the user-agent claims (overridable via ANTHROPIC_CLI_VERSION at the edge). */
export const CLAUDE_CLI_VERSION = "2.1.283";

/** Is this API-key-shaped string actually an OAuth access token? */
export function isClaudeOAuthToken(value: string): boolean {
  return value.startsWith("sk-ant-oat");
}

/**
 * Normalize a configured base (`…/v1`, `…/api/oauth`, or a bare root) to the
 * OAuth account base, preserving custom path prefixes. Returns the configured
 * base first and the canonical one as fallback (deduplicated).
 */
export function claudeOAuthBaseUrls(baseUrl?: string): readonly string[] {
  let root = CLAUDE_API_ROOT;
  if (baseUrl?.trim()) {
    try {
      const url = new URL(baseUrl.trim());
      let path = url.pathname.replace(/\/+$/, "");
      const lower = path.toLowerCase();
      if (lower.endsWith("/api/oauth")) path = path.slice(0, -"/api/oauth".length);
      else if (lower.endsWith("/v1")) path = path.slice(0, -"/v1".length);
      root = `${url.origin}${path}`;
    } catch {
      root = CLAUDE_API_ROOT;
    }
  }
  const configured = `${root}/api/oauth`;
  return configured === CLAUDE_OAUTH_BASE ? [CLAUDE_OAUTH_BASE] : [configured, CLAUDE_OAUTH_BASE];
}

export function buildClaudeUsageHeaders(
  accessToken: string,
  cliVersion: string = CLAUDE_CLI_VERSION,
): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "anthropic-beta": CLAUDE_USAGE_BETAS,
    "user-agent": `claude-cli/${cliVersion} (external, cli)`,
    authorization: `Bearer ${accessToken}`,
  };
}

interface Bucket {
  readonly utilization?: number;
  readonly resetsAt?: number;
}

function parseBucket(raw: unknown): Bucket | undefined {
  if (!isRecord(raw)) return undefined;
  const utilization = toNumber(raw.utilization);
  const resetsAt = parseIsoTimestamp(raw.resets_at);
  if (utilization === undefined && resetsAt === undefined) return undefined;
  return {
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

interface GenericLimit {
  readonly kind: string;
  readonly bucket: Bucket;
  readonly displayName?: string;
}

/**
 * Parse the generic `limits[]` array. `is_active` is deliberately IGNORED: it
 * marks only the currently binding limit, not whether the bucket exists.
 */
export function parseGenericLimits(raw: unknown): GenericLimit[] {
  if (!Array.isArray(raw)) return [];
  const out: GenericLimit[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== "string") continue;
    const utilization = toNumber(entry.percent);
    const resetsAt = parseIsoTimestamp(entry.resets_at);
    if (utilization === undefined && resetsAt === undefined) continue;
    const scope = isRecord(entry.scope) ? entry.scope : undefined;
    const model = scope && isRecord(scope.model) ? scope.model : undefined;
    const displayName = model ? nonEmptyString(model.display_name) : undefined;
    out.push({
      kind: entry.kind,
      bucket: {
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      },
      ...(displayName ? { displayName } : {}),
    });
  }
  return out;
}

function windowLimit(args: {
  id: string;
  label: string;
  windowId: string;
  durationMs: number;
  bucket: Bucket | undefined;
  shared: boolean;
  tier: string | null;
}): AccountUsageLimit | null {
  if (!args.bucket || args.bucket.utilization === undefined) return null;
  const amount = percentAmount(args.bucket.utilization);
  return {
    id: args.id,
    label: args.label,
    kind: "window",
    windowId: args.windowId,
    shared: args.shared,
    tier: args.tier,
    durationMs: args.durationMs,
    resetsAt: args.bucket.resetsAt ?? null,
    ...amount,
    status: usageStatus(amount.usedFraction),
  };
}

/** Money in minor units → dollars. Only USD (or absent currency when allowed). */
function parseDollars(
  amountMinor: unknown,
  exponent: unknown,
  currency: unknown,
  currencyRequired: boolean,
): number | undefined {
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    typeof exponent !== "number" ||
    !Number.isSafeInteger(exponent) ||
    exponent < 0
  ) {
    return undefined;
  }
  if (currency === undefined) {
    if (currencyRequired) return undefined;
  } else if (typeof currency !== "string" || currency.toUpperCase() !== "USD") {
    return undefined;
  }
  return amountMinor / 10 ** exponent;
}

interface Spend {
  readonly used: number;
  readonly limit: number | null;
}

function parseSpend(value: unknown): Spend | null {
  if (!isRecord(value) || value.enabled !== true || !Object.hasOwn(value, "limit")) return null;
  if (!isRecord(value.used)) return null;
  const used = parseDollars(
    value.used.amount_minor,
    value.used.exponent,
    value.used.currency,
    true,
  );
  if (used === undefined) return null;
  if (value.limit === null) return { used, limit: null };
  if (!isRecord(value.limit)) return null;
  const limit = parseDollars(
    value.limit.amount_minor,
    value.limit.exponent,
    value.limit.currency,
    true,
  );
  return limit === undefined || limit <= 0 ? null : { used, limit };
}

function parseLegacyExtra(value: unknown): Spend | null {
  if (!isRecord(value) || value.is_enabled !== true || !Object.hasOwn(value, "monthly_limit")) {
    return null;
  }
  const places = value.decimal_places === undefined ? 2 : value.decimal_places;
  const used = parseDollars(value.used_credits, places, value.currency, false);
  if (used === undefined) return null;
  if (value.monthly_limit === null || value.monthly_limit === undefined) {
    return { used, limit: null };
  }
  const limit = parseDollars(value.monthly_limit, places, value.currency, false);
  return limit === undefined || limit <= 0 ? null : { used, limit };
}

/** Extra paid usage (new `spend` wins over legacy `extra_usage`). Unlimited cap ⇒ `limit: null`. */
export function buildClaudeExtraUsage(payload: Record<string, unknown>): AccountUsageLimit | null {
  const parsed =
    payload.spend === null || payload.spend === undefined
      ? parseLegacyExtra(payload.extra_usage)
      : parseSpend(payload.spend);
  if (!parsed) return null;
  const { used, limit } = parsed;
  const usedFraction = limit === null ? null : used / limit;
  return {
    id: "claude:extra",
    label: "Extra usage",
    kind: "spend",
    windowId: "extra",
    shared: false,
    tier: null,
    durationMs: null,
    resetsAt: null,
    unit: "usd",
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    usedFraction,
    remainingFraction: usedFraction === null ? null : Math.max(0, 1 - usedFraction),
    status: limit === null ? "unknown" : used >= limit ? "exhausted" : usageStatus(usedFraction),
  };
}

function payloadIdentity(payload: Record<string, unknown>): {
  accountId?: string;
  email?: string;
} {
  const nested = (key: string, inner: string): string | undefined => {
    const v = payload[key];
    return isRecord(v) ? nonEmptyString(v[inner]) : undefined;
  };
  const accountId =
    nonEmptyString(payload.account_id) ??
    nonEmptyString(payload.user_id) ??
    nested("account", "uuid") ??
    nested("account", "id") ??
    nested("user", "uuid");
  const email =
    nonEmptyString(payload.email) ?? nested("account", "email") ?? nested("user", "email");
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

/** Identity from `GET /api/oauth/profile`. */
export function parseClaudeProfile(raw: unknown): { accountId?: string; email?: string } {
  if (!isRecord(raw)) return {};
  const account = isRecord(raw.account) ? raw.account : undefined;
  const accountId =
    nonEmptyString(raw.uuid) ?? (account ? nonEmptyString(account.uuid) : undefined);
  const email = nonEmptyString(raw.email) ?? (account ? nonEmptyString(account.email) : undefined);
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

/** True when the body carries at least one usage number. */
export function claudePayloadHasUsage(raw: unknown): boolean {
  const parsed = parseClaudeUsagePayload(raw);
  return parsed !== null && parsed.limits.length > 0;
}

/**
 * A body without any usage keys is a host answering something else at this
 * path (index/error page) — not an account with empty windows.
 */
export function looksLikeClaudeUsagePayload(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return ["five_hour", "seven_day", "limits", "extra_usage", "spend"].some((k) => k in raw);
}

/**
 * Normalize one `/api/oauth/usage` payload. Supports both the legacy buckets
 * and the generic `limits[]` (`session`, `weekly_all`, `weekly_scoped`).
 * Returns null when the body is not an object.
 */
export function parseClaudeUsagePayload(
  raw: unknown,
  planType: string | null = null,
): ProviderUsage | null {
  if (!isRecord(raw)) return null;
  const generic = parseGenericLimits(raw.limits);
  const fiveHour = parseBucket(raw.five_hour) ?? generic.find((g) => g.kind === "session")?.bucket;
  const sevenDay =
    parseBucket(raw.seven_day) ?? generic.find((g) => g.kind === "weekly_all")?.bucket;

  const limits: AccountUsageLimit[] = [];
  const push = (l: AccountUsageLimit | null) => {
    if (l && !limits.some((x) => x.id === l.id)) limits.push(l);
  };
  push(
    windowLimit({
      id: "claude:5h",
      label: "5 Hour",
      windowId: "5h",
      durationMs: 5 * HOUR_MS,
      bucket: fiveHour,
      shared: true,
      tier: null,
    }),
  );
  push(
    windowLimit({
      id: "claude:7d",
      label: "7 Day",
      windowId: "7d",
      durationMs: WEEK_MS,
      bucket: sevenDay,
      shared: true,
      tier: null,
    }),
  );
  for (const [key, tier, name] of [
    ["seven_day_opus", "opus", "Opus"],
    ["seven_day_sonnet", "sonnet", "Sonnet"],
  ] as const) {
    push(
      windowLimit({
        id: `claude:7d:${tier}`,
        label: `7 Day (${name})`,
        windowId: "7d",
        durationMs: WEEK_MS,
        bucket: parseBucket(raw[key]),
        shared: false,
        tier,
      }),
    );
  }
  for (const g of generic) {
    if (g.kind !== "weekly_scoped" || !g.displayName) continue;
    const tier = slugify(g.displayName);
    if (!tier) continue;
    push(
      windowLimit({
        id: `claude:7d:${tier}`,
        label: `7 Day (${g.displayName})`,
        windowId: "7d",
        durationMs: WEEK_MS,
        bucket: g.bucket,
        shared: false,
        tier,
      }),
    );
  }
  push(buildClaudeExtraUsage(raw));

  const identity = payloadIdentity(raw);
  return {
    account: {
      accountId: identity.accountId ?? null,
      email: identity.email ?? null,
      planType,
    },
    limits,
    limitReached: null,
    canServe: null,
    creditOverage: false,
    credits: null,
  };
}

/**
 * Parse `anthropic-ratelimit-unified-{5h,7d,7d_oi}-{utilization,reset}`
 * inference headers. Utilization is a FRACTION (×100); reset is Unix SECONDS.
 * Header keys must be lower-cased by the caller (Headers objects already are).
 */
export function parseClaudeRateLimitHeaders(
  headers: Readonly<Record<string, string>>,
): AccountUsageLimit[] {
  const read = (w: string): Bucket | undefined => {
    const frac = toNumber(headers[`anthropic-ratelimit-unified-${w}-utilization`]);
    const reset = toNumber(headers[`anthropic-ratelimit-unified-${w}-reset`]);
    if (frac === undefined) return undefined;
    return {
      utilization: frac * 100,
      ...(reset !== undefined && reset > 0 ? { resetsAt: reset * 1000 } : {}),
    };
  };
  return [
    windowLimit({
      id: "claude:5h",
      label: "5 Hour",
      windowId: "5h",
      durationMs: 5 * HOUR_MS,
      bucket: read("5h"),
      shared: true,
      tier: null,
    }),
    windowLimit({
      id: "claude:7d",
      label: "7 Day",
      windowId: "7d",
      durationMs: WEEK_MS,
      bucket: read("7d"),
      shared: true,
      tier: null,
    }),
  ].filter((l): l is AccountUsageLimit => l !== null);
}
