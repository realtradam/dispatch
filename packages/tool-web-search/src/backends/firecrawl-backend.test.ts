import { describe, expect, it } from "vitest";
import type { FirecrawlClient } from "../client.js";
import {
  createFirecrawlSearchBackend,
  FIRECRAWL_BACKEND_ID,
  FIRECRAWL_BACKEND_LABEL,
} from "./firecrawl-backend.js";

describe("createFirecrawlSearchBackend", () => {
  it("delegates search to the Firecrawl client and exposes the decided id + label", async () => {
    const seen: string[] = [];
    const client: FirecrawlClient = {
      search: async (params) => {
        seen.push(params.query);
        return [{ title: "T", url: "http://a" }];
      },
      scrape: () => Promise.reject(new Error("not used")),
      crawl: () => Promise.reject(new Error("not used")),
    };
    const backend = createFirecrawlSearchBackend(client);
    expect(backend.id).toBe(FIRECRAWL_BACKEND_ID);
    expect(backend.id).toBe("firecrawl");
    expect(backend.label).toBe(FIRECRAWL_BACKEND_LABEL);
    expect(backend.label).toBe("Firecrawl (self-hosted)");
    const hits = await backend.search({ query: "q", limit: 7 }, new AbortController().signal);
    expect(hits).toEqual([{ title: "T", url: "http://a" }]);
    expect(seen).toEqual(["q"]);
  });
});
