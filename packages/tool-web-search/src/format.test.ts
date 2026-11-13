import { describe, expect, it } from "vitest";
import {
  formatCrawlResults,
  formatScrapeResult,
  formatSearchResults,
  truncateOutput,
} from "./format.js";

describe("formatSearchResults", () => {
  it("no answer and no hits → 'No results found.'", () => {
    expect(formatSearchResults({ hits: [] })).toBe("No results found.");
    expect(formatSearchResults(null)).toBe("No results found.");
    expect(formatSearchResults(undefined)).toBe("No results found.");
  });

  it("no answer, hits → joined hits with title/url/description/markdown", () => {
    const out = formatSearchResults({
      hits: [
        { title: "T1", url: "http://a", description: "desc", markdown: "md-body" },
        { title: "T2", url: "http://b" },
      ],
    });
    expect(out).toBe("### T1\nhttp://a\n\ndesc\n\nmd-body\n\n---\n\n### T2\nhttp://b");
  });

  it("omits an empty description (no trailing blank paragraph)", () => {
    expect(formatSearchResults({ hits: [{ title: "T", url: "http://a", description: "" }] })).toBe(
      "### T\nhttp://a",
    );
  });

  it("omits empty markdown", () => {
    expect(formatSearchResults({ hits: [{ title: "T", url: "http://a", markdown: "" }] })).toBe(
      "### T\nhttp://a",
    );
  });

  it("uses fallbacks for a missing title and url", () => {
    expect(formatSearchResults({ hits: [{ description: "d" }] })).toBe("### (no title)\n\n\nd");
  });

  it("answer, no hits → trimmed answer", () => {
    expect(formatSearchResults({ hits: [], answer: "  The answer.  " })).toBe("The answer.");
  });

  it("answer and hits → answer + a Sources section", () => {
    const out = formatSearchResults({
      hits: [{ title: "T", url: "http://a" }],
      answer: " The answer. ",
    });
    expect(out).toBe("The answer.\n\n---\n\n## Sources\n\n### T\nhttp://a");
  });

  it("an answer that is empty after trimming counts as no answer", () => {
    expect(formatSearchResults({ hits: [], answer: "   " })).toBe("No results found.");
    expect(formatSearchResults({ hits: [{ title: "T", url: "http://a" }], answer: "  " })).toBe(
      "### T\nhttp://a",
    );
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
