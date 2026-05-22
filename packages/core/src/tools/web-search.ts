import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

const FIRECRAWL_URL = "http://100.102.55.49:31329/v1/search";
const MAX_OUTPUT_CHARS = 60000;
const TIMEOUT_MS = 30000;

export function createWebSearchTool(): ToolDefinition {
	return {
		name: "web_search",
		description:
			"Search the web via a self-hosted Firecrawl instance. Returns a list of results with titles, URLs, and descriptions. Optionally scrapes the full markdown content of each result page.",
		parameters: z.object({
			query: z.string().describe("The search query"),
			limit: z
				.number()
				.optional()
				.default(7)
				.describe("Maximum number of results to return (default 7)"),
			scrape: z
				.boolean()
				.optional()
				.default(false)
				.describe("Whether to also scrape the full markdown content of each result page"),
			lang: z.string().optional().describe('Language code to filter results (e.g. "en")'),
			country: z.string().optional().describe('Country code to filter results (e.g. "us")'),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const query = args.query as string;
			const limit = (args.limit as number | undefined) ?? 7;
			const scrape = (args.scrape as boolean | undefined) ?? false;
			const lang = args.lang as string | undefined;
			const country = args.country as string | undefined;

			const body: Record<string, unknown> = { query, limit };
			if (lang !== undefined) body.lang = lang;
			if (country !== undefined) body.country = country;
			if (scrape) {
				body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

			let response: Response;
			try {
				response = await fetch(FIRECRAWL_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					return "Error: Request to Firecrawl timed out after 30 seconds.";
				}
				if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					return `Error: Could not connect to Firecrawl at http://100.102.55.49:31329. Is it running?`;
				}
				return `Error: ${err instanceof Error ? err.message : String(err)}`;
			} finally {
				clearTimeout(timeout);
			}

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				return `Error: Firecrawl returned HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
			}

			let json: {
				data?: Array<{ title?: string; url?: string; description?: string; markdown?: string }>;
			};
			try {
				json = await response.json();
			} catch {
				return "Error: Failed to parse Firecrawl response as JSON";
			}

			const results = json.data ?? [];
			if (results.length === 0) {
				return "No results found.";
			}

			const parts: string[] = [];
			for (const result of results) {
				const title = result.title ?? "(no title)";
				const url = result.url ?? "";
				const description = result.description ?? "";
				let section = `### ${title}\n${url}\n\n${description}`;
				if (result.markdown) {
					section += `\n\n${result.markdown}`;
				}
				parts.push(section);
			}

			let output = parts.join("\n\n---\n\n");
			if (output.length > MAX_OUTPUT_CHARS) {
				output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated]`;
			}
			return output;
		},
	};
}
