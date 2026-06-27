import type { ModelInfo, ProviderEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  collectTextFromStream,
  findVisionModelName,
  formatConsultationTitle,
  formatConsultResult,
  formatImagePlaceholder,
  formatNoVisionPlaceholder,
  isVisionCapable,
} from "./pure.js";

describe("isVisionCapable", () => {
  it("returns true when ModelInfo.vision is true", () => {
    expect(isVisionCapable("umans/umans-kimi-k2.7", { id: "umans-kimi-k2.7", vision: true })).toBe(
      true,
    );
  });

  it("returns false when ModelInfo.vision is false (overrides name heuristic)", () => {
    expect(isVisionCapable("umans/umans-kimi-k2.7", { id: "umans-kimi-k2.7", vision: false })).toBe(
      false,
    );
  });

  it("falls back to name heuristic when vision is absent (umans kimi + qwen)", () => {
    expect(isVisionCapable("umans/umans-kimi-k2.7", undefined)).toBe(true);
    expect(isVisionCapable("umans/umans-qwen3.6-35b-a3b", undefined)).toBe(true);
  });

  it("falls back to name heuristic when vision is absent (non-vision)", () => {
    expect(isVisionCapable("umans/umans-glm-5.2", undefined)).toBe(false);
    expect(isVisionCapable("umans/umans-coder", { id: "umans-coder" })).toBe(false);
  });

  it("returns false for undefined model name", () => {
    expect(isVisionCapable(undefined, undefined)).toBe(false);
  });
});

describe("findVisionModelName", () => {
  const getInfo = async (name: string): Promise<ModelInfo | undefined> => {
    const map: Record<string, ModelInfo> = {
      "umans/umans-kimi-k2.7": { id: "umans-kimi-k2.7", vision: true },
      "umans/umans-qwen3.6-35b-a3b": { id: "umans-qwen3.6-35b-a3b", vision: true },
      "umans/umans-glm-5.2": { id: "umans-glm-5.2" },
      "umans/llama-vision": { id: "llama-vision", vision: true },
    };
    return map[name];
  };

  it("finds the first umans kimi model via name heuristic", async () => {
    const name = await findVisionModelName(
      ["umans/umans-glm-5.2", "umans/umans-kimi-k2.7", "umans/llama-vision"],
      getInfo,
    );
    expect(name).toBe("umans/umans-kimi-k2.7");
  });

  it("finds a vision model via ModelInfo.vision when name heuristic misses", async () => {
    const name = await findVisionModelName(["umans/umans-glm-5.2", "umans/llama-vision"], getInfo);
    expect(name).toBe("umans/llama-vision");
  });

  it("skips the excluded model and finds the next vision model", async () => {
    const name = await findVisionModelName(
      ["umans/umans-kimi-k2.7", "umans/umans-qwen3.6-35b-a3b"],
      getInfo,
      "umans/umans-kimi-k2.7",
    );
    expect(name).toBe("umans/umans-qwen3.6-35b-a3b");
  });

  it("returns undefined when no vision model is available", async () => {
    const name = await findVisionModelName(["umans/umans-glm-5.2"], getInfo);
    expect(name).toBeUndefined();
  });

  it("returns undefined for empty catalog", async () => {
    const name = await findVisionModelName([], getInfo);
    expect(name).toBeUndefined();
  });
});

describe("collectTextFromStream", () => {
  async function* stream(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
    for (const e of events) yield e;
  }

  it("collects text-delta events into a single string", async () => {
    const events: ProviderEvent[] = [
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "world!" },
    ];
    const text = await collectTextFromStream(stream(events));
    expect(text).toBe("Hello world!");
  });

  it("ignores non-text events", async () => {
    const events: ProviderEvent[] = [
      { type: "reasoning-delta", delta: "thinking..." },
      { type: "text-delta", delta: "answer" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } },
      { type: "finish", reason: "stop" },
    ];
    const text = await collectTextFromStream(stream(events));
    expect(text).toBe("answer");
  });

  it("throws on an error event", async () => {
    const events: ProviderEvent[] = [
      { type: "text-delta", delta: "partial" },
      { type: "error", message: "boom" },
    ];
    await expect(collectTextFromStream(stream(events))).rejects.toThrow("boom");
  });

  it("returns empty string for an empty stream", async () => {
    const text = await collectTextFromStream(stream([]));
    expect(text).toBe("");
  });
});

describe("formatImagePlaceholder", () => {
  it("includes the image ID and mentions consult_vision", () => {
    const text = formatImagePlaceholder(1);
    expect(text).toContain("Image 1");
    expect(text).toContain("consult_vision");
    expect(text).toContain("imageIds=[1]");
  });

  it("increments the ID for each image", () => {
    expect(formatImagePlaceholder(2)).toContain("Image 2");
    expect(formatImagePlaceholder(2)).toContain("imageIds=[2]");
  });
});

describe("formatNoVisionPlaceholder", () => {
  it("explains the limitation", () => {
    const text = formatNoVisionPlaceholder();
    expect(text).toContain("no vision-capable model");
  });
});

describe("formatConsultResult", () => {
  it("includes the conversation ID, the response, and the dispatch CLI hint", () => {
    const result = formatConsultResult("abc-123", "The error is on line 12.");
    expect(result).toContain("abc-123");
    expect(result).toContain("The error is on line 12.");
    expect(result).toContain("dispatch CLI");
  });

  it("trims the response", () => {
    const result = formatConsultResult("c1", "  spaced  ");
    expect(result).toContain("spaced");
    expect(result).not.toContain("spaced  ");
  });
});

describe("formatConsultationTitle", () => {
  it("prefixes the question with 'IMAGE - '", () => {
    expect(formatConsultationTitle("What error is shown?")).toBe("IMAGE - What error is shown?");
  });

  it("truncates long questions to 80 chars with an ellipsis (matching the store's TITLE_MAX)", () => {
    const long = "x".repeat(100);
    const title = formatConsultationTitle(long);
    expect(title).toBe(`IMAGE - ${"x".repeat(80)}…`);
    expect(title.length).toBe("IMAGE - ".length + 80 + 1); // prefix + 80 + ellipsis
  });

  it("does not truncate questions at or under 80 chars", () => {
    expect(formatConsultationTitle("x".repeat(80))).toBe(`IMAGE - ${"x".repeat(80)}`);
    expect(formatConsultationTitle("x".repeat(79))).toBe(`IMAGE - ${"x".repeat(79)}`);
  });

  it("handles an empty question", () => {
    expect(formatConsultationTitle("")).toBe("IMAGE - ");
  });
});
