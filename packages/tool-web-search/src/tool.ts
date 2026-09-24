/**
 * web_search tool factory — the imperative shell that binds the pure
 * validate/format functions to the injected FirecrawlClient edge.
 *
 * Mirrors the tool-shell pattern: factory + injected dep + pure helpers +
 * a `ToolResult` returned per call. Errors surface as `{ isError: true }`
 * rather than thrown, so the model can react to the message.
 *
 * Scrape/crawl always route to the injected Firecrawl client (keyless,
 * self-hosted). Search mode resolves the ACTIVE search backend per call via
 * the injected `resolveSearchBackend` (the global config decides) — `null`
 * (the `"none"` off state / nothing registered) refuses search cleanly while
 * scrape/crawl keep working.
 */

import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import type { SearchBackend } from "@dispatch/search-backend-contract";
import type { FirecrawlClient } from "./client.js";
import {
  formatCrawlResults,
  formatScrapeResult,
  formatSearchResults,
  truncateOutput,
} from "./format.js";
import type { ValidatedArgs } from "./validate.js";
import { validateArgs } from "./validate.js";

const OUTPUT_CAP = 50_000;

/** Prefix marking the deliberate search-disabled refusal (see `execute`). */
const SEARCH_DISABLED_PREFIX = "Error: search is disabled";

export interface WebSearchToolDeps {
  /**
   * The always-on Firecrawl client — scrape/crawl route here regardless of
   * the search-backend selection.
   */
  readonly client: FirecrawlClient;
  /**
   * Resolve the ACTIVE search backend for search mode, per call (the global
   * config decides; the extension wires the real resolver; tests inject a
   * fake). `null` (the `"none"` off state / nothing registered) → search
   * refuses with a clean `isError` result. Optional: when absent, search
   * degrades to the same refusal.
   */
  readonly resolveSearchBackend?: () => Promise<SearchBackend | null>;
  readonly outputCap?: number;
}

/** Dispatch validated args to the right client method and format the result. */
async function runMode(
  validated: ValidatedArgs,
  client: FirecrawlClient,
  resolveSearchBackend: (() => Promise<SearchBackend | null>) | undefined,
  signal: AbortSignal,
): Promise<string> {
  switch (validated.mode) {
    case "search": {
      const backend = resolveSearchBackend === undefined ? null : await resolveSearchBackend();
      if (backend === null) {
        return "Error: search is disabled — no search backend is selected. Scrape and crawl modes remain available.";
      }
      const hits = await backend.search(
        {
          query: validated.query,
          limit: validated.limit,
          ...(validated.scrape
            ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }
            : {}),
          ...(validated.lang !== undefined ? { lang: validated.lang } : {}),
          ...(validated.country !== undefined ? { country: validated.country } : {}),
        },
        signal,
      );
      return formatSearchResults(hits);
    }
    case "scrape": {
      const result = await client.scrape(
        { url: validated.url, formats: [validated.format] },
        signal,
      );
      return formatScrapeResult(result);
    }
    case "crawl": {
      const pages = await client.crawl(
        { url: validated.url, limit: validated.limit, formats: [validated.format] },
        signal,
      );
      return formatCrawlResults(pages);
    }
  }
}

/**
 * Create the `web_search` tool. `concurrencySafe: true` — web search is
 * idempotent and safe to run alongside other tools. The `network` capability
 * is declared on the extension manifest (not the tool contract).
 */
export function createWebSearchTool(deps: WebSearchToolDeps): ToolContract {
  const client = deps.client;
  const cap = deps.outputCap ?? OUTPUT_CAP;

  return {
    name: "web_search",
    description:
      "Access the web via a self-hosted Firecrawl instance. Supports single-page " +
      "scrape and site crawling (always available), plus search — search is backed " +
      "by a selectable search backend and may be disabled by configuration.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query (search mode)." },
        url: { type: "string", description: "A URL to scrape or crawl." },
        mode: {
          type: "string",
          enum: ["search", "scrape", "crawl"],
          description:
            "Operation mode. 'search' (default when query present), 'scrape' " +
            "(default when url present), 'crawl' (recursively scrape pages from a site).",
        },
        limit: {
          type: "number",
          description: "Max results. Search: default 7, max 10. Crawl: default 3, max 10.",
        },
        scrape: {
          type: "boolean",
          description: "When searching, also scrape full markdown content of each result page.",
        },
        lang: {
          type: "string",
          description: 'Language code to filter search results (e.g. "en", "ja").',
        },
        country: {
          type: "string",
          description: 'Country code to filter search results (e.g. "us", "jp").',
        },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Format for scrape/crawl output (default: markdown).",
        },
      },
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
      const validated = validateArgs(args);
      if ("error" in validated) {
        return { content: validated.error, isError: true };
      }
      const span = ctx.log.span("web_search.execute", { mode: validated.mode });
      try {
        const output = await runMode(validated, client, deps.resolveSearchBackend, ctx.signal);
        span.end();
        // The search-disabled refusal is a clean, deliberate state (not a
        // thrown failure) — surface it as an error result so the model reacts
        // instead of treating the message as data.
        return {
          content: truncateOutput(output, cap),
          ...(output.startsWith(SEARCH_DISABLED_PREFIX) ? { isError: true } : {}),
        };
      } catch (err: unknown) {
        span.end({ err });
        return {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
