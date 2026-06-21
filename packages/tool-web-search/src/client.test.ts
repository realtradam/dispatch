import { describe, expect, it } from "vitest";
import { createFirecrawlClient, type FetchLike } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface CapturedCall {
	url: string;
	method?: string | undefined;
	body?: string | undefined;
}

/** Builds a fake fetch that returns scripted responses in order, capturing each call. */
function makeFetch(responses: Response[]): { fetchFn: FetchLike; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	let i = 0;
	const fetchFn: FetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({
			url,
			method: init?.method,
			body: typeof init?.body === "string" ? init.body : undefined,
		});
		return responses[i++] ?? jsonResponse({});
	}) as unknown as FetchLike;
	return { fetchFn, calls };
}

const BASE = "http://test-firecrawl.local/v1";
const signal = (): AbortSignal => new AbortController().signal;

describe("createFirecrawlClient.search", () => {
	it("sends POST /search with correct body", async () => {
		const { fetchFn, calls } = makeFetch([jsonResponse({ success: true, data: [] })]);
		const client = createFirecrawlClient({ baseUrl: BASE, fetchFn });
		await client.search({ query: "hello", limit: 7 }, signal());

		const call = calls[0];
		if (!call) throw new Error("no call captured");
		expect(call.url).toBe(`${BASE}/search`);
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body ?? "{}")).toEqual({ query: "hello", limit: 7 });
	});

	it("returns parsed data on success", async () => {
		const data = [{ title: "T", url: "http://x", description: "d" }];
		const { fetchFn } = makeFetch([jsonResponse({ success: true, data })]);
		const client = createFirecrawlClient({ baseUrl: BASE, fetchFn });
		const result = await client.search({ query: "hello", limit: 7 }, signal());
		expect(result).toEqual(data);
	});

	it("throws on !success", async () => {
		const { fetchFn } = makeFetch([jsonResponse({ success: false, error: "boom" })]);
		const client = createFirecrawlClient({ baseUrl: BASE, fetchFn });
		await expect(client.search({ query: "x", limit: 7 }, signal())).rejects.toThrow("boom");
	});
});

describe("createFirecrawlClient.scrape", () => {
	it("sends POST /scrape with correct body", async () => {
		const { fetchFn, calls } = makeFetch([
			jsonResponse({ success: true, data: { markdown: "md", metadata: { title: "T" } } }),
		]);
		const client = createFirecrawlClient({ baseUrl: BASE, fetchFn });
		await client.scrape({ url: "http://x", formats: ["markdown"] }, signal());

		const call = calls[0];
		if (!call) throw new Error("no call captured");
		expect(call.url).toBe(`${BASE}/scrape`);
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body ?? "{}")).toEqual({
			url: "http://x",
			formats: ["markdown"],
			onlyMainContent: true,
		});
	});
});

describe("createFirecrawlClient.crawl", () => {
	it("polls status URL until completed", async () => {
		const { fetchFn, calls } = makeFetch([
			jsonResponse({ success: true, url: `${BASE}/crawl/status/123` }),
			jsonResponse({ status: "scraping" }),
			jsonResponse({
				status: "completed",
				data: [{ markdown: "p1", metadata: { title: "P1", sourceURL: "http://p1" } }],
			}),
		]);
		const client = createFirecrawlClient({
			baseUrl: BASE,
			fetchFn,
			sleep: async () => {},
		});
		const pages = await client.crawl(
			{ url: "http://site", limit: 3, formats: ["markdown"] },
			signal(),
		);
		expect(pages).toEqual([{ markdown: "p1", metadata: { title: "P1", sourceURL: "http://p1" } }]);
		expect(calls.length).toBe(3);
	});

	it("returns data when completed", async () => {
		const { fetchFn } = makeFetch([
			jsonResponse({ success: true, url: `${BASE}/crawl/status/123` }),
			jsonResponse({
				status: "completed",
				data: [{ markdown: "page", metadata: { title: "T" } }],
			}),
		]);
		const client = createFirecrawlClient({
			baseUrl: BASE,
			fetchFn,
			sleep: async () => {},
		});
		const pages = await client.crawl(
			{ url: "http://site", limit: 3, formats: ["markdown"] },
			signal(),
		);
		expect(pages.length).toBe(1);
		expect(pages[0]?.markdown).toBe("page");
	});

	it("throws when status is failed", async () => {
		const { fetchFn } = makeFetch([
			jsonResponse({ success: true, url: `${BASE}/crawl/status/123` }),
			jsonResponse({ status: "failed", error: "boom" }),
		]);
		const client = createFirecrawlClient({
			baseUrl: BASE,
			fetchFn,
			sleep: async () => {},
		});
		await expect(
			client.crawl({ url: "http://site", limit: 3, formats: ["markdown"] }, signal()),
		).rejects.toThrow("failed");
	});

	it("respects abort signal (stops polling)", async () => {
		const controller = new AbortController();
		const { fetchFn, calls } = makeFetch([
			jsonResponse({ success: true, url: `${BASE}/crawl/status/123` }),
		]);
		const client = createFirecrawlClient({
			baseUrl: BASE,
			fetchFn,
			sleep: async (_ms, sig) => {
				controller.abort();
				if (sig.aborted) throw new Error("Request aborted.");
			},
		});
		await expect(
			client.crawl({ url: "http://site", limit: 3, formats: ["markdown"] }, controller.signal),
		).rejects.toThrow();
		expect(calls.length).toBe(1);
	});
});

describe("createFirecrawlClient.map", () => {
	it("sends POST /map and returns links", async () => {
		const { fetchFn, calls } = makeFetch([
			jsonResponse({ success: true, links: ["http://a", "http://b"] }),
		]);
		const client = createFirecrawlClient({ baseUrl: BASE, fetchFn });
		const links = await client.map("http://site", signal());
		expect(links).toEqual(["http://a", "http://b"]);

		const call = calls[0];
		if (!call) throw new Error("no call captured");
		expect(call.url).toBe(`${BASE}/map`);
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body ?? "{}")).toEqual({ url: "http://site" });
	});
});

describe("createFirecrawlClient.request (error paths)", () => {
	it("throws on HTTP error", async () => {
		const { fetchFn } = makeFetch([
			new Response("not found", { status: 404, statusText: "Not Found" }),
		]);
		const client = createFirecrawlClient({ baseUrl: BASE, fetchFn });
		await expect(client.search({ query: "x", limit: 7 }, signal())).rejects.toThrow("HTTP 404");
	});

	it("throws on timeout", async () => {
		const fetchFn: FetchLike = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const sig = init?.signal;
				if (!sig) return;
				sig.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			})) as unknown as FetchLike;
		const client = createFirecrawlClient({
			baseUrl: BASE,
			fetchFn,
			timeoutMs: 10,
		});
		await expect(client.search({ query: "x", limit: 7 }, signal())).rejects.toThrow("timed out");
	});
});
