import { describe, expect, it } from "vitest";
import {
  formatCrawlResults,
  formatMapResults,
  formatScrapeResult,
  formatSearchResults,
  truncateOutput,
} from "./format.js";

describe("formatSearchResults", () => {
  it("formats title + url + description + optional markdown", () => {
    const out = formatSearchResults([
      { title: "T1", url: "http://a", description: "desc", markdown: "md-body" },
    ]);
    expect(out).toBe("### T1\nhttp://a\n\ndesc\n\nmd-body");
  });

  it("joins multiple results with ---", () => {
    const out = formatSearchResults([
      { title: "T1", url: "http://a", description: "d1" },
      { title: "T2", url: "http://b", description: "d2" },
    ]);
    expect(out).toBe("### T1\nhttp://a\n\nd1\n\n---\n\n### T2\nhttp://b\n\nd2");
  });

  it("empty data returns 'No results found.'", () => {
    expect(formatSearchResults([])).toBe("No results found.");
    expect(formatSearchResults(null)).toBe("No results found.");
    expect(formatSearchResults(undefined)).toBe("No results found.");
  });
});

describe("formatScrapeResult", () => {
  it("formats title + markdown", () => {
    const out = formatScrapeResult({
      data: { markdown: "body", metadata: { title: "Title" } },
    });
    expect(out).toBe("# Title\n\nbody");
  });

  it("omits title header when absent", () => {
    const out = formatScrapeResult({ data: { markdown: "body" } });
    expect(out).toBe("body");
  });
});

describe("formatCrawlResults", () => {
  it("formats multiple pages", () => {
    const out = formatCrawlResults([
      { markdown: "p1", metadata: { title: "P1", sourceURL: "http://p1" } },
      { markdown: "p2", metadata: { title: "P2", url: "http://p2" } },
    ]);
    expect(out).toBe("## P1\nhttp://p1\n\np1\n\n---\n\n## P2\nhttp://p2\n\np2");
  });

  it("empty data returns 'No pages crawled.'", () => {
    expect(formatCrawlResults([])).toBe("No pages crawled.");
    expect(formatCrawlResults(null)).toBe("No pages crawled.");
  });
});

describe("formatMapResults", () => {
  it("formats links as bullet list", () => {
    const out = formatMapResults(["http://a", "http://b"]);
    expect(out).toBe("- http://a\n- http://b");
  });

  it("empty links returns 'No links found.'", () => {
    expect(formatMapResults([])).toBe("No links found.");
    expect(formatMapResults(null)).toBe("No links found.");
  });
});

describe("truncateOutput", () => {
  it("truncates with notice when over cap", () => {
    const output = "a".repeat(100);
    const result = truncateOutput(output, 50);
    expect(result).toContain("a".repeat(50));
    expect(result).toContain("[Output truncated: exceeded 50 characters]");
    expect(result.length).toBeLessThan(output.length + 100);
  });

  it("returns as-is when under cap", () => {
    expect(truncateOutput("short", 100)).toBe("short");
    expect(truncateOutput("exact", 5)).toBe("exact");
  });
});
