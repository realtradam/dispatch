/**
 * Pure formatters for the web_search tool — input → output, no I/O.
 *
 * These mirror the proven opencode Firecrawl tool's formatting, isolated
 * (not imported) per the isolation-over-DRY rule. Tested directly with
 * zero mocks.
 */

/** A single search hit from Firecrawl's `/search` endpoint. */
export interface SearchHit {
	readonly title?: string;
	readonly url?: string;
	readonly description?: string;
	readonly markdown?: string;
}

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

/**
 * Format search hits as `### title\nurl\n\ndescription` (+ optional markdown),
 * joined by `---` separators. Empty → `"No results found."`.
 */
export function formatSearchResults(data: readonly SearchHit[] | null | undefined): string {
	if (!data || data.length === 0) {
		return "No results found.";
	}
	const parts: string[] = [];
	for (const r of data) {
		const title = r.title ?? "(no title)";
		const url = r.url ?? "";
		const description = r.description ?? "";
		let section = `### ${title}\n${url}\n\n${description}`;
		if (r.markdown) {
			section += `\n\n${r.markdown}`;
		}
		parts.push(section);
	}
	return parts.join("\n\n---\n\n");
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

/**
 * Format discovered links as a bullet list. Empty → `"No links found."`.
 */
export function formatMapResults(links: readonly string[] | null | undefined): string {
	if (!links || links.length === 0) {
		return "No links found.";
	}
	return links.map((l) => `- ${l}`).join("\n");
}
