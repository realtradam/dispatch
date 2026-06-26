/**
 * web_search tool factory — the imperative shell that binds the pure
 * validate/format functions to the injected FirecrawlClient edge.
 *
 * Mirrors the tool-shell pattern: factory + injected dep + pure helpers +
 * a `ToolResult` returned per call. Errors surface as `{ isError: true }`
 * rather than thrown, so the model can react to the message.
 */

import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import type { FirecrawlClient } from "./client.js";
import {
  formatCrawlResults,
  formatMapResults,
  formatScrapeResult,
  formatSearchResults,
  truncateOutput,
} from "./format.js";
import type { ValidatedArgs } from "./validate.js";
import { validateArgs } from "./validate.js";

const OUTPUT_CAP = 50_000;

export interface WebSearchToolDeps {
  readonly client: FirecrawlClient;
  readonly outputCap?: number;
}

/** Dispatch validated args to the right client method and format the result. */
async function runMode(
  validated: ValidatedArgs,
  client: FirecrawlClient,
  signal: AbortSignal,
): Promise<string> {
  switch (validated.mode) {
    case "search": {
      const hits = await client.search(
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
    case "map": {
      const links = await client.map(validated.url, signal);
      return formatMapResults(links);
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
      "Access the web via a self-hosted Firecrawl instance. Supports search, " +
      "single-page scrape, site crawling, and sitemap discovery.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query (search mode)." },
        url: { type: "string", description: "A URL to scrape, crawl, or map." },
        mode: {
          type: "string",
          enum: ["search", "scrape", "crawl", "map"],
          description:
            "Operation mode. 'search' (default when query present), 'scrape' " +
            "(default when url present), 'crawl' (recursively scrape pages from a site), " +
            "'map' (discover URLs on a site).",
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
        const output = await runMode(validated, client, ctx.signal);
        span.end();
        return { content: truncateOutput(output, cap) };
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
