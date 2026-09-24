/**
 * The `umans` search backend — a search-only relay over Umans's
 * Anthropic-style `/v1/messages` chat API. Umans has NO standalone search
 * endpoint: web search is a server-side tool (`web_search_20250305`) the
 * model executes during generation. So one `search()` call runs a tiny LLM
 * turn — the raw query verbatim as the single user message, a small
 * `max_tokens`, and the server-side search tool attached — then parses the
 * structured search-result content blocks into `SearchHit[]`. The relay
 * model's prose answer is DISCARDED (hits only): the tool's output stays
 * byte-compatible with the Firecrawl path and never double-synthesizes.
 *
 * The search engine is fixed to `exa` via the `X-Umans-Websearch-Provider`
 * header (decided — no sub-provider config surface).
 *
 * Auth: `UMANS_API_KEY` + `UMANS_BASE_URL` (the same env the
 * `provider-umans` resolver reads; no key → the backend is listed as
 * not configured, never an error). A per-request timeout is combined with
 * the caller's abort signal (the relay is a full LLM turn — slower than a
 * direct search); failures surface as thrown errors the tool maps to
 * `isError` results, never a crash.
 */

import type { SearchBackend, SearchHit, SearchParams } from "@dispatch/search-backend-contract";

export const UMANS_BACKEND_ID = "umans";
export const UMANS_BACKEND_LABEL = "Umans (Exa)";

export const DEFAULT_UMANS_MODEL = "umans-flash";
export const DEFAULT_UMANS_MAX_USES = 5;
export const DEFAULT_UMANS_MAX_TOKENS = 1024;
export const DEFAULT_UMANS_TIMEOUT_MS = 60_000;

/** The web-search server-side tool type in the `/v1/messages` API. */
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
/** The decided (fixed) search engine provider header value. */
export const UMANS_WEBSEARCH_PROVIDER = "exa";

export type FetchLike = typeof globalThis.fetch;

export interface UmansBackendDeps {
  /** Umans API key (`UMANS_API_KEY`). */
  readonly apiKey: string;
  /**
   * Umans base URL (`UMANS_BASE_URL`, default the provider resolver's
   * `https://api.code.umans.ai/v1`). May or may not end with `/v1`.
   */
  readonly baseUrl: string;
  /** Relay model (default the tested `umans-flash`, NOT the chat default). */
  readonly model?: string;
  /** Per-request server-side search cap (default 5). */
  readonly maxUses?: number;
  readonly fetchFn: FetchLike;
  readonly timeoutMs?: number;
}

/** A `/v1/messages` request body (the subset the relay sends). */
export interface UmansRelayRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly { readonly role: "user"; readonly content: string }[];
  readonly tools: readonly { readonly type: string; readonly max_uses: number }[];
}

/**
 * Resolve the `/v1/messages` endpoint from the base URL: a base ending in
 * `/v1` (the provider resolver's shape) gets `/messages` appended; anything
 * else gets `/v1/messages`.
 */
export function umansMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

/** Build the relay request body for one search. */
export function buildUmansRelayRequest(
  params: SearchParams,
  model: string,
  maxUses: number,
  maxTokens: number,
): UmansRelayRequest {
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: params.query }],
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, max_uses: maxUses }],
  };
}

interface WebSearchResultBlock {
  readonly type?: string;
  readonly url?: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly description?: string;
  readonly page_age?: string;
}

interface ContentBlock {
  readonly type?: string;
  readonly content?: unknown;
}

/**
 * Parse a `/v1/messages` response's content blocks into `SearchHit[]` —
 * hits only; prose `text` blocks are discarded. The structured results live
 * in `web_search_tool_result` blocks whose `content` is a list of
 * `web_search_result` entries (url / title / snippet / page age). Robust to
 * shape drift: anything unrecognized is skipped, never a crash.
 */
export function parseUmansContentBlocks(content: unknown): SearchHit[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const block of content as ContentBlock[]) {
    if (block === null || typeof block !== "object") {
      continue;
    }
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) {
      continue;
    }
    for (const raw of block.content) {
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const result = raw as WebSearchResultBlock;
      if (result.type !== undefined && result.type !== "web_search_result") {
        continue;
      }
      const url = typeof result.url === "string" ? result.url : undefined;
      const title = typeof result.title === "string" ? result.title : undefined;
      if (url === undefined && title === undefined) {
        continue;
      }
      const snippet =
        typeof result.snippet === "string"
          ? result.snippet
          : typeof result.description === "string"
            ? result.description
            : undefined;
      const pageAge = typeof result.page_age === "string" ? result.page_age : undefined;
      const description =
        snippet !== undefined && pageAge !== undefined
          ? `${snippet} (${pageAge})`
          : (snippet ?? pageAge);
      hits.push({
        ...(title !== undefined ? { title } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(description !== undefined ? { description } : {}),
      });
    }
  }
  return hits;
}

/** The subset of the `/v1/messages` response the parser reads. */
interface UmansRelayResponse {
  readonly content?: unknown;
}

/**
 * Create the `umans` search backend. One `search()` = one relay LLM turn;
 * the structured search-result blocks map to `SearchHit[]` and the prose is
 * dropped.
 */
export function createUmansSearchBackend(deps: UmansBackendDeps): SearchBackend {
  const model = deps.model ?? DEFAULT_UMANS_MODEL;
  const maxUses = deps.maxUses ?? DEFAULT_UMANS_MAX_USES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UMANS_TIMEOUT_MS;
  const url = umansMessagesUrl(deps.baseUrl);
  const fetchFn = deps.fetchFn;

  return {
    id: UMANS_BACKEND_ID,
    label: UMANS_BACKEND_LABEL,
    async search(params: SearchParams, signal: AbortSignal): Promise<readonly SearchHit[]> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const combined = AbortSignal.any([signal, controller.signal]);
      try {
        let response: Response;
        try {
          response = await fetchFn(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "x-api-key": deps.apiKey,
              Authorization: `Bearer ${deps.apiKey}`,
              "X-Umans-Websearch-Provider": UMANS_WEBSEARCH_PROVIDER,
            },
            body: JSON.stringify(
              buildUmansRelayRequest(params, model, maxUses, DEFAULT_UMANS_MAX_TOKENS),
            ),
            signal: combined,
          });
        } catch (err) {
          if (signal.aborted) {
            throw new Error("Request aborted.");
          }
          if (controller.signal.aborted) {
            throw new Error(`Umans search relay timed out after ${timeoutMs / 1000} seconds.`);
          }
          throw err;
        }
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`,
          );
        }
        let json: UmansRelayResponse;
        try {
          json = (await response.json()) as UmansRelayResponse;
        } catch {
          throw new Error("Failed to parse Umans search relay response as JSON");
        }
        return parseUmansContentBlocks(json.content);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
