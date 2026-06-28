import type { ProviderUsage } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";

/**
 * Generic OpenAI-compatible usage fetch. The Umans `/v1/usage` endpoint returns:
 *
 *   { usage: { concurrent_sessions: number }, limits: { concurrency: { limit, hard_cap } } }
 *
 * We extract only `concurrent_sessions` (the count a concurrency limiter gates
 * on). Lives in this library (`@dispatch/openai-stream`) so any OpenAI-compatible
 * provider extension reuses it without cross-extension code import
 * (isolation-over-DRY: coupling is via this typed library surface). A provider
 * supplies its own `id` (used in error labels) via `createOpenAICompatProvider`.
 */

/** The raw shape of the `/v1/usage` response (only the fields we read). */
interface UsageResponse {
  readonly usage?: {
    readonly concurrent_sessions?: number;
  };
}

export interface GetUsageConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly fetchFn?: FetchLike;
  readonly providerId: string;
}

/**
 * Fetch + map the upstream usage snapshot. Returns `undefined` on any error,
 * non-200, or unexpected shape so the caller (the concurrency limiter) falls
 * back to cooldown-only slot recycling (no usage gate) — never throws.
 *
 * Pure-ish I/O wrapper: the only effect is the injected fetch. Extracted for
 * direct unit testing with a fake fetch.
 */
export async function getUsage(config: GetUsageConfig): Promise<ProviderUsage | undefined> {
  const effectiveFetch: FetchLike = config.fetchFn ?? fetch;
  const url = `${config.baseURL}/usage`;

  let response: Response;
  try {
    response = await effectiveFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  } catch {
    // Network error — the upstream is unreachable; treat as "no usage info".
    return undefined;
  }

  if (!response.ok) {
    // 404 / 401 / 5xx — the endpoint is unsupported or rejected the request.
    return undefined;
  }

  let body: UsageResponse;
  try {
    body = (await response.json()) as UsageResponse;
  } catch {
    return undefined;
  }

  const raw = body.usage?.concurrent_sessions;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }

  return { concurrentSessions: Math.trunc(raw) };
}
