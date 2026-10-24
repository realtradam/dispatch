import { describe, expect, it } from "vitest";
import { appendTextFileGuidance, TEXT_FILE_EMBED_GUIDANCE } from "./guidance.js";

describe("mandatory application guidance composition", () => {
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
