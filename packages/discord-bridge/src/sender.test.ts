import { createLogger } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FelicityError } from "./client.js";
import { systemClock } from "./extension.js";
import { combineContents, idempotencyKey, ThreadSender } from "./sender.js";
import { FakeFelicity, serverError } from "./test-support.js";

const logger = createLogger(
  { extensionId: "test" },
  { emit: () => {} },
  {
    now: () => 0,
    newId: () => "x",
  },
);

function sender(
  fake: FakeFelicity,
  extra: Partial<ConstructorParameters<typeof ThreadSender>[0]> = {},
) {
  return new ThreadSender({
    channelId: "th",
    client: fake,
    clock: systemClock,
    logger,
    idPrefix: "dsp-th-1",
    ...extra,
  });
}

const up = (key: string, content: string, group?: string) => ({
  type: "upsert" as const,
  key,
  content,
  compact: `${content.split("\n")[0]}`,
  ...(group !== undefined ? { group } : {}),
});

describe("ThreadSender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts in order with ≥ 1.1 s spacing and idempotency keys", async () => {
    const fake = new FakeFelicity();
    const s = sender(fake);
    const t0 = Date.now();
    const times: number[] = [];
    const post = fake.postMessage.bind(fake);
    fake.postMessage = async (...a) => {
      times.push(Date.now() - t0);
      return post(...a);
    };
    s.upsert(up("m1", "one"));
    s.upsert(up("m2", "two"));
    s.upsert(up("m3", "three"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.posts.map((p) => p.content)).toEqual(["one", "two", "three"]);
    expect(fake.posts.map((p) => p.idempotencyKey)).toEqual([
      "dsp-th-1-m1",
      "dsp-th-1-m2",
      "dsp-th-1-m3",
    ]);
    expect(times).toEqual([0, 1_100, 2_200]);
  });

  it("replay spacing is 1.5 s", async () => {
    const fake = new FakeFelicity();
    const s = sender(fake);
    s.upsert(up("r1", "a"), { replay: true });
    s.upsert(up("r2", "b"), { replay: true });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(fake.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.posts).toHaveLength(2);
  });

  it("a queued post absorbs later upserts (no post-then-edit); edits coalesce", async () => {
    const fake = new FakeFelicity();
    const s = sender(fake);
    s.upsert(up("m1", "first"));
    s.upsert(up("m2", "draft"));
    s.upsert(up("m2", "final"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.posts.map((p) => p.content)).toEqual(["first", "final"]);
    s.upsert(up("m1", "first v2"));
    s.upsert(up("m1", "first v3"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.ops("edit")).toEqual([
      { op: "edit", channelId: "th", messageId: fake.posts[0]?.id, content: "first v3" },
    ]);
  });

  it("retries 5xx and 429 (honouring Retry-After), drops 4xx", async () => {
    const fake = new FakeFelicity();
    fake.failures.push(serverError(), new FelicityError(429, "backlogged", "429", 7));
    const s = sender(fake);
    s.upsert(up("m1", "eventually"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fake.posts.map((p) => p.content)).toEqual(["eventually"]);

    fake.failures.push(new FelicityError(403, "missing_permissions", "403"));
    s.upsert(up("m2", "never"));
    s.upsert(up("m3", "after"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.posts.map((p) => p.content)).toEqual(["eventually", "after"]);
  });

  it("merges a step's queued tool messages under backlog, and edits re-render the merge", async () => {
    const fake = new FakeFelicity();
    const s = sender(fake, { mergeThreshold: 3 });
    s.upsert(up("x", "blocker"));
    for (let i = 0; i < 5; i++) s.upsert(up(`t${i}`, `🔧 tool ${i}`, "turn#0"));
    s.upsert(up("y", "response"));
    await vi.advanceTimersByTimeAsync(10_000);
    const posts = fake.posts.map((p) => p.content);
    expect(posts[0]).toBe("blocker");
    expect(posts[1]).toBe("🔧 tool 0\n🔧 tool 1\n🔧 tool 2\n🔧 tool 3\n🔧 tool 4");
    expect(posts[2]).toBe("response");
    expect(s.messageIdOf("t3")).toBe(fake.posts[1]?.id);
    s.upsert(up("t3", "🔧 tool 3 ✅", "turn#0"));
    s.upsert(up("t1", "🔧 tool 1 ✅", "turn#0"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.ops("edit")).toEqual([
      {
        op: "edit",
        channelId: "th",
        messageId: fake.posts[1]?.id,
        content: "🔧 tool 0\n🔧 tool 1 ✅\n🔧 tool 2\n🔧 tool 3 ✅\n🔧 tool 4",
      },
    ]);
  });

  it("idempotency keys always satisfy Felicity's ^[A-Za-z0-9._:-]{1,128}$", () => {
    const re = /^[A-Za-z0-9._:-]{1,128}$/;
    expect(idempotencyKey("dsp-1234567890123456789-m3k2", "replay-m12")).toBe(
      "dsp-1234567890123456789-m3k2-replay-m12",
    );
    const odd = idempotencyKey("dsp-th/1", "key with spaces");
    const odd2 = idempotencyKey("dsp-th_1", "key_with_spaces");
    expect(odd).toMatch(re);
    expect(odd).not.toBe(odd2);
    const long = idempotencyKey("dsp", "k".repeat(500));
    expect(long).toMatch(re);
    expect(long).not.toBe(idempotencyKey("dsp", `${"k".repeat(499)}j`));
  });

  it("combineContents falls back to compact forms, then cuts", () => {
    const big = { content: `head\n${"x".repeat(1_500)}`, compact: "head" };
    expect(combineContents([big, big])).toBe("head\nhead");
    const huge = { content: "y".repeat(3_000) };
    expect(combineContents([huge]).length).toBeLessThanOrEqual(2_000);
  });

  it("reactions go through the same ordered queue; close drops the rest", async () => {
    const fake = new FakeFelicity();
    const drains: number[] = [];
    const s = sender(fake, { onDrain: () => drains.push(1) });
    s.upsert(up("m1", "a"));
    s.react("user-msg", "▶️");
    s.upsert(up("m2", "b"));
    expect(s.pending).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1_200);
    s.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.calls.map((c) => c.op)).toEqual(["post", "react"]);
    s.upsert(up("m3", "ignored"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.posts).toHaveLength(1);
    await s.drained();
  });

  it("drained() resolves when the queue empties and onDrain fires", async () => {
    const fake = new FakeFelicity();
    let drained = 0;
    const s = sender(fake, { onDrain: () => drained++ });
    s.upsert(up("m1", "a"));
    s.upsert(up("m2", "b"));
    const done = s.drained();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(drained).toBe(1);
    expect(s.pending).toBe(0);
  });
});
