/**
 * FirecrawlClient — the injected outermost edge for the web_search tool.
 *
 * All effects (fetch, sleep, clock) are injected so the pure decision logic
 * remains testable without real I/O. The factory builds four methods
 * (`search`, `scrape`, `crawl`, `map`) over a self-hosted Firecrawl instance
 * (no API key). `crawl` polls a status URL until the crawl completes or fails.
 */

import type { CrawlPage, ScrapeResult, SearchHit } from "./format.js";

export type FetchLike = typeof globalThis.fetch;

export const DEFAULT_BASE_URL = "http://100.102.55.49:31329/v1";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const CRAWL_POLL_MS = 2_000;
export const CRAWL_MAX_WAIT_MS = 5 * 60 * 1_000;

export interface SearchParams {
	readonly query: string;
	readonly limit: number;
	readonly lang?: string;
	readonly country?: string;
	readonly scrapeOptions?: {
		readonly formats: readonly string[];
		readonly onlyMainContent: boolean;
	};
}

export interface ScrapeParams {
	readonly url: string;
	readonly formats: readonly string[];
}

export interface CrawlParams {
	readonly url: string;
	readonly limit: number;
	readonly formats: readonly string[];
}

export interface FirecrawlClient {
	readonly search: (params: SearchParams, signal: AbortSignal) => Promise<readonly SearchHit[]>;
	readonly scrape: (params: ScrapeParams, signal: AbortSignal) => Promise<ScrapeResult>;
	readonly crawl: (params: CrawlParams, signal: AbortSignal) => Promise<readonly CrawlPage[]>;
	readonly map: (url: string, signal: AbortSignal) => Promise<readonly string[]>;
}

export interface FirecrawlClientDeps {
	readonly baseUrl: string;
	readonly fetchFn: FetchLike;
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	readonly maxWaitMs?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface SearchResponse {
	readonly success: boolean;
	readonly data?: readonly SearchHit[];
	readonly error?: string;
}

interface ScrapeResponse {
	readonly success: boolean;
	readonly data?: {
		readonly markdown?: string;
		readonly metadata?: { readonly title?: string };
	};
	readonly error?: string;
}

interface CrawlStartResponse {
	readonly success: boolean;
	readonly url?: string;
	readonly error?: string;
}

interface CrawlStatusResponse {
	readonly status: string;
	readonly data?: readonly CrawlPage[];
	readonly error?: string;
}

interface MapResponse {
	readonly success: boolean;
	readonly links?: readonly string[];
	readonly error?: string;
}

/** Default sleep: resolve after `ms`, reject on abort. */
async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Request aborted."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			reject(new Error("Request aborted."));
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Create a FirecrawlClient. Each method builds a fetch request, calls the
 * injected `fetchFn`, and handles HTTP + JSON errors. The per-request timeout
 * is combined with the caller's cancellation signal via `AbortSignal.any`.
 */
export function createFirecrawlClient(deps: FirecrawlClientDeps): FirecrawlClient {
	const baseUrl = deps.baseUrl;
	const fetchFn = deps.fetchFn;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollMs = deps.pollMs ?? CRAWL_POLL_MS;
	const maxWaitMs = deps.maxWaitMs ?? CRAWL_MAX_WAIT_MS;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;

	async function request(
		method: "POST" | "GET",
		url: string,
		body: unknown,
		signal: AbortSignal,
	): Promise<unknown> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const combined = AbortSignal.any([signal, controller.signal]);
		try {
			let response: Response;
			try {
				response = await fetchFn(url, {
					method,
					headers:
						body !== undefined
							? { "Content-Type": "application/json", Accept: "application/json" }
							: { Accept: "application/json" },
					body: body !== undefined ? JSON.stringify(body) : undefined,
					signal: combined,
				});
			} catch (err) {
				if (signal.aborted) {
					throw new Error("Request aborted.");
				}
				if (controller.signal.aborted) {
					throw new Error(`Firecrawl request timed out after ${timeoutMs / 1000} seconds.`);
				}
				throw err;
			}
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
			}
			try {
				return await response.json();
			} catch {
				throw new Error("Failed to parse Firecrawl response as JSON");
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	async function post(endpoint: string, body: unknown, signal: AbortSignal): Promise<unknown> {
		return request("POST", `${baseUrl}/${endpoint}`, body, signal);
	}

	return {
		async search(params: SearchParams, signal: AbortSignal): Promise<readonly SearchHit[]> {
			const body: Record<string, unknown> = { query: params.query, limit: params.limit };
			if (params.lang !== undefined) {
				body.lang = params.lang;
			}
			if (params.country !== undefined) {
				body.country = params.country;
			}
			if (params.scrapeOptions !== undefined) {
				body.scrapeOptions = params.scrapeOptions;
			}
			const json = (await post("search", body, signal)) as SearchResponse;
			if (!json.success) {
				throw new Error(json.error ?? "Unknown error");
			}
			return json.data ?? [];
		},

		async scrape(params: ScrapeParams, signal: AbortSignal): Promise<ScrapeResult> {
			const body = {
				url: params.url,
				formats: params.formats,
				onlyMainContent: true,
			};
			const json = (await post("scrape", body, signal)) as ScrapeResponse;
			if (!json.success) {
				throw new Error(json.error ?? "Unknown error");
			}
			return json;
		},

		async crawl(params: CrawlParams, signal: AbortSignal): Promise<readonly CrawlPage[]> {
			const body = {
				url: params.url,
				limit: params.limit,
				scrapeOptions: { formats: params.formats, onlyMainContent: true },
			};
			const startJson = (await post("crawl", body, signal)) as CrawlStartResponse;
			if (!startJson.success) {
				throw new Error(startJson.error ?? "Unknown error");
			}
			const statusUrl = startJson.url;
			if (statusUrl === undefined) {
				throw new Error("crawl response missing status URL.");
			}
			const started = now();
			while (now() - started < maxWaitMs) {
				await sleep(pollMs, signal);
				const status = (await request("GET", statusUrl, undefined, signal)) as CrawlStatusResponse;
				if (status.status === "completed") {
					return status.data ?? [];
				}
				if (status.status === "failed") {
					throw new Error(`crawl failed: ${status.error ?? "unknown"}`);
				}
			}
			throw new Error("crawl timed out waiting for completion.");
		},

		async map(url: string, signal: AbortSignal): Promise<readonly string[]> {
			const json = (await post("map", { url }, signal)) as MapResponse;
			if (!json.success) {
				throw new Error(json.error ?? "Unknown error");
			}
			return json.links ?? [];
		},
	};
}
