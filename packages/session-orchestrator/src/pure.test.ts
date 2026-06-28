import type { ProviderContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  buildUserMessage,
  cumulativeSleepMs,
  defaultDispatchPolicy,
  delayFor,
  generateTurnId,
  type MemorySample,
  memoryDelta,
  memorySampleAttributes,
  RETRY_BUDGET_MS,
  RETRY_SCHEDULE_MS,
  RETRY_TAIL_MS,
  resolveReasoningEffort,
  selectFirstProvider,
} from "./pure.js";

describe("buildUserMessage", () => {
  it("creates a user message with a single text chunk", () => {
    const msg = buildUserMessage("hello world");
    expect(msg.role).toBe("user");
    expect(msg.chunks).toHaveLength(1);
    expect(msg.chunks[0]).toEqual({ type: "text", text: "hello world" });
  });

  it("preserves empty text", () => {
    const msg = buildUserMessage("");
    expect(msg.role).toBe("user");
    expect(msg.chunks[0]).toEqual({ type: "text", text: "" });
  });

  it("appends image chunks after the text chunk when images are given", () => {
    const msg = buildUserMessage("look at this", [
      { url: "data:image/png;base64,aaa" },
      { url: "data:image/jpeg;base64,bbb", mimeType: "image/jpeg" },
    ]);
    expect(msg.chunks).toHaveLength(3);
    expect(msg.chunks[0]).toEqual({ type: "text", text: "look at this" });
    expect(msg.chunks[1]).toEqual({ type: "image", url: "data:image/png;base64,aaa" });
    expect(msg.chunks[2]).toEqual({
      type: "image",
      url: "data:image/jpeg;base64,bbb",
      mimeType: "image/jpeg",
    });
  });

  it("builds an image-only message when text is empty", () => {
    const msg = buildUserMessage("", [{ url: "data:image/png;base64,zzz" }]);
    expect(msg.chunks).toHaveLength(1);
    expect(msg.chunks[0]).toEqual({ type: "image", url: "data:image/png;base64,zzz" });
  });

  it("includes mimeType when provided", () => {
    const msg = buildUserMessage("hi", [
      { url: "data:image/webp;base64,x", mimeType: "image/webp" },
    ]);
    expect((msg.chunks[1] as { mimeType?: string }).mimeType).toBe("image/webp");
  });

  it("omits mimeType when not provided", () => {
    const msg = buildUserMessage("hi", [{ url: "https://example.com/x.png" }]);
    expect((msg.chunks[1] as { mimeType?: string }).mimeType).toBeUndefined();
  });
});

describe("selectFirstProvider", () => {
  it("returns the first provider from a non-empty map", () => {
    const provider: ProviderContract = {
      id: "test-provider",
      stream: async function* () {},
    };
    const providers = new Map<string, ProviderContract>();
    providers.set("test-provider", provider);

    expect(selectFirstProvider(providers)).toBe(provider);
  });

  it("throws when the map is empty", () => {
    const providers = new Map<string, ProviderContract>();
    expect(() => selectFirstProvider(providers)).toThrow("No providers registered");
  });

  it("returns the first inserted provider when multiple exist", () => {
    const first: ProviderContract = { id: "first", stream: async function* () {} };
    const second: ProviderContract = { id: "second", stream: async function* () {} };
    const providers = new Map<string, ProviderContract>();
    providers.set("first", first);
    providers.set("second", second);

    expect(selectFirstProvider(providers).id).toBe("first");
  });
});

describe("defaultDispatchPolicy", () => {
  it("returns maxConcurrent: 1, eager: true", () => {
    expect(defaultDispatchPolicy()).toEqual({ maxConcurrent: 1, eager: true });
  });
});

describe("generateTurnId", () => {
  it("returns a string starting with 'turn-'", () => {
    const id = generateTurnId();
    expect(id).toMatch(/^turn-/);
  });

  it("returns unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTurnId()));
    expect(ids.size).toBe(100);
  });
});

describe("resolveReasoningEffort", () => {
  it("override wins over stored", () => {
    expect(resolveReasoningEffort("low", "high")).toBe("low");
    expect(resolveReasoningEffort("max", "medium")).toBe("max");
  });

  it("stored wins over default", () => {
    expect(resolveReasoningEffort(undefined, "medium")).toBe("medium");
    expect(resolveReasoningEffort(undefined, "xhigh")).toBe("xhigh");
  });

  it("default is 'high' when both are absent", () => {
    expect(resolveReasoningEffort(undefined, null)).toBe("high");
  });

  it("all 5 levels pass through as override", () => {
    expect(resolveReasoningEffort("low", null)).toBe("low");
    expect(resolveReasoningEffort("medium", null)).toBe("medium");
    expect(resolveReasoningEffort("high", null)).toBe("high");
    expect(resolveReasoningEffort("xhigh", null)).toBe("xhigh");
    expect(resolveReasoningEffort("max", null)).toBe("max");
  });

  it("all 5 levels pass through as stored", () => {
    expect(resolveReasoningEffort(undefined, "low")).toBe("low");
    expect(resolveReasoningEffort(undefined, "medium")).toBe("medium");
    expect(resolveReasoningEffort(undefined, "high")).toBe("high");
    expect(resolveReasoningEffort(undefined, "xhigh")).toBe("xhigh");
    expect(resolveReasoningEffort(undefined, "max")).toBe("max");
  });
});

describe("retry backoff schedule (delayFor)", () => {
  it("emits the stepped head: 5s, 10s, 30s, 60s, 5m, 10m, 15m, 30m", () => {
    expect(delayFor(0)).toBe(5_000);
    expect(delayFor(1)).toBe(10_000);
    expect(delayFor(2)).toBe(30_000);
    expect(delayFor(3)).toBe(60_000);
    expect(delayFor(4)).toBe(300_000);
    expect(delayFor(5)).toBe(600_000);
    expect(delayFor(6)).toBe(900_000);
    expect(delayFor(7)).toBe(1_800_000);
  });

  it("repeats 30m after the head", () => {
    expect(delayFor(8)).toBe(RETRY_TAIL_MS);
    expect(delayFor(9)).toBe(RETRY_TAIL_MS);
    expect(delayFor(20)).toBe(RETRY_TAIL_MS);
  });

  it("gives up (returns undefined) once cumulative sleep exceeds 8h", () => {
    // Head sums to 3,705,000 ms; +1,800,000 per extra step. 8h = 28,800,000.
    // attempt 20 cumulative = 3,705,000 + 13*1,800,000 = 27,105,000 (< 8h) → retry.
    expect(delayFor(20)).toBe(RETRY_TAIL_MS);
    // attempt 21 cumulative = 27,105,000 + 1,800,000 = 28,905,000 (> 8h) → stop.
    expect(delayFor(21)).toBeUndefined();
  });

  it("cumulativeSleepMs matches the sum of the schedule", () => {
    expect(cumulativeSleepMs(0)).toBe(5_000);
    expect(cumulativeSleepMs(1)).toBe(15_000);
    expect(cumulativeSleepMs(7)).toBe(RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0));
    // 8h budget is 28,800,000 ms.
    expect(RETRY_BUDGET_MS).toBe(8 * 60 * 60 * 1000);
    // The last retry (attempt 20) keeps cumulative under budget.
    expect(cumulativeSleepMs(20)).toBeLessThanOrEqual(RETRY_BUDGET_MS);
    // The next (attempt 21) exceeds it.
    expect(cumulativeSleepMs(21)).toBeGreaterThan(RETRY_BUDGET_MS);
  });

  it("the full schedule has 21 retries then stops", () => {
    const schedule: number[] = [];
    let attempt = 0;
    while (true) {
      const delay = delayFor(attempt);
      if (delay === undefined) break;
      schedule.push(delay);
      attempt++;
    }
    expect(schedule).toHaveLength(21);
    expect(schedule[0]).toBe(5_000);
    expect(schedule.at(-1)).toBe(RETRY_TAIL_MS);
    // 8 stepped head + 13 tail repeats.
    expect(schedule.slice(0, 8)).toEqual([...RETRY_SCHEDULE_MS]);
    expect(schedule.slice(8).every((d) => d === RETRY_TAIL_MS)).toBe(true);
  });
});

describe("memorySampleAttributes", () => {
  const sample: MemorySample = {
    rss: 100 * 1024 * 1024, // 100 MB
    heapUsed: 40 * 1024 * 1024,
    heapTotal: 60 * 1024 * 1024,
    external: 5 * 1024 * 1024,
    arrayBuffers: 2 * 1024 * 1024,
  };

  it("formats fields as rounded MB with no prefix", () => {
    const attrs = memorySampleAttributes(sample);
    expect(attrs).toEqual({
      rssMB: 100,
      heapUsedMB: 40,
      heapTotalMB: 60,
      externalMB: 5,
      arrayBuffersMB: 2,
    });
  });

  it("namespaces keys with the given prefix", () => {
    const attrs = memorySampleAttributes(sample, "delta");
    expect(attrs).toEqual({
      deltaRssMB: 100,
      deltaHeapUsedMB: 40,
      deltaHeapTotalMB: 60,
      deltaExternalMB: 5,
      deltaArrayBuffersMB: 2,
    });
  });

  it("rounds fractional MB", () => {
    const attrs = memorySampleAttributes({ ...sample, rss: 100.6 * 1024 * 1024 });
    expect(attrs.rssMB).toBe(101);
  });
});

describe("memoryDelta", () => {
  const before: MemorySample = {
    rss: 200 * 1024 * 1024,
    heapUsed: 100 * 1024 * 1024,
    heapTotal: 150 * 1024 * 1024,
    external: 10 * 1024 * 1024,
    arrayBuffers: 4 * 1024 * 1024,
  };
  const after: MemorySample = {
    rss: 350 * 1024 * 1024,
    heapUsed: 120 * 1024 * 1024,
    heapTotal: 150 * 1024 * 1024,
    external: 10 * 1024 * 1024,
    arrayBuffers: 8 * 1024 * 1024,
  };

  it("computes signed after - before per field", () => {
    const delta = memoryDelta(before, after);
    expect(delta.rss).toBe(150 * 1024 * 1024);
    expect(delta.heapUsed).toBe(20 * 1024 * 1024);
    expect(delta.heapTotal).toBe(0);
    expect(delta.external).toBe(0);
    expect(delta.arrayBuffers).toBe(4 * 1024 * 1024);
  });

  it("is negative when memory dropped", () => {
    const delta = memoryDelta(after, before);
    expect(delta.rss).toBe(-150 * 1024 * 1024);
  });
});
