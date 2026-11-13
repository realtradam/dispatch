/**
 * Pure formatters for the web_search tool — input → output, no I/O.
 *
 * These mirror the proven opencode Firecrawl tool's formatting, isolated
 * (not imported) per the isolation-over-DRY rule. Tested directly with
 * zero mocks.
 */

import type { SearchHit, SearchResponse } from "@dispatch/search-backend-contract";

export type { SearchHit };

/** One page from a completed crawl (`/crawl` status `data`). */
export interface CrawlPage {
  readonly markdown?: string;
  readonly metadata?: {
    readonly title?: string;
    readonly sourceURL?: string;
    readonly url?: string;
  };
}

/** The scrape response payload (`/scrape` `data`). */
export interface ScrapeResult {
  readonly data?: {
    readonly markdown?: string;
    readonly metadata?: { readonly title?: string };
  };
}

/**
 * Truncate output to `cap` characters with a trailing notice, identical in
 * spirit to tool-shell. Duplication across features is the intended trade.
 */
export function truncateOutput(output: string, cap: number): string {
  if (output.length <= cap) {
    return output;
  }
  const truncated = output.slice(0, cap);
  return `${truncated}\n\n[Output truncated: exceeded ${cap} characters]`;
}

/** Format one hit: `### title\nurl`, then description / markdown when non-empty. */
function formatSearchHit(hit: SearchHit): string {
  let section = `### ${hit.title ?? "(no title)"}\n${hit.url ?? ""}`;
  if (typeof hit.description === "string" && hit.description.length > 0) {
    section += `\n\n${hit.description}`;
  }
  if (hit.markdown !== undefined && hit.markdown.length > 0) {
    section += `\n\n${hit.markdown}`;
  }
  return section;
}

/**
 * Format a search response. Hits are `### title\nurl` sections (plus a
 * non-empty description / markdown) joined by `---`. A synthesized answer is
 * prepended, followed by a `## Sources` section when there are hits.
 *
 * - no answer, no hits → `"No results found."`
 * - no answer, hits → the joined hits
 * - answer, no hits → the trimmed answer
 * - answer and hits → `answer\n\n---\n\n## Sources\n\n` + joined hits
 *
 * An answer that is empty after trimming counts as no answer.
 */
export function formatSearchResults(response: SearchResponse | null | undefined): string {
  const hits = response?.hits ?? [];
  const answer = response?.answer?.trim() ?? "";
  const hasAnswer = answer.length > 0;
  if (!hasAnswer && hits.length === 0) {
    return "No results found.";
  }
  const joined = hits.map(formatSearchHit).join("\n\n---\n\n");
  if (!hasAnswer) {
    return joined;
  }
  if (hits.length === 0) {
    return answer;
  }
  return `${answer}\n\n---\n\n## Sources\n\n${joined}`;
}

/**
 * Format a scrape response as `# title\n\nmarkdown`, omitting the header when
 * the title is absent.
 */
export function formatScrapeResult(json: ScrapeResult): string {
  const md = json.data?.markdown ?? "";
  const title = json.data?.metadata?.title;
  if (title) {
    return `# ${title}\n\n${md}`;
  }
  return md;
}

/**
 * Format crawled pages as `## title\nurl\n\nmarkdown` each, joined by `---`.
 * Empty → `"No pages crawled."`.
 */
export function formatCrawlResults(data: readonly CrawlPage[] | null | undefined): string {
  if (!data || data.length === 0) {
    return "No pages crawled.";
  }
  const parts: string[] = [];
  for (const page of data) {
    const title = page.metadata?.title ?? "(no title)";
    const url = page.metadata?.sourceURL ?? page.metadata?.url ?? "";
    let section = `## ${title}\n${url}`;
    if (page.markdown) {
      section += `\n\n${page.markdown}`;
    }
    parts.push(section);
  }
  return parts.join("\n\n---\n\n");
}
