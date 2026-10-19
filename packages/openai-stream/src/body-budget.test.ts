import { describe, expect, it } from "vitest";
import {
  byteLengthUtf8,
  countImageParts,
  DEFAULT_MAX_BODY_BYTES,
  enforceBodyBudget,
  enforceImageCount,
} from "./body-budget.js";
import type {
  OpenAIContentPart,
  OpenAIImagePart,
  OpenAIMessage,
  OpenAITextPart,
} from "./convert-messages.js";

/**
 * A `data:` image URL whose base64 payload is `payloadChars` chars long.
 * "A" is 1 UTF-8 byte, so every URL's byte length is exactly `url.length` —
 * keeps the size arithmetic in this file exact.
 */
function imageUrl(payloadChars: number, mime = "image/png"): string {
  return `data:${mime};base64,${"A".repeat(payloadChars)}`;
}

function imagePart(url: string): OpenAIImagePart {
  return { type: "image_url", image_url: { url } };
}

function textPart(text: string): OpenAITextPart {
  return { type: "text", text };
}

/** A user message with the given content parts (OpenAI vision format). */
function partsMessage(parts: OpenAIContentPart[]): OpenAIMessage {
  return { role: "user", content: parts };
}

/** A user message with plain string content (no parts — nothing to evict). */
function plainTextMessage(text: string): OpenAIMessage {
  return { role: "user", content: text };
}

/** The built request body (the shape `streamChat` sends) around the messages. */
function buildBody(messages: OpenAIMessage[]): Record<string, unknown> {
  return { model: "test-model", messages, stream: true };
}

/** How many `image_url` parts a message still carries. */
function imagePartsOf(message: OpenAIMessage): number {
  const content = message.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part?.type === "image_url").length;
}

const PLACEHOLDER_SUFFIX = " — dropped to keep the request under the provider's body-size limit";

describe("enforceBodyBudget", () => {
  it("exports the 9.5 MiB default under the 10 MiB gateway cap", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(9_500_000);
    expect(DEFAULT_MAX_BODY_BYTES).toBeLessThan(10_485_760);
  });

  it("returns null and leaves the body untouched when already within budget", () => {
    const messages = [
      partsMessage([textPart("see:"), imagePart(imageUrl(500)), textPart("shot")]),
      plainTextMessage("hello"),
    ];
    const body = buildBody(messages);

    const report = enforceBodyBudget(body, 1_000_000);

    expect(report).toBeNull();
    expect(body.messages).toEqual(messages);
    const content = (body.messages as OpenAIMessage[])[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string }>)[1]?.type).toBe("image_url");
  });

  it("evicts the oldest image first and keeps the newest", () => {
    // Three ~2 MiB images → body ≈ 6 MB. Budget 4.5 MiB: exactly ONE eviction
    // (frees ~2 MB) brings the body under, so only messages[0] is dropped.
    const messages = [
      partsMessage([imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
    ];
    const body = buildBody(messages);
    const before = byteLengthUtf8(JSON.stringify(body));
    expect(before).toBeGreaterThan(4_500_000);

    const report = enforceBodyBudget(body, 4_500_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    expect(report.bytesFreed).toBeGreaterThan(1_000_000);
    expect(byteLengthUtf8(JSON.stringify(body))).toBeLessThanOrEqual(4_500_000);
    expect(byteLengthUtf8(JSON.stringify(body))).toBe(before - report.bytesFreed);

    const msgs = body.messages as OpenAIMessage[];
    const firstContent = msgs[0]?.content;
    expect(Array.isArray(firstContent)).toBe(true);
    const firstPart = (firstContent as OpenAIContentPart[])[0];
    expect(firstPart?.type).toBe("text");
    expect((firstPart as OpenAITextPart | undefined)?.text).toContain("image/png");
    // Newer messages keep their images.
    expect(imagePartsOf(msgs[1] as OpenAIMessage)).toBe(1);
    expect(imagePartsOf(msgs[2] as OpenAIMessage)).toBe(1);
  });

  it("evicts until the body fits, keeping only the newest images", () => {
    const messages = [
      partsMessage([imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
    ];
    const body = buildBody(messages);

    // 4 × ~2 MiB ≈ 8 MB. Budget 5.5 MiB: evicting 2 frees ~4 MB → under.
    const report = enforceBodyBudget(body, 5_500_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(2);
    expect(byteLengthUtf8(JSON.stringify(body))).toBeLessThanOrEqual(5_500_000);

    const msgs = body.messages as OpenAIMessage[];
    expect(imagePartsOf(msgs[0] as OpenAIMessage)).toBe(0);
    expect(imagePartsOf(msgs[1] as OpenAIMessage)).toBe(0);
    expect(imagePartsOf(msgs[2] as OpenAIMessage)).toBe(1);
    expect(imagePartsOf(msgs[3] as OpenAIMessage)).toBe(1);
  });

  it("evicts parts of one message in order, oldest part first", () => {
    // One message: text + 2 image parts (~2 MiB each) ≈ 4 MB. Budget 3 MiB:
    // after dropping the FIRST image part the body is under, so the second
    // image part survives.
    const messages = [
      partsMessage([
        textPart("before"),
        imagePart(imageUrl(2_000_000)),
        imagePart(imageUrl(2_000_000)),
      ]),
    ];
    const body = buildBody(messages);

    const report = enforceBodyBudget(body, 3_000_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const content = (body.messages as OpenAIMessage[])[0]?.content as
      | OpenAIContentPart[]
      | null
      | undefined;
    expect(content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: expect.stringContaining("[image omitted: image/png, ") },
      { type: "image_url", image_url: { url: imageUrl(2_000_000) } },
    ]);
  });

  it("uses the exact placeholder format with mimeType and approximate size", () => {
    // 450 KB base64 payload → "~450 KB", matching the documented format.
    const url = imageUrl(450 * 1024);
    const body = buildBody([partsMessage([imagePart(url)])]);

    const report = enforceBodyBudget(body, 1_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const content = (body.messages as OpenAIMessage[])[0]?.content as
      | OpenAIContentPart[]
      | null
      | undefined;
    expect(content).toEqual([
      { type: "text", text: `[image omitted: image/png, ~450 KB${PLACEHOLDER_SUFFIX}]` },
    ]);
  });

  it("omits the mimeType when the data URL has none inferrable", () => {
    const url = `data:;base64,${"A".repeat(450 * 1024)}`; // no mime before ";base64,"
    const body = buildBody([partsMessage([imagePart(url)])]);

    const report = enforceBodyBudget(body, 100);

    assertDefined(report);
    const content = (body.messages as OpenAIMessage[])[0]?.content as
      | OpenAIContentPart[]
      | null
      | undefined;
    expect(content).toEqual([
      { type: "text", text: `[image omitted, ~450 KB${PLACEHOLDER_SUFFIX}]` },
    ]);
  });

  it("keeps an image-only message non-empty after eviction", () => {
    const body = buildBody([partsMessage([imagePart(imageUrl(2_000_000))])]);

    const report = enforceBodyBudget(body, 1_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const content = (body.messages as OpenAIMessage[])[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    // The array keeps its slot: exactly one part, a non-empty text placeholder.
    expect(content).toHaveLength(1);
    const part = (content as OpenAIContentPart[])[0];
    expect(part?.type).toBe("text");
    expect(((part as OpenAITextPart | undefined)?.text ?? "").length).toBeGreaterThan(0);
  });

  it("terminates on an over-budget body with zero images and returns it as-is", () => {
    const messages = [plainTextMessage("a".repeat(100_000)), plainTextMessage("b".repeat(100_000))];
    const body = buildBody(messages);
    const before = JSON.stringify(body);

    const report = enforceBodyBudget(body, 1_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(0);
    expect(report.bytesFreed).toBe(0);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("never evicts anything except image_url parts", () => {
    const messages = [
      partsMessage([textPart("keep me"), imagePart(imageUrl(2_000_000)), textPart("me too")]),
      { role: "assistant", content: "assistant text" },
      { role: "tool", content: "tool result", tool_call_id: "call_1" },
    ];
    const body = buildBody(messages);

    const report = enforceBodyBudget(body, 1_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const content = (body.messages as OpenAIMessage[])[0]?.content as
      | OpenAIContentPart[]
      | null
      | undefined;
    expect(content).toEqual([
      { type: "text", text: "keep me" },
      { type: "text", text: expect.stringContaining("image/png") },
      { type: "text", text: "me too" },
    ]);
    // Non-user messages untouched.
    const msgs = body.messages as OpenAIMessage[];
    expect(msgs[1]).toEqual({ role: "assistant", content: "assistant text" });
    expect(msgs[2]).toEqual({
      role: "tool",
      content: "tool result",
      tool_call_id: "call_1",
    });
  });

  it("respects a custom injected byteLength", () => {
    // An injected measure that always reports 100 MB: with a budget of 10 MB
    // every image must be evicted, yet the loop still terminates and reports
    // exactly the number of parts dropped.
    const body = buildBody([
      partsMessage([textPart("x"), imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
    ]);

    const report = enforceBodyBudget(body, 10_000_000, () => 100_000_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(2);
    const msgs = body.messages as OpenAIMessage[];
    expect(imagePartsOf(msgs[0] as OpenAIMessage)).toBe(0);
    expect(imagePartsOf(msgs[1] as OpenAIMessage)).toBe(0);
  });

  it("reports bytesFreed exactly under the default UTF-8 measurement", () => {
    const original = buildBody([
      partsMessage([imagePart(imageUrl(2_000_000))]),
      partsMessage([imagePart(imageUrl(2_000_000))]),
    ]);
    const before = byteLengthUtf8(JSON.stringify(original));

    const report = enforceBodyBudget(original, 3_000_000);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const after = byteLengthUtf8(JSON.stringify(original));
    expect(after).toBeLessThanOrEqual(3_000_000);
    expect(report.bytesFreed).toBe(before - after);
  });
});

function assertDefined<T>(v: T | null | undefined, msg?: string): asserts v is T {
  if (v === null || v === undefined) {
    throw new Error(msg ?? "expected defined");
  }
}

describe("countImageParts", () => {
  it("counts image_url parts across messages and ignores text/string content", () => {
    const body = buildBody([
      partsMessage([textPart("a"), imagePart(imageUrl(10)), imagePart(imageUrl(10))]),
      plainTextMessage("no parts"),
      partsMessage([imagePart(imageUrl(10))]),
    ]);

    expect(countImageParts(body)).toBe(3);
  });

  it("returns 0 for a non-array messages field or image-free body", () => {
    expect(countImageParts({ messages: "nope" })).toBe(0);
    expect(countImageParts(buildBody([plainTextMessage("x")]))).toBe(0);
  });
});

describe("enforceImageCount", () => {
  it("returns null and leaves the body untouched when within the cap", () => {
    const messages = [partsMessage([imagePart(imageUrl(10)), imagePart(imageUrl(10))])];
    const body = buildBody(messages);

    const report = enforceImageCount(body, 2);

    expect(report).toBeNull();
    expect(body.messages).toEqual(messages);
  });

  it("evicts the oldest images across messages, keeping the newest", () => {
    const messages = [
      partsMessage([imagePart(imageUrl(10))]),
      partsMessage([imagePart(imageUrl(10))]),
      partsMessage([imagePart(imageUrl(10))]),
    ];
    const body = buildBody(messages);

    const report = enforceImageCount(body, 2);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const msgs = body.messages as OpenAIMessage[];
    expect(imagePartsOf(msgs[0] as OpenAIMessage)).toBe(0);
    expect(imagePartsOf(msgs[1] as OpenAIMessage)).toBe(1);
    expect(imagePartsOf(msgs[2] as OpenAIMessage)).toBe(1);
  });

  it("evicts the oldest part within one message first", () => {
    const messages = [
      partsMessage([
        imagePart(imageUrl(10)),
        textPart("middle"),
        imagePart(imageUrl(10)),
        imagePart(imageUrl(10)),
      ]),
    ];
    const body = buildBody(messages);

    const report = enforceImageCount(body, 2);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const content = (body.messages as OpenAIMessage[])[0]?.content as OpenAIContentPart[];
    expect(content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("[image omitted: image/png, "),
    });
    expect(content[1]).toEqual({ type: "text", text: "middle" });
    expect(content[2]?.type).toBe("image_url");
    expect(content[3]?.type).toBe("image_url");
  });

  it("uses the standard eviction placeholder", () => {
    // 450 KB base64 payload → "~450 KB", matching enforceBodyBudget's format.
    const url = imageUrl(450 * 1024);
    const body = buildBody([partsMessage([imagePart(url), imagePart(url)])]);

    const report = enforceImageCount(body, 1);

    assertDefined(report);
    const content = (body.messages as OpenAIMessage[])[0]?.content as OpenAIContentPart[];
    expect(content[0]).toEqual({
      type: "text",
      text: `[image omitted: image/png, ~450 KB${PLACEHOLDER_SUFFIX}]`,
    });
    expect(content[1]?.type).toBe("image_url");
  });

  it("evicts every image when maxImages is 0 and never touches non-image parts", () => {
    const messages = [
      partsMessage([textPart("keep"), imagePart(imageUrl(10))]),
      { role: "assistant", content: "assistant text" },
      { role: "tool", content: "tool result", tool_call_id: "call_1" },
    ];
    const body = buildBody(messages);

    const report = enforceImageCount(body, 0);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    expect(countImageParts(body)).toBe(0);
    const msgs = body.messages as OpenAIMessage[];
    expect((msgs[0]?.content as OpenAIContentPart[])[0]).toEqual({
      type: "text",
      text: "keep",
    });
    expect(msgs[1]).toEqual({ role: "assistant", content: "assistant text" });
    expect(msgs[2]).toEqual({
      role: "tool",
      content: "tool result",
      tool_call_id: "call_1",
    });
  });

  it("returns null for a body with no image parts", () => {
    const body = buildBody([plainTextMessage("hello")]);
    expect(enforceImageCount(body, 0)).toBeNull();
  });

  it("reports exact bytesFreed under the default UTF-8 measurement", () => {
    const body = buildBody([
      partsMessage([imagePart(imageUrl(1_000))]),
      partsMessage([imagePart(imageUrl(1_000))]),
    ]);
    const before = byteLengthUtf8(JSON.stringify(body));

    const report = enforceImageCount(body, 1);

    assertDefined(report);
    expect(report.imagesEvicted).toBe(1);
    const after = byteLengthUtf8(JSON.stringify(body));
    expect(report.bytesFreed).toBe(before - after);
  });
});
