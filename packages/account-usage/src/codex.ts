/**
 * Codex (ChatGPT OAuth) subscription usage — PURE parsing + request building.
 *
 * Endpoint: `GET https://chatgpt.com/backend-api/wham/usage` (OAuth bearer +
 * `ChatGPT-Account-Id`). Window `used_percent` is a PERCENTAGE; reset is
 * `reset_at` (Unix seconds or ms) else `now + reset_after_seconds`.
 *
 * Mirrors oh-my-pi `packages/ai/src/usage/openai-codex.ts` +
 * `openai-codex-base-url.ts`.
 */
import type { AccountUsageCredits, AccountUsageLimit } from "@dispatch/transport-contract";
import {
  epochToMs,
  isRecord,
  nonEmptyString,
  type ProviderUsage,
  percentAmount,
  toBoolean,
  toNumber,
  usageStatus,
  windowLabelFromSeconds,
} from "./shared.js";

export const CODEX_ACCOUNT_BASE = "https://chatgpt.com/backend-api";
export const CODEX_USAGE_PATH = "wham/usage";
/** Version-locked Codex CLI fingerprint (mirrors codex-mimicry; expected to rot). */
export const CODEX_USER_AGENT = "codex_cli_rs/0.159.0 (external, cli)";

const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

/**
 * Account endpoints live on the canonical ChatGPT origin only. A
 * chatgpt.com / chat.openai.com override is normalized to `<origin>/backend-api`;
 * any other host (an inference proxy) falls back to the canonical base.
 */
export function normalizeCodexAccountBase(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) return CODEX_ACCOUNT_BASE;
  try {
    const url = new URL(trimmed);
    const host = url.host.toLowerCase();
    if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_ACCOUNT_BASE;
    return `${url.origin}/backend-api`;
  } catch {
    return CODEX_ACCOUNT_BASE;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

/** `chatgpt_account_id` + email from the access-token JWT (never logged). */
export function extractCodexIdentity(accessToken: string): {
  accountId?: string;
  email?: string;
} {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return {};
  const auth = payload[JWT_AUTH_CLAIM];
  const profile = payload[JWT_PROFILE_CLAIM];
  const accountId = isRecord(auth) ? nonEmptyString(auth.chatgpt_account_id) : undefined;
  const email = isRecord(profile) ? nonEmptyString(profile.email)?.toLowerCase() : undefined;
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

export function buildCodexUsageHeaders(
  accessToken: string,
  accountId: string | undefined,
): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "user-agent": CODEX_USER_AGENT,
    accept: "application/json",
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
  };
}

interface RawWindow {
  readonly usedPercent?: number;
  readonly windowSeconds?: number;
  readonly resetAt?: number;
  readonly resetAfterSeconds?: number;
}

function parseWindow(raw: unknown): RawWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const usedPercent = toNumber(raw.used_percent);
  // A zero-length window is Codex's placeholder for "no such window".
  const rawSeconds = toNumber(raw.limit_window_seconds);
  if (rawSeconds !== undefined && rawSeconds <= 0) return undefined;
  const windowSeconds = rawSeconds;
  const resetAt = toNumber(raw.reset_at);
  const resetAfterSeconds = toNumber(raw.reset_after_seconds);
  if (
    usedPercent === undefined &&
    windowSeconds === undefined &&
    resetAt === undefined &&
    resetAfterSeconds === undefined
  ) {
    return undefined;
  }
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(resetAfterSeconds !== undefined ? { resetAfterSeconds } : {}),
  };
}

export function resolveCodexReset(w: RawWindow, nowMs: number): number | null {
  if (w.resetAt !== undefined && w.resetAt > 0) return epochToMs(w.resetAt);
  if (w.resetAfterSeconds !== undefined) return nowMs + w.resetAfterSeconds * 1000;
  return null;
}

/**
 * Codex still serves this meter: credits fund a spent plan window, or an
 * explicit positive verdict (`allowed && !limit_reached`).
 */
function canServe(allowed?: boolean, limitReached?: boolean, creditOverage?: boolean): boolean {
  if (creditOverage === true && limitReached === true) return true;
  return allowed === true && limitReached === false;
}

function windowLimit(args: {
  id: string;
  key: "primary" | "secondary";
  labelPrefix?: string;
  window: RawWindow;
  tier: string | null;
  allowed?: boolean;
  limitReached?: boolean;
  creditOverage?: boolean;
  nowMs: number;
}): AccountUsageLimit | null {
  if (args.window.usedPercent === undefined) return null;
  const amount = percentAmount(args.window.usedPercent);
  const named =
    args.window.windowSeconds !== undefined
      ? windowLabelFromSeconds(args.window.windowSeconds)
      : {
          id: args.key,
          label: args.key === "primary" ? "Primary window" : "Secondary window",
        };
  let status = usageStatus(amount.usedFraction);
  // 100% plan utilization but Codex still serves (explicitly, or via credits):
  // keep the percentage, downgrade exhausted → warning.
  if (status === "exhausted" && canServe(args.allowed, args.limitReached, args.creditOverage)) {
    status = "warning";
  }
  return {
    id: args.id,
    label: args.labelPrefix ? `${args.labelPrefix} · ${named.label}` : named.label,
    kind: "window",
    windowId: named.id,
    shared: args.tier === null,
    tier: args.tier,
    durationMs: args.window.windowSeconds !== undefined ? args.window.windowSeconds * 1000 : null,
    resetsAt: resolveCodexReset(args.window, args.nowMs),
    ...amount,
    status,
  };
}

function additionalSlug(limitName?: string, meteredFeature?: string): string {
  const probe = `${limitName ?? ""} ${meteredFeature ?? ""}`.toLowerCase();
  if (probe.includes("spark") || probe.includes("bengalfox")) return "spark";
  const source = (meteredFeature ?? limitName ?? "extra").toLowerCase();
  return (
    source
      .replace(/^codex[-_]/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "extra"
  );
}

function additionalName(slug: string, limitName?: string): string {
  if (slug === "spark") return "Spark";
  if (limitName) return limitName;
  return slug.replace(
    /(^|-)([a-z])/g,
    (_m, sep: string, ch: string) => `${sep === "-" ? " " : ""}${ch.toUpperCase()}`,
  );
}

/** Plan credits fund overage ONLY for a spent plan window (never other meters). */
export function hasPlanCreditOverage(
  payload: Record<string, unknown>,
  planLimitReached: boolean | undefined,
): boolean {
  if (planLimitReached !== true) return false;
  const credits = isRecord(payload.credits) ? payload.credits : undefined;
  if (!credits) return false;
  if (credits.unlimited !== true && credits.has_credits !== true) return false;
  if (credits.overage_limit_reached === true) return false;
  const spend = isRecord(payload.spend_control) ? payload.spend_control : undefined;
  return spend?.reached !== true;
}

function parseCredits(payload: Record<string, unknown>): AccountUsageCredits | null {
  const c = isRecord(payload.credits) ? payload.credits : undefined;
  const s = isRecord(payload.spend_control) ? payload.spend_control : undefined;
  if (!c && !s) return null;
  return {
    hasCredits: c ? (toBoolean(c.has_credits) ?? null) : null,
    unlimited: c ? (toBoolean(c.unlimited) ?? null) : null,
    overageLimitReached: c ? (toBoolean(c.overage_limit_reached) ?? null) : null,
    balance: c ? (toNumber(c.balance) ?? null) : null,
    spendControlReached: s ? (toBoolean(s.reached) ?? null) : null,
  };
}

/**
 * Normalize one `/wham/usage` payload. Returns null when it carries neither a
 * plan `rate_limit` nor any additional meter.
 */
export function parseCodexUsagePayload(
  raw: unknown,
  nowMs: number,
  identity: { accountId?: string; email?: string } = {},
): ProviderUsage | null {
  if (!isRecord(raw)) return null;
  const rateLimit = isRecord(raw.rate_limit) ? raw.rate_limit : undefined;
  const additional = Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : [];
  if (!rateLimit && additional.length === 0) return null;

  const allowed = rateLimit ? toBoolean(rateLimit.allowed) : undefined;
  const limitReached = rateLimit ? toBoolean(rateLimit.limit_reached) : undefined;
  const creditOverage = hasPlanCreditOverage(raw, limitReached);

  const limits: AccountUsageLimit[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = rateLimit ? parseWindow(rateLimit[`${key}_window`]) : undefined;
    if (!w) continue;
    const l = windowLimit({
      id: `codex:${key}`,
      key,
      window: w,
      tier: null,
      ...(allowed !== undefined ? { allowed } : {}),
      ...(limitReached !== undefined ? { limitReached } : {}),
      creditOverage,
      nowMs,
    });
    if (l) limits.push(l);
  }

  for (const entry of additional) {
    if (!isRecord(entry) || !isRecord(entry.rate_limit)) continue;
    const limitName = nonEmptyString(entry.limit_name);
    const meteredFeature = nonEmptyString(entry.metered_feature);
    const slug = additionalSlug(limitName, meteredFeature);
    const name = additionalName(slug, limitName);
    const rl = entry.rate_limit;
    const xAllowed = toBoolean(rl.allowed);
    const xReached = toBoolean(rl.limit_reached);
    for (const key of ["primary", "secondary"] as const) {
      const w = parseWindow(rl[`${key}_window`]);
      if (!w) continue;
      // Independent meter: plan credits deliberately NOT applied.
      const l = windowLimit({
        id: `codex:${slug}:${key}`,
        key,
        labelPrefix: name,
        window: w,
        tier: slug,
        ...(xAllowed !== undefined ? { allowed: xAllowed } : {}),
        ...(xReached !== undefined ? { limitReached: xReached } : {}),
        nowMs,
      });
      if (l && !limits.some((x) => x.id === l.id)) limits.push(l);
    }
  }

  const planServe =
    allowed === undefined && limitReached === undefined
      ? null
      : canServe(allowed, limitReached, creditOverage);
  return {
    account: {
      accountId: identity.accountId ?? null,
      email: identity.email ?? null,
      planType: nonEmptyString(raw.plan_type) ?? null,
    },
    limits,
    limitReached: limitReached ?? null,
    canServe: planServe,
    creditOverage,
    credits: parseCredits(raw),
  };
}

/**
 * Parse `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`
 * inference headers (percent / minutes / Unix seconds). Header keys must be
 * lower-cased by the caller.
 */
export function parseCodexRateLimitHeaders(
  headers: Readonly<Record<string, string>>,
  nowMs: number,
  responseStatus?: number,
): AccountUsageLimit[] {
  // A successful inference response proves the account is serving requests.
  const served = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;
  const out: AccountUsageLimit[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const usedPercent = toNumber(headers[`x-codex-${key}-used-percent`]);
    if (usedPercent === undefined) continue;
    const minutes = toNumber(headers[`x-codex-${key}-window-minutes`]);
    // `window-minutes: 0` is Codex's placeholder for an absent window.
    if (minutes !== undefined && minutes <= 0) continue;
    const resetAt = toNumber(headers[`x-codex-${key}-reset-at`]);
    const resetAfterSeconds = toNumber(headers[`x-codex-${key}-reset-after-seconds`]);
    const l = windowLimit({
      id: `codex:${key}`,
      key,
      window: {
        usedPercent,
        ...(minutes !== undefined ? { windowSeconds: minutes * 60 } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
        ...(resetAfterSeconds !== undefined ? { resetAfterSeconds } : {}),
      },
      tier: null,
      ...(served ? { allowed: true, limitReached: false } : {}),
      nowMs,
    });
    if (l) out.push(l);
  }
  return out;
}
