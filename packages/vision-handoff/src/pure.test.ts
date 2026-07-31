import { resolve as nodeResolve } from "node:path";
import type { ModelInfo, ProviderEvent, ToolContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  collectTextFromStream,
  filterVisionTools,
  findVisionModelName,
  formatBytes,
  formatConsultationTitle,
  formatConsultResult,
  formatImagePlaceholder,
  formatNoVisionPlaceholder,
  formatReadImageResult,
  isVisionCapable,
  mimeFromPath,
  READ_IMAGE_MAX_COUNT,
  READ_IMAGE_MAX_PER_FILE,
  READ_IMAGE_MAX_TOTAL,
  resolveAndContain,
  validateImageSize,
} from "./pure.js";

function tool(name: string): ToolContract {
  return {
    name,
    description: "",
    parameters: { type: "object" },
    execute: async () => ({ content: "" }),
  };
}

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

  // ── preferred model (compactionModel setting) ─────────────────────────────

  it("honors a vision-capable preferred model even when it is not the catalog's first", async () => {
    // Catalog order would pick kimi first; preferring qwen selects qwen.
    const name = await findVisionModelName(
      ["umans/umans-glm-5.2", "umans/umans-kimi-k2.7", "umans/umans-qwen3.6-35b-a3b"],
      getInfo,
      undefined,
      "umans/umans-qwen3.6-35b-a3b",
    );
    expect(name).toBe("umans/umans-qwen3.6-35b-a3b");
  });

  it("honors a preferred model detected via ModelInfo.vision (name heuristic misses)", async () => {
    // llama-vision is vision-capable only via ModelInfo.vision, not the heuristic.
    const name = await findVisionModelName(
      ["umans/umans-kimi-k2.7", "umans/llama-vision"],
      getInfo,
      undefined,
      "umans/llama-vision",
    );
    expect(name).toBe("umans/llama-vision");
  });

  it("falls back to the catalog scan when the preferred model is NOT vision-capable", async () => {
    const name = await findVisionModelName(
      ["umans/umans-kimi-k2.7", "umans/umans-glm-5.2"],
      getInfo,
      undefined,
      "umans/umans-glm-5.2", // non-vision preferred
    );
    expect(name).toBe("umans/umans-kimi-k2.7");
  });

  it("falls back to the catalog scan when the preferred model is unknown (no ModelInfo)", async () => {
    const name = await findVisionModelName(
      ["umans/umans-kimi-k2.7"],
      getInfo,
      undefined,
      "umans/does-not-exist", // no ModelInfo, not a vision name
    );
    expect(name).toBe("umans/umans-kimi-k2.7");
  });

  it("ignores the preferred model when it equals the excluded model", async () => {
    // Preferred === excluded → must not be returned; falls back to scan.
    const name = await findVisionModelName(
      ["umans/umans-kimi-k2.7", "umans/umans-qwen3.6-35b-a3b"],
      getInfo,
      "umans/umans-kimi-k2.7",
      "umans/umans-kimi-k2.7",
    );
    expect(name).toBe("umans/umans-qwen3.6-35b-a3b");
  });

  it("returns the preferred model even when it is not in the catalog", async () => {
    // A preferred vision model not listed in the catalog is still honored
    // (the setting may name a model that resolves but isn't enumerated).
    const name = await findVisionModelName(
      ["umans/umans-glm-5.2"],
      getInfo,
      undefined,
      "umans/umans-qwen3.6-35b-a3b",
    );
    expect(name).toBe("umans/umans-qwen3.6-35b-a3b");
  });

  it("returns undefined when the preferred is non-vision and the catalog has no vision model", async () => {
    const name = await findVisionModelName(
      ["umans/umans-glm-5.2"],
      getInfo,
      undefined,
      "umans/umans-glm-5.2",
    );
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
  it("includes the conversation ID, the response, and the management-tools follow-up hint", () => {
    const result = formatConsultResult("abc-123", "The error is on line 12.");
    expect(result).toContain("abc-123");
    expect(result).toContain("The error is on line 12.");
    // Follow-up now points to agent-management tools (send_agent_message /
    // read_agent), with the dispatch CLI retained as a fallback.
    expect(result).toContain("send_agent_message");
    expect(result).toContain("read_agent");
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

// ── Model-aware vision tool filtering (plan §12) ────────────────────────────

describe("filterVisionTools", () => {
  const consultVision = tool("consult_vision");
  const readImage = tool("read_image");
  const other = tool("read_file");

  it("hides consult_vision from vision-capable models and keeps read_image", () => {
    const result = filterVisionTools([consultVision, readImage, other], true);
    expect(result.map((t) => t.name)).toEqual(["read_image", "read_file"]);
  });

  it("hides read_image from non-vision models and keeps consult_vision", () => {
    const result = filterVisionTools([consultVision, readImage, other], false);
    expect(result.map((t) => t.name)).toEqual(["consult_vision", "read_file"]);
  });

  it("is complementary: each tool appears in exactly one of the two modes", () => {
    const visionMode = new Set(
      filterVisionTools([consultVision, readImage], true).map((t) => t.name),
    );
    const nonVisionMode = new Set(
      filterVisionTools([consultVision, readImage], false).map((t) => t.name),
    );
    expect(visionMode.has("read_image")).toBe(true);
    expect(visionMode.has("consult_vision")).toBe(false);
    expect(nonVisionMode.has("consult_vision")).toBe(true);
    expect(nonVisionMode.has("read_image")).toBe(false);
  });

  it("leaves unrelated tools untouched in both modes", () => {
    const tools = [tool("lsp"), tool("shell"), consultVision, readImage];
    for (const capable of [true, false]) {
      const result = filterVisionTools(tools, capable);
      expect(result.map((t) => t.name)).toContain("lsp");
      expect(result.map((t) => t.name)).toContain("shell");
    }
  });
});

// ── read_image pure helpers (plan §13) ─────────────────────────────────────

describe("mimeFromPath", () => {
  it("maps supported extensions to MIME types", () => {
    expect(mimeFromPath("a.png")).toBe("image/png");
    expect(mimeFromPath("a.JPG")).toBe("image/jpeg");
    expect(mimeFromPath("dir/sub/img.jpeg")).toBe("image/jpeg");
    expect(mimeFromPath("/abs/path/x.webp")).toBe("image/webp");
    expect(mimeFromPath("x.gif")).toBe("image/gif");
    expect(mimeFromPath("x.bmp")).toBe("image/bmp");
  });

  it("returns undefined for unsupported extensions / no extension", () => {
    expect(mimeFromPath("a.txt")).toBeUndefined();
    expect(mimeFromPath("a.pdf")).toBeUndefined();
    expect(mimeFromPath("noext")).toBeUndefined();
  });
});

describe("resolveAndContain", () => {
  const resolve = (base: string, rel: string) => nodeResolve(base, rel);

  it("resolves a relative path against cwd", () => {
    const r = resolveAndContain(resolve, "img.png", "/work");
    expect("abs" in r).toBe(true);
    if ("abs" in r) expect(r.abs).toBe(nodeResolve("/work", "img.png"));
  });

  it("allows an absolute path inside cwd", () => {
    const r = resolveAndContain(resolve, "/work/sub/img.png", "/work");
    expect("abs" in r).toBe(true);
  });

  it("rejects a traversal that escapes cwd", () => {
    const r = resolveAndContain(resolve, "../../etc/passwd", "/work");
    expect("error" in r).toBe(true);
  });

  it("rejects a sibling directory with a shared prefix (not a child)", () => {
    // /work-evil must NOT be treated as inside /work.
    const r = resolveAndContain(resolve, "/work-evil/img.png", "/work");
    expect("error" in r).toBe(true);
  });
});

describe("validateImageSize", () => {
  it("accepts a small image within both caps", () => {
    expect(validateImageSize(1024, 0)).toBeUndefined();
  });

  it("rejects a single image exceeding the per-file cap", () => {
    expect(validateImageSize(READ_IMAGE_MAX_PER_FILE + 1, 0)).toContain("per-image");
  });

  it("rejects when the running total would exceed the total cap", () => {
    const err = validateImageSize(1024, READ_IMAGE_MAX_TOTAL);
    expect(err).toContain("Total");
  });

  it("accepts an image that exactly fits the total cap", () => {
    expect(validateImageSize(1024, READ_IMAGE_MAX_TOTAL - 1024)).toBeUndefined();
  });
});

describe("formatBytes / formatReadImageResult", () => {
  it("formats byte counts human-readably", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("formats a single-image result with path, mime, and size", () => {
    const result = formatReadImageResult([
      { path: "a.png", abs: "/work/a.png", mimeType: "image/png", size: 2048, dataUrl: "data:..." },
    ]);
    expect(result).toContain("1 image");
    expect(result).toContain("a.png");
    expect(result).toContain("image/png");
    expect(result).toContain("2.0 KiB");
  });

  it("pluralizes for multiple images", () => {
    const result = formatReadImageResult([
      { path: "a.png", abs: "/w/a.png", mimeType: "image/png", size: 1, dataUrl: "d" },
      { path: "b.jpg", abs: "/w/b.jpg", mimeType: "image/jpeg", size: 1, dataUrl: "d" },
    ]);
    expect(result).toContain("2 images");
  });

  it("reports an empty result", () => {
    expect(formatReadImageResult([])).toBe("No images read.");
  });
});

describe("read_image constants", () => {
  it("exposes sane bounds", () => {
    expect(READ_IMAGE_MAX_COUNT).toBe(10);
    expect(READ_IMAGE_MAX_PER_FILE).toBeGreaterThan(0);
    expect(READ_IMAGE_MAX_TOTAL).toBeGreaterThanOrEqual(READ_IMAGE_MAX_PER_FILE);
  });
});
