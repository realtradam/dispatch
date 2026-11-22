import type { StepId } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import {
  DISCORD_MESSAGE_LIMIT,
  formatDuration,
  formatStepFooter,
  formatTps,
  formatTurnSummary,
  labelledQuote,
  middleTruncate,
  quote,
  sanitizeError,
  splitMessage,
  splitQuoted,
  summarizeToolInput,
  toolHeader,
  toolOutcome,
  toolResultBlock,
} from "./format.js";

const sid = (s: string) => s as StepId;

describe("golden footers (the user's examples, exactly)", () => {
  it("step footer", () => {
    // 512 out over a 5,885 ms decode window → 87 tok/s; 4.1 s total generation.
    expect(
      formatStepFooter(
        {
          stepId: sid("t#2"),
          usage: { inputTokens: 41_200, outputTokens: 512, cacheReadTokens: 40_960 },
          ttftMs: 300,
          decodeMs: 5_885,
          genTotalMs: 4_100,
        },
        2,
      ),
    ).toBe("-# step 3 · 41,200 in (40,960 cached) / 512 out · 87 tok/s · 4.1s");
  });

  it("turn summary", () => {
    expect(
      formatTurnSummary(
        {
          turnId: "t",
          usage: { inputTokens: 2_501_533, outputTokens: 36_522, cacheReadTokens: 2_386_092 },
          durationMs: 397_000,
          contextSize: 148_210,
          steps: [
            {
              stepId: sid("t#0"),
              usage: { inputTokens: 1, outputTokens: 20_000 },
              decodeMs: 160_000,
            },
            {
              stepId: sid("t#1"),
              usage: { inputTokens: 1, outputTokens: 16_522 },
              decodeMs: 134_532,
            },
            // A step without decode timing never skews the turn rate.
            { stepId: sid("t#2"), usage: { inputTokens: 1, outputTokens: 999 } },
          ],
        },
        1,
      ),
    ).toBe(
      "-# turn 1 · 36,522 tok out · 2,501,533 in (2,386,092 cached) · 124 tok/s · 397.0s · 148,210 tokens in context",
    );
  });

  it("drops missing segments (no cache, no timing, no context)", () => {
    expect(
      formatStepFooter({ stepId: sid("s"), usage: { inputTokens: 10, outputTokens: 2 } }, 0),
    ).toBe("-# step 1 · 10 in / 2 out");
    expect(
      formatTurnSummary({ turnId: "t", usage: { inputTokens: 10, outputTokens: 2 }, steps: [] }, 4),
    ).toBe("-# turn 4 · 2 tok out · 10 in");
  });
});

describe("number formatting (frontend parity)", () => {
  it("tps: one decimal under 10, rounded above", () => {
    expect(formatTps(9.44)).toBe("9.4 tok/s");
    expect(formatTps(86.6)).toBe("87 tok/s");
    expect(formatTps(null)).toBeNull();
  });
  it("durations", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(4_100)).toBe("4.1s");
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });
});

describe("middleTruncate", () => {
  it("returns fitting text unchanged", () => {
    expect(middleTruncate("short", 10)).toBe("short");
  });
  it("keeps head and tail around an exact omitted count", () => {
    const text = "H".repeat(10_000) + "T".repeat(10_000);
    const out = middleTruncate(text, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    const m = /…\[([\d,]+) characters omitted\]…/.exec(out);
    expect(m).not.toBeNull();
    const omitted = Number((m?.[1] ?? "").replace(/,/g, ""));
    expect(out.length - (m?.[0].length ?? 0) + omitted).toBe(text.length);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
  });
  it("respects every bound", () => {
    const text = "x".repeat(5_000);
    for (const max of [30, 31, 100, 1_999, 2_000]) {
      expect(middleTruncate(text, max).length).toBeLessThanOrEqual(max);
    }
  });
  it("never splits a surrogate pair", () => {
    const out = middleTruncate("😀".repeat(500), 101);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("splitMessage (lossless)", () => {
  it("does not split text that fits", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("")).toEqual([]);
  });
  it("splits at newlines, every part within the limit, nothing lost", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"w".repeat(20)}`);
    const text = lines.join("\n");
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(parts.join("\n")).toBe(text);
  });
  it("hard-splits a single giant word", () => {
    const text = "z".repeat(4_500);
    const parts = splitMessage(text);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
  });
  it("closes and re-opens a code fence across a cut", () => {
    const text = `intro\n\`\`\`ts\n${"const x = 1;\n".repeat(40)}\`\`\`\noutro`;
    const parts = splitMessage(text, 200);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(200);
      // every part has balanced fences
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(parts[1]?.startsWith("```ts\n")).toBe(true);
    expect(parts[parts.length - 1]?.endsWith("```\noutro")).toBe(true);
  });
});

describe("quotes", () => {
  it("quotes each line; empty lines keep the quote", () => {
    expect(quote("a\n\nb")).toBe("> a\n> \u200b\n> b");
  });
  it("labelledQuote fits the budget and cuts the middle", () => {
    const out = labelledQuote("-# 💭 thinking", "line\n".repeat(2_000), 1_900);
    expect(out.length).toBeLessThanOrEqual(1_900);
    expect(out.startsWith("-# 💭 thinking\n> line")).toBe(true);
    expect(out).toContain("characters omitted]…");
  });
  it("splitQuoted is lossless and every part is a quote under the label", () => {
    const text = `${"q".repeat(4_100)}\nshort`;
    const parts = splitQuoted("-# label", text);
    expect(parts[0]?.startsWith("-# label\n> ")).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    const body = parts
      .join("\n")
      .split("\n")
      .filter((l) => l.startsWith("> "))
      .map((l) => l.slice(2));
    expect(body.join("")).toBe(text.replace("\n", ""));
  });
});

describe("tool messages", () => {
  it("summarizes the telling field on one line, backtick-safe", () => {
    expect(summarizeToolInput({ command: "ls -la\necho `hi`", timeout: 5 })).toBe(
      "ls -la echo ˋhiˋ",
    );
    expect(summarizeToolInput({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolInput({ a: 1 })).toBe('{"a":1}');
    expect(summarizeToolInput({ command: "x".repeat(500) }).length).toBe(120);
  });
  it("header and outcome", () => {
    expect(toolHeader("shell", "ls")).toBe("🔧 **shell** · `ls`");
    expect(toolHeader("odd*name", "")).toBe("🔧 **odd\\*name**");
    expect(toolOutcome(false, 1_234)).toBe("✅ 1.2s");
    expect(toolOutcome(true, 400)).toBe("❌ 0.4s");
    expect(toolOutcome(false, undefined)).toBe("✅");
  });
  it("result block is middle-truncated to the budget and fence-safe", () => {
    const block = toolResultBlock(`${"r".repeat(5_000)}\`\`\`end`, 50, 1_900);
    expect(block.length + 50).toBeLessThanOrEqual(1_900);
    expect(block.startsWith("\n```\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
    expect((block.match(/```/g) ?? []).length).toBe(2);
    expect(toolResultBlock("", 0, 100)).toBe("\n```\n(no output)\n```");
  });
});

describe("sanitizeError", () => {
  it("masks secret-looking substrings and collapses to one line", () => {
    const out = sanitizeError(
      "HTTP 401:\nBearer abc.def-123 sk-ant-abcdefghijklmnop api_key=hunter22",
    );
    expect(out).not.toContain("abc.def-123");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("\n");
  });
  it("caps the length", () => {
    expect(sanitizeError("e".repeat(1_000)).length).toBe(300);
    expect(sanitizeError("  ")).toBe("unknown error");
  });
});
