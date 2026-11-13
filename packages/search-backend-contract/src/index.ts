/**
 * @dispatch/search-backend-contract — the typed seam between the `web_search`
 * tool and whatever engine backs its *search* mode.
 *
 * A search backend implements {@link SearchBackend}: an id + label (the
 * Settings dropdown entry) and one `search` method. Scrape/crawl are NOT part
 * of the selection — they always route to the self-hosted Firecrawl client —
 * so a backend only ever speaks search.
 *
 * This package also carries the registry handle ({@link searchBackendRegistryHandle})
 * every backend registers into. It is therefore no longer zero-dependency: it
 * depends on `@dispatch/kernel` for `defineService`/`ServiceHandle` (precedent:
 * `@dispatch/layout-provider-contract`).
 */

/** One search hit — shared by every backend and the tool's formatter. */
export interface SearchHit {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
  readonly markdown?: string;
}

/** Parameters for a single search call. */
export interface SearchParams {
  readonly query: string;
  readonly limit: number;
  readonly lang?: string;
  readonly country?: string;
  /**
   * When present, the backend SHOULD also fetch the full markdown of each hit
   * (`scrape` mode of the tool). Backends that cannot scrape inline ignore it.
   */
  readonly scrapeOptions?: {
    readonly formats: readonly string[];
    readonly onlyMainContent: boolean;
  };
}

/** What one search call returns. */
export interface SearchResponse {
  readonly hits: readonly SearchHit[];
  /**
   * A synthesized prose answer. Set only by LLM-backed backends (claude,
   * codex); index-style backends (firecrawl) leave it absent.
   */
  readonly answer?: string;
}

/**
 * A selectable search backend for the `web_search` tool's search mode.
 * `id` is the persisted config value; `label` is the human-facing dropdown
 * entry. `search` resolves a query to a {@link SearchResponse} — implementations
 * own their own I/O (fetch) and must honor the caller's abort signal.
 */
export interface SearchBackend {
  readonly id: string;
  readonly label: string;
  search(params: SearchParams, signal: AbortSignal): Promise<SearchResponse>;
}

/**
 * The explicit off state for the global search config. Selecting it disables
 * the tool's search mode (a clean `isError` result); scrape/crawl keep working.
 */
export const SEARCH_BACKEND_NONE = "none";

/**
 * Preference order used while NO backend has been explicitly selected: the
 * first id in this list that is registered is the active backend.
 */
export const DEFAULT_SEARCH_BACKEND_ORDER: readonly string[] = ["claude", "codex", "firecrawl"];

export { type SearchBackendRegistry, searchBackendRegistryHandle } from "./handle.js";
