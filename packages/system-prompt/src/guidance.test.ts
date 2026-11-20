import { describe, expect, it } from "vitest";
import { appendTextFileGuidance, TEXT_FILE_EMBED_GUIDANCE } from "./guidance.js";

describe("mandatory application guidance composition", () => {
  it("tells the model about the file viewer without dropping any existing rule", () => {
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("Open in file viewer");
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("Use at most eight embeds per message.");
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("Nested text-file embeds are disabled.");
  });

  it("describes file links without dropping embed rules", () => {
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("file-link:");
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("Use at most eight embeds per message.");
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("Nested text-file embeds are disabled.");
    expect(TEXT_FILE_EMBED_GUIDANCE).toContain("Open in file viewer");
    const viewer = TEXT_FILE_EMBED_GUIDANCE.indexOf(
      'Each embed also gives the user an "Open in file viewer"',
    );
    const links = TEXT_FILE_EMBED_GUIDANCE.indexOf("File links point the user at a file");
    const userOnly = TEXT_FILE_EMBED_GUIDANCE.indexOf("This displays the file to the USER only.");
    expect(viewer).toBeGreaterThanOrEqual(0);
    expect(links).toBeGreaterThan(viewer);
    expect(userOnly).toBeGreaterThan(links);
  });

  it("preserves resolved user content byte-for-byte before a separate guidance paragraph", () => {
    const custom = "  Custom instructions\r\n\r\n";
    expect(appendTextFileGuidance(custom)).toBe(`${custom}\n\n${TEXT_FILE_EMBED_GUIDANCE}`);
  });

  it("is idempotent for empty and nonempty content", () => {
    for (const content of ["", "Custom instructions"])
      expect(appendTextFileGuidance(appendTextFileGuidance(content))).toBe(
        appendTextFileGuidance(content),
      );
  });

  it("does not suppress guidance merely because the template mentions the feature", () => {
    const custom = "## Text-file embeds in chat\nUse text-file: links.";
    expect(appendTextFileGuidance(custom)).toBe(`${custom}\n\n${TEXT_FILE_EMBED_GUIDANCE}`);
  });
});
