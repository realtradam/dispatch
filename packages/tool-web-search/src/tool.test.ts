import type { ToolExecuteContext } from "@dispatch/kernel";
import { createLogger } from "@dispatch/kernel";
import type { SearchBackend, SearchHit, SearchResponse } from "@dispatch/search-backend-contract";
import { describe, expect, it } from "vitest";
import type { FirecrawlClient } from "./client.js";
import { createWebSearchTool } from "./tool.js";

function stubCtx(): ToolExecuteContext {
  return {
    toolCallId: "test-call-1",
    onOutput: () => {},
    signal: new AbortController().signal,
    log: createLogger(
      { extensionId: "test" },
      { emit: () => {} },
      { now: () => 0, newId: () => "id" },
    ),
  };
}

function fakeBackend(
  id: string,
  response: SearchResponse,
): { backend: SearchBackend; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    backend: {
      id,
      label: id,
      search: async (params) => {
        queries.push(params.query);
        return response;
      },
    },
  };
}

/** A FirecrawlClient fake that records which methods were hit. */
function fakeFirecrawlClient(): {
  client: FirecrawlClient;
  methods: string[];
} {
  const methods: string[] = [];
  return {
    methods,
    client: {
      search: async () => {
        methods.push("search");
        return [];
      },
      scrape: async () => {
        methods.push("scrape");
        return { data: { markdown: "# T", metadata: { title: "T" } } };
      },
      crawl: async () => {
        methods.push("crawl");
        return [];
      },
    },
  };
}

const HITS: SearchHit[] = [{ title: "T", url: "http://a", description: "d" }];

const SEARCH_DISABLED_REFUSAL =
  "Error: search is disabled — no search backend is selected or the selected backend is unavailable. Scrape and crawl modes remain available.";

describe("createWebSearchTool — search-backend resolution", () => {
  it("search mode routes to the resolved backend and formats its hits", async () => {
    const { backend, queries } = fakeBackend("codex", { hits: HITS });
    const { client, methods } = fakeFirecrawlClient();
    const tool = createWebSearchTool({
      client,
      resolveSearchBackend: () => Promise.resolve(backend),
    });
    const result = await tool.execute({ query: "hello", limit: 3 }, stubCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("### T");
    expect(queries).toEqual(["hello"]);
    expect(methods).toEqual([]); // Firecrawl untouched for search
  });

  it("passes a backend answer + hits through the formatter", async () => {
    const { backend } = fakeBackend("claude", {
      answer: "Synthesized answer.",
      hits: HITS,
    });
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({
      client,
      resolveSearchBackend: () => Promise.resolve(backend),
    });
    const result = await tool.execute({ query: "hello" }, stubCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Synthesized answer.");
    expect(result.content).toContain("## Sources");
    expect(result.content).toContain("### T");
  });

  it("search mode passes lang/country/scrape options through to the backend", async () => {
    const seen: unknown[] = [];
    const backend: SearchBackend = {
      id: "firecrawl",
      label: "x",
      search: async (params) => {
        seen.push(params);
        return { hits: [] };
      },
    };
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({
      client,
      resolveSearchBackend: () => Promise.resolve(backend),
    });
    await tool.execute(
      { query: "q", scrape: true, lang: "en", country: "us", limit: 5 },
      stubCtx(),
    );
    expect(seen[0]).toMatchObject({
      query: "q",
      limit: 5,
      lang: "en",
      country: "us",
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
  });

  it("null resolution ('none') → the exact search-disabled refusal", async () => {
    const { client, methods } = fakeFirecrawlClient();
    const tool = createWebSearchTool({ client, resolveSearchBackend: () => Promise.resolve(null) });
    const result = await tool.execute({ query: "hello" }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(SEARCH_DISABLED_REFUSAL);
    expect(methods).toEqual([]);
  });

  it("a missing resolver degrades to the same refusal (never throws)", async () => {
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({ client });
    const result = await tool.execute({ query: "hello" }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe(SEARCH_DISABLED_REFUSAL);
  });

  it("a backend failure surfaces as an isError result, never a throw", async () => {
    const backend: SearchBackend = {
      id: "firecrawl",
      label: "x",
      search: () => Promise.reject(new Error("boom")),
    };
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({
      client,
      resolveSearchBackend: () => Promise.resolve(backend),
    });
    const result = await tool.execute({ query: "hello" }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  it("scrape and crawl ALWAYS route to the Firecrawl client, regardless of the selection", async () => {
    const { backend } = fakeBackend("codex", { hits: HITS });
    const { client, methods } = fakeFirecrawlClient();
    const tool = createWebSearchTool({
      client,
      resolveSearchBackend: () => Promise.resolve(backend),
    });

    const scrape = await tool.execute({ url: "http://x", mode: "scrape" }, stubCtx());
    expect(scrape.isError).toBeFalsy();
    expect(scrape.content).toContain("# T");
    const crawl = await tool.execute({ url: "http://x", mode: "crawl", limit: 2 }, stubCtx());
    expect(crawl.isError).toBeFalsy();
    expect(methods).toEqual(["scrape", "crawl"]);
  });

  it("scrape/crawl keep working when search is disabled ('none')", async () => {
    const { client, methods } = fakeFirecrawlClient();
    const tool = createWebSearchTool({ client, resolveSearchBackend: () => Promise.resolve(null) });
    const scrape = await tool.execute({ url: "http://x", mode: "scrape" }, stubCtx());
    expect(scrape.isError).toBeFalsy();
    expect(methods).toEqual(["scrape"]);
  });

  it("the removed 'map' mode is now a validation error", async () => {
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({ client });
    const result = await tool.execute({ url: "http://x", mode: "map" }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid mode");
  });
});

describe("createWebSearchTool — description + schema", () => {
  it("uses the exact tool description", () => {
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({ client });
    expect(tool.description).toBe(
      "Access the web. 'search' runs a web search through the configured search backend and returns a synthesized answer and/or a list of sources (search may be disabled by configuration). 'scrape' fetches one page and 'crawl' recursively fetches a site, both through a self-hosted Firecrawl instance (always available).",
    );
  });

  it("appends the unsupported-by-backend note to scrape, lang and country", () => {
    const { client } = fakeFirecrawlClient();
    const tool = createWebSearchTool({ client });
    const props = tool.parameters.properties;
    expect(props?.scrape?.description).toMatch(/Not every search backend supports this\.$/);
    expect(props?.lang?.description).toMatch(/Not every search backend supports this\.$/);
    expect(props?.country?.description).toMatch(/Not every search backend supports this\.$/);
  });
});
