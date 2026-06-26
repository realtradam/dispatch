/**
 * Pure argument validation for the web_search tool — input → output, no I/O.
 *
 * Resolves the operation mode (explicit, or inferred from `query`/`url`),
 * applies per-mode field requirements, clamps `limit`, and defaults `format`.
 * Returns a discriminated union so the tool's dispatch narrows by `mode`.
 */

export const MODES = ["search", "scrape", "crawl", "map"] as const;
export type Mode = (typeof MODES)[number];

export const FORMATS = ["markdown", "text", "html"] as const;
export type Format = (typeof FORMATS)[number];

export const SEARCH_DEFAULT_LIMIT = 7;
export const CRAWL_DEFAULT_LIMIT = 3;
export const MAX_LIMIT = 10;

interface BaseArgs {
  readonly format: Format;
}

export interface SearchArgs extends BaseArgs {
  readonly mode: "search";
  readonly query: string;
  readonly limit: number;
  readonly scrape: boolean;
  readonly lang?: string;
  readonly country?: string;
}

export interface ScrapeArgs extends BaseArgs {
  readonly mode: "scrape";
  readonly url: string;
}

export interface CrawlArgs extends BaseArgs {
  readonly mode: "crawl";
  readonly url: string;
  readonly limit: number;
}

export interface MapArgs extends BaseArgs {
  readonly mode: "map";
  readonly url: string;
}

export type ValidatedArgs = SearchArgs | ScrapeArgs | CrawlArgs | MapArgs;

export type ValidationError = { readonly error: string };

type Result<T> = { readonly value: T } | ValidationError;

function resolveFormat(raw: unknown): Result<Format> {
  if (raw === undefined || raw === null) {
    return { value: "markdown" };
  }
  if (typeof raw === "string" && (FORMATS as readonly string[]).includes(raw)) {
    return { value: raw as Format };
  }
  return {
    error: `Error: Invalid format "${String(raw)}" (must be one of: markdown, text, html).`,
  };
}

function resolveMode(raw: unknown, query: unknown, url: unknown): Result<Mode> {
  if (raw === undefined || raw === null) {
    const hasQuery = typeof query === "string" && query.trim().length > 0;
    const hasUrl = typeof url === "string" && url.trim().length > 0;
    return { value: hasQuery ? "search" : hasUrl ? "scrape" : "search" };
  }
  if (typeof raw === "string" && (MODES as readonly string[]).includes(raw)) {
    return { value: raw as Mode };
  }
  return {
    error: `Error: Invalid mode "${String(raw)}" (must be one of: search, scrape, crawl, map).`,
  };
}

function optionalString(raw: unknown, name: string): Result<string | undefined> {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  if (typeof raw === "string") {
    return { value: raw };
  }
  return { error: `Error: "${name}" must be a string.` };
}

function resolveLimit(raw: unknown, defaultLimit: number): Result<number> {
  if (raw === undefined || raw === null) {
    return { value: defaultLimit };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return { error: 'Error: "limit" must be a positive number.' };
  }
  return { value: Math.min(Math.floor(n), MAX_LIMIT) };
}

function resolveBoolean(raw: unknown, name: string): Result<boolean> {
  if (raw === undefined || raw === null) {
    return { value: false };
  }
  if (typeof raw === "boolean") {
    return { value: raw };
  }
  return { error: `Error: "${name}" must be a boolean.` };
}

/**
 * Validate raw tool args and resolve a typed, mode-aware `ValidatedArgs`.
 * Returns `{ error }` for invalid input — the tool surfaces it verbatim.
 */
export function validateArgs(args: unknown): ValidatedArgs | ValidationError {
  if (args === null || args === undefined || typeof args !== "object") {
    return { error: "Error: Arguments must be an object." };
  }
  const obj = args as Record<string, unknown>;

  const format = resolveFormat(obj.format);
  if ("error" in format) {
    return format;
  }

  const mode = resolveMode(obj.mode, obj.query, obj.url);
  if ("error" in mode) {
    return mode;
  }

  const query = optionalString(obj.query, "query");
  if ("error" in query) {
    return query;
  }

  const url = optionalString(obj.url, "url");
  if ("error" in url) {
    return url;
  }

  switch (mode.value) {
    case "search": {
      if (query.value === undefined || query.value.trim().length === 0) {
        return { error: "Error: query is required for search mode." };
      }
      const limit = resolveLimit(obj.limit, SEARCH_DEFAULT_LIMIT);
      if ("error" in limit) {
        return limit;
      }
      const scrape = resolveBoolean(obj.scrape, "scrape");
      if ("error" in scrape) {
        return scrape;
      }
      const lang = optionalString(obj.lang, "lang");
      if ("error" in lang) {
        return lang;
      }
      const country = optionalString(obj.country, "country");
      if ("error" in country) {
        return country;
      }
      const result: SearchArgs = {
        mode: "search",
        query: query.value,
        limit: limit.value,
        scrape: scrape.value,
        format: format.value,
        ...(lang.value !== undefined ? { lang: lang.value } : {}),
        ...(country.value !== undefined ? { country: country.value } : {}),
      };
      return result;
    }
    case "scrape": {
      if (url.value === undefined || url.value.trim().length === 0) {
        return { error: "Error: url is required for scrape mode." };
      }
      const result: ScrapeArgs = {
        mode: "scrape",
        url: url.value,
        format: format.value,
      };
      return result;
    }
    case "crawl": {
      if (url.value === undefined || url.value.trim().length === 0) {
        return { error: "Error: url is required for crawl mode." };
      }
      const limit = resolveLimit(obj.limit, CRAWL_DEFAULT_LIMIT);
      if ("error" in limit) {
        return limit;
      }
      const result: CrawlArgs = {
        mode: "crawl",
        url: url.value,
        limit: limit.value,
        format: format.value,
      };
      return result;
    }
    case "map": {
      if (url.value === undefined || url.value.trim().length === 0) {
        return { error: "Error: url is required for map mode." };
      }
      const result: MapArgs = {
        mode: "map",
        url: url.value,
        format: format.value,
      };
      return result;
    }
  }
}
