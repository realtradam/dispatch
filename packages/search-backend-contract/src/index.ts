/**
 * @dispatch/search-backend-contract — the typed seam between the `web_search`
 * tool and whatever engine backs its *search* mode.
 *
 * A search backend implements {@link SearchBackend}: an id + label (the
 * Settings dropdown entry) and one `search` method. Scrape/crawl are NOT part
 * of the selection — they always route to the self-hosted Firecrawl client —
 * so a backend only ever speaks search.
 *
 * Types-only package (mirrors `wire`): zero runtime, zero `@dispatch/*`
 * dependencies, so every consumer (tool, extension, future backends) can
 * depend on it without pulling the kernel.
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

/**
 * A selectable search backend for the `web_search` tool's search mode.
 * `id` is the persisted config value; `label` is the human-facing dropdown
 * entry. `search` resolves a query to hits — implementations own their own
 * I/O (fetch) and must honor the caller's abort signal.
 */
export interface SearchBackend {
  /** The stable config id: `"firecrawl"` | `"umans"` | future backends. */
  readonly id: string;
  /** The human-facing label (the Settings dropdown entry). */
  readonly label: string;
  search(params: SearchParams, signal: AbortSignal): Promise<readonly SearchHit[]>;
}

/**
 * The explicit off state for the global search config. Selecting it disables
 * the tool's search mode (a clean `isError` result); scrape/crawl keep working.
 */
export const SEARCH_BACKEND_NONE = "none";

/** The default backend id (today's behavior — the zero-migration default). */
export const DEFAULT_SEARCH_BACKEND = "firecrawl";
