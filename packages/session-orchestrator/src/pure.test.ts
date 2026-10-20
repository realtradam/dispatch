import type { AgentEvent, ProviderContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  appendCompacted,
  buildUserMessage,
  compactReplay,
  cumulativeSleepMs,
  DISPATCH_TOOL_MAX_CONCURRENT_ENV,
  defaultDispatchPolicy,
  delayFor,
  generateTurnId,
  type MemorySample,
  memoryDelta,
  memorySampleAttributes,
  REPLAY_TOOL_OUTPUT_BYTES,
  RETRY_BUDGET_MS,
  RETRY_SCHEDULE_MS,
  RETRY_TAIL_MS,
  resolveDispatchPolicy,
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
  it("returns maxConcurrent: 4, eager: true", () => {
    expect(defaultDispatchPolicy()).toEqual({ maxConcurrent: 4, eager: true });
  });
});

describe("resolveDispatchPolicy", () => {
  it("falls back to the default when the env var is unset", () => {
    expect(resolveDispatchPolicy(undefined)).toEqual({ policy: defaultDispatchPolicy() });
  });

  it("treats empty / whitespace-only values as unset (no warning)", () => {
    expect(resolveDispatchPolicy("")).toEqual({ policy: defaultDispatchPolicy() });
    expect(resolveDispatchPolicy("   ")).toEqual({ policy: defaultDispatchPolicy() });
  });

  it("parses an integer cap and keeps eager true", () => {
    expect(resolveDispatchPolicy("4")).toEqual({
      policy: { maxConcurrent: 4, eager: true },
    });
  });

  it("accepts 0 (unlimited) and 1 (sequential)", () => {
    expect(resolveDispatchPolicy("0").policy).toEqual({ maxConcurrent: 0, eager: true });
    expect(resolveDispatchPolicy("1").policy).toEqual({ maxConcurrent: 1, eager: true });
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDispatchPolicy("  2  ").policy).toEqual({ maxConcurrent: 2, eager: true });
  });

  it.each([
    "-1",
    "abc",
    "2.5",
    "1e3",
    "+4",
    "4.0",
  ])("rejects %j with the default and a warning", (raw) => {
    const resolution = resolveDispatchPolicy(raw);
    expect(resolution.policy).toEqual(defaultDispatchPolicy());
    expect(resolution.warning).toContain(DISPATCH_TOOL_MAX_CONCURRENT_ENV);
    expect(resolution.warning).toContain(`maxConcurrent=${defaultDispatchPolicy().maxConcurrent}`);
  });

  it("rejects an integer that is not safely representable", () => {
    const resolution = resolveDispatchPolicy("9007199254740993");
    expect(resolution.policy).toEqual(defaultDispatchPolicy());
    expect(resolution.warning).toBeDefined();
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

describe("compactReplay", () => {
  const C = "conv";
  const T = "turn-1";
  const text = (delta: string, turnId = T) =>
    ({ type: "text-delta", conversationId: C, turnId, delta }) as const;
  const reason = (delta: string) =>
    ({ type: "reasoning-delta", conversationId: C, turnId: T, delta }) as const;
  const call = (toolCallId: string) =>
    ({
      type: "tool-call",
      conversationId: C,
      turnId: T,
      stepId: `${T}#0`,
      toolCallId,
      toolName: "run_shell",
      input: {},
    }) as const;
  const output = (toolCallId: string, data: string) =>
    ({
      type: "tool-output",
      conversationId: C,
      turnId: T,
      toolCallId,
      data,
      stream: "stdout",
    }) as const;
  const result = (toolCallId: string) =>
    ({
      type: "tool-result",
      conversationId: C,
      turnId: T,
      stepId: `${T}#0`,
      toolCallId,
      toolName: "run_shell",
      content: "ok",
      isError: false,
    }) as const;
  const start = { type: "turn-start", conversationId: C, turnId: T } as const;

  it("returns an empty array for an empty buffer", () => {
    expect(compactReplay([])).toEqual([]);
  });

  it("merges adjacent same-type deltas into one, preserving concatenated text", () => {
    const out = compactReplay([
      start,
      reason("a"),
      reason("b"),
      text("He"),
      text("llo"),
      text("!"),
    ]);
    expect(out).toEqual([start, reason("ab"), text("Hello!")]);
  });

  it("does not merge across an interrupting structural event", () => {
    const out = compactReplay([text("a"), call("x"), text("b"), text("c")]);
    expect(out).toEqual([text("a"), call("x"), text("bc")]);
  });

  it("does not merge deltas of different turns", () => {
    const out = compactReplay([text("a", "t1"), text("b", "t2")]);
    expect(out).toEqual([text("a", "t1"), text("b", "t2")]);
  });

  it("drops tool-output of finished tools, keeps it for running tools", () => {
    const out = compactReplay([
      call("done"),
      output("done", "1"),
      output("done", "2"),
      result("done"),
      call("live"),
      output("live", "partial"),
    ]);
    expect(out).toEqual([call("done"), result("done"), call("live"), output("live", "partial")]);
  });

  it("keeps only the last status event", () => {
    const s1 = { type: "status", conversationId: C, status: "a" } as const;
    const s2 = { type: "status", conversationId: C, status: "b" } as const;
    expect(compactReplay([s1, text("x"), s2])).toEqual([text("x"), s2]);
  });

  it("does not mutate the input and keeps single deltas by identity", () => {
    const one = text("solo");
    const input = [start, one];
    const copy = [...input];
    const out = compactReplay(input);
    expect(input).toEqual(copy);
    expect(out[1]).toBe(one);
  });

  const status = (value: string) => ({ type: "status", conversationId: C, status: value }) as const;
  const fold = (events: readonly AgentEvent[]) =>
    events.reduce(appendCompacted, [] as AgentEvent[]);

  it("merges runs exposed by status replacement and non-tail output removal", () => {
    const events = [
      text("a"),
      status("old"),
      text("b"),
      output("x", "log"),
      text("c"),
      call("other"),
      result("x"),
      status("new"),
    ];
    expect(fold(events)).toEqual([text("abc"), call("other"), result("x"), status("new")]);
    expect(fold([result("x"), output("x", "late"), reason("a"), reason("b")])).toEqual([
      result("x"),
      reason("ab"),
    ]);
  });

  it("preserves empty running output as a replay boundary until its result arrives", () => {
    const events = [text("a"), output("x", ""), text("b")];
    expect(compactReplay(events)).toEqual(events);
    expect(fold(events)).toEqual(events);
    expect(appendCompacted(fold(events), result("x"))).toEqual([text("ab"), result("x")]);
  });

  it("retains a per-call trailing 64 KiB across interleaved streams at original positions", () => {
    const cap = REPLAY_TOOL_OUTPUT_BYTES;
    const err = { ...output("a", "e".repeat(20_000)), stream: "stderr" } as const;
    const events = [
      output("a", `old${"a".repeat(40_000)}`),
      call("b"),
      output("b", "b".repeat(cap + 5)),
      err,
      text("barrier"),
      output("a", "z".repeat(20_000)),
    ];
    const expected = [
      output("a", "a".repeat(cap - 40_000)),
      call("b"),
      output("b", "b".repeat(cap)),
      err,
      text("barrier"),
      output("a", "z".repeat(20_000)),
    ];
    expect(compactReplay(events)).toEqual(expected);
    expect(fold(events)).toEqual(expected);
    expect(appendCompacted(fold(events), result("a"))).toEqual([
      call("b"),
      output("b", "b".repeat(cap)),
      text("barrier"),
      result("a"),
    ]);
  });

  it("caps UTF-8 bytes without splitting code points or backfilling older output", () => {
    const data = `${"😀".repeat(20_000)}é`;
    const events = [output("x", "old"), output("x", data), output("x", "z")];
    const expected = [output("x", `${"😀".repeat(16_383)}é`), output("x", "z")];
    expect(compactReplay(events)).toEqual(expected);
    expect(fold(events)).toEqual(expected);
    const bytes = fold(events).reduce(
      (sum, e) => sum + (e.type === "tool-output" ? new TextEncoder().encode(e.data).length : 0),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(REPLAY_TOOL_OUTPUT_BYTES);
  });

  it("matches capped batch replay through repeated overflow, then drops all completed output", () => {
    const all: AgentEvent[] = [call("x")];
    let buffer = fold(all);
    for (let i = 0; i < 100; i++) {
      const event = output("x", `${i}:${"é😀x".repeat(300)}`);
      all.push(event);
      buffer = appendCompacted(buffer, event);
      expect(buffer).toEqual(compactReplay(all));
      const retained = buffer.filter((e) => e.type === "tool-output");
      expect(
        retained.reduce((sum, e) => sum + new TextEncoder().encode(e.data).length, 0),
      ).toBeLessThanOrEqual(REPLAY_TOOL_OUTPUT_BYTES);
    }
    expect(appendCompacted(buffer, result("x"))).toEqual([call("x"), result("x")]);
  });

  it("leaves frozen inputs and earlier replay snapshots unchanged", () => {
    const first = Object.freeze([Object.freeze(text("a")), Object.freeze(output("x", "log"))]);
    const before = structuredClone(first);
    const second = appendCompacted(first, Object.freeze(result("x")));
    const snapshot = structuredClone(second);
    appendCompacted(second, text("later"));
    expect(first).toEqual(before);
    expect(second).toEqual(snapshot);
    expect(second).toEqual([text("a"), result("x")]);
  });

  it("matches batch replay for every prefix of seeded random event sequences", () => {
    // Deterministic property test; no dependency or ambient randomness.
    for (let seed = 1; seed <= 50; seed++) {
      let state = seed;
      const next = (n: number) => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return (state >>> 8) % n;
      };
      const all: AgentEvent[] = [];
      let buffer: AgentEvent[] = [];
      for (let i = 0; i < 100; i++) {
        const id = `call-${next(4)}`;
        const delta = ["", "a", "é", "😀"][next(4)] ?? "";
        const variants: AgentEvent[] = [
          text(delta, `turn-${next(2)}`),
          reason(delta),
          status(String(i)),
          call(id),
          result(id),
          { ...output(id, delta.repeat(next(5))), stream: next(2) ? "stdout" : "stderr" },
          {
            type: "step-complete",
            conversationId: C,
            turnId: T,
            stepId: `${T}#${i}`,
            ttftMs: 1,
            decodeMs: 2,
            genTotalMs: 3,
          },
          { type: "steering", conversationId: C, turnId: T, text: delta, messageIds: [] },
          { type: "turn-ended", conversationId: C, turnId: T, reason: "sealed" },
          start,
        ];
        const event = variants[next(variants.length)];
        if (event === undefined) throw new Error("missing generated event");
        all.push(event);
        buffer = appendCompacted(buffer, event);
        expect(buffer, `seed ${seed}, prefix ${i + 1}`).toEqual(compactReplay(all));
      }
    }
  });

  it("100k deltas retain O(structure) events, not token history", () => {
    let buffer: AgentEvent[] = [];
    let peakLength = 0;
    for (let i = 0; i < 100_000; i++) {
      if (i % 10_000 === 0) buffer = appendCompacted(buffer, call(String(i)));
      buffer = appendCompacted(buffer, i < 50_000 ? reason("r") : text("t"));
      peakLength = Math.max(peakLength, buffer.length);
    }
    expect(peakLength).toBe(20);
    expect(buffer).toHaveLength(20); // Ten structural barriers + ten delta runs.
    expect(
      buffer
        .filter((e) => e.type === "text-delta" || e.type === "reasoning-delta")
        .reduce((sum, e) => sum + e.delta.length, 0),
    ).toBe(100_000);
  });

  it("collapses a long token stream to a single event", () => {
    const many = Array.from({ length: 5000 }, (_, i) => text(String(i % 10)));
    const out = compactReplay(many);
    expect(out).toHaveLength(1);
    expect((out[0] as { delta: string }).delta).toBe(many.map((e) => e.delta).join(""));
  });
});
