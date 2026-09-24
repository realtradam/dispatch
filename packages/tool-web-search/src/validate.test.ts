import { describe, expect, it } from "vitest";
import { type CrawlArgs, type ScrapeArgs, type SearchArgs, validateArgs } from "./validate.js";

describe("validateArgs", () => {
  it("mode defaults to search when query present", () => {
    const result = validateArgs({ query: "hello" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mode).toBe("search");
    expect((result as SearchArgs).query).toBe("hello");
  });

  it("mode defaults to scrape when url present (no query)", () => {
    const result = validateArgs({ url: "http://example.com" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mode).toBe("scrape");
    expect((result as ScrapeArgs).url).toBe("http://example.com");
  });

  it("explicit mode overrides defaults", () => {
    const result = validateArgs({ query: "hello", url: "http://x", mode: "crawl" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mode).toBe("crawl");
    expect((result as CrawlArgs).url).toBe("http://x");
  });

  it("the removed 'map' mode is now invalid", () => {
    expect(validateArgs({ url: "http://x", mode: "map" })).toHaveProperty("error");
  });

  it("search mode requires query", () => {
    const result = validateArgs({ mode: "search" });
    expect(result).toHaveProperty("error");
  });

  it("scrape/crawl modes require url", () => {
    expect(validateArgs({ mode: "scrape" })).toHaveProperty("error");
    expect(validateArgs({ mode: "crawl" })).toHaveProperty("error");
  });

  it("limit clamped to max 10", () => {
    const result = validateArgs({ query: "hello", limit: 50 });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect((result as SearchArgs).limit).toBe(10);
  });

  it("limit defaults to 7 (search) / 3 (crawl)", () => {
    const search = validateArgs({ query: "hello" });
    expect("error" in search).toBe(false);
    if ("error" in search) return;
    expect((search as SearchArgs).limit).toBe(7);

    const crawl = validateArgs({ url: "http://x", mode: "crawl" });
    expect("error" in crawl).toBe(false);
    if ("error" in crawl) return;
    expect((crawl as CrawlArgs).limit).toBe(3);
  });

  it("format defaults to markdown", () => {
    const result = validateArgs({ query: "hello" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.format).toBe("markdown");
  });

  it("rejects invalid mode", () => {
    const result = validateArgs({ mode: "invalid" });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toContain("Invalid mode");
  });

  it("rejects invalid format", () => {
    const result = validateArgs({ url: "http://x", format: "pdf" });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toContain("Invalid format");
  });

  it("returns error for null/non-object args", () => {
    expect(validateArgs(null)).toHaveProperty("error");
    expect(validateArgs(undefined)).toHaveProperty("error");
    expect(validateArgs("string")).toHaveProperty("error");
    expect(validateArgs(42)).toHaveProperty("error");
  });
});
