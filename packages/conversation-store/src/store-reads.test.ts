import type { StorageNamespace, TurnMetrics } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { chunkKey, chunkPrefix, metricsKey, metricsPrefix, seqKey } from "./keys.js";
import { createConversationStore } from "./store.js";

function trackedStorage(data: Map<string, string>) {
  const reference = storageFromMap(data);
  const reads = {
    keys: [] as string[],
    get: [] as string[],
    entries: [] as { prefix: string; opts: Parameters<StorageNamespace["entries"]>[1] }[],
    rows: 0,
  };
  const storage: StorageNamespace = {
    ...reference,
    keys: async (prefix = "") => {
      reads.keys.push(prefix);
      return reference.keys(prefix);
    },
    get: async (key) => {
      reads.get.push(key);
      return reference.get(key);
    },
    entries: async (prefix, opts) => {
      reads.entries.push({ prefix, opts });
      const rows = await reference.entries(prefix, opts);
      reads.rows += rows.length;
      return rows;
    },
  };
  return { store: createConversationStore(storage), reads };
}

function chunkRow(seq: number) {
  return {
    chunk: { type: "text", text: `chunk ${seq}` },
    role: "assistant",
    msgIdx: 0,
    chunkIdx: seq - 1,
    turnId: "turn-1",
  };
}

function seed(seqs: readonly number[]) {
  // Deliberately insert out of order; storage owns binary ordering.
  return new Map(
    [...seqs].reverse().map((seq) => [chunkKey("c", seq), JSON.stringify(chunkRow(seq))]),
  );
}

function expectRangeOnly(reads: ReturnType<typeof trackedStorage>["reads"], rows: number) {
  expect(reads.keys).toEqual([]);
  expect(reads.get).toEqual([]);
  expect(reads.rows).toBe(rows);
}

describe("ConversationStore range reads", () => {
  it("load uses one ordered entries query and no point reads", async () => {
    const { store, reads } = trackedStorage(seed([1, 2, 3]));
    expect(await store.load("c")).toEqual([
      { role: "assistant", chunks: [1, 2, 3].map((seq) => chunkRow(seq).chunk) },
    ]);
    expect(reads.entries).toEqual([{ prefix: chunkPrefix("c"), opts: undefined }]);
    expectRangeOnly(reads, 3);
  });

  it("loadMetrics uses one ordered entries query and no point reads", async () => {
    const metrics: TurnMetrics[] = [1, 2].map((n) => ({
      turnId: `turn-${n}`,
      usage: { inputTokens: n, outputTokens: n },
      steps: [],
    }));
    const data = new Map(
      metrics.map((row, i) => [metricsKey("c", i + 1), JSON.stringify(row)]).reverse(),
    );
    const { store, reads } = trackedStorage(data);
    expect(await store.loadMetrics("c")).toEqual(metrics);
    expect(reads.entries).toEqual([{ prefix: metricsPrefix("c"), opts: undefined }]);
    expectRangeOnly(reads, 2);
  });

  it("forkHistory reads chunks once, copies raw bytes, and retains target numbering", async () => {
    const data = seed([2, 4]);
    const { store, reads } = trackedStorage(data);
    await store.forkHistory("c", "archive");
    expect(reads.keys).toEqual([]);
    expect(reads.get.some((key) => key.startsWith(chunkPrefix("c")))).toBe(false);
    expect(reads.entries).toEqual([{ prefix: chunkPrefix("c"), opts: undefined }]);
    expect(reads.rows).toBe(2);
    expect(data.get(chunkKey("archive", 1))).toBe(data.get(chunkKey("c", 2)));
    expect(data.get(chunkKey("archive", 2))).toBe(data.get(chunkKey("c", 4)));
    expect(data.get(seqKey("archive"))).toBe("2");
  });

  it.each([
    { since: 0, beforeSeq: undefined, expected: [996, 997, 998, 999, 1000] },
    { since: 100, beforeSeq: 900, expected: [895, 896, 897, 898, 899] },
  ])("loadSince reads/parses only five of 1,000 chunks ($since, $beforeSeq)", async ({
    since,
    beforeSeq,
    expected,
  }) => {
    const data = seed(Array.from({ length: 1000 }, (_, i) => i + 1));
    // Invalid JSON anywhere outside the returned window must not be parsed.
    for (let seq = 1; seq <= 1000; seq++) {
      if (!expected.includes(seq)) data.set(chunkKey("c", seq), "not json");
    }
    const { store, reads } = trackedStorage(data);
    const window = beforeSeq === undefined ? { limit: 5 } : { beforeSeq, limit: 5 };
    expect(await store.loadSince("c", since, window)).toEqual(
      expected.map((seq) => ({
        seq,
        role: "assistant",
        chunk: chunkRow(seq).chunk,
        turnId: "turn-1",
      })),
    );
    expect(reads.entries).toEqual([
      {
        prefix: chunkPrefix("c"),
        opts: {
          startAfter: chunkKey("c", since),
          ...(beforeSeq === undefined ? {} : { endBefore: chunkKey("c", beforeSeq) }),
          reverse: true,
          limit: 5,
        },
      },
    ]);
    expectRangeOnly(reads, 5);
  });

  it("unlimited loadSince pushes exclusive bounds down without reversing", async () => {
    const { store, reads } = trackedStorage(seed([1, 2, 3, 4, 5]));
    expect((await store.loadSince("c", 1, { beforeSeq: 5 })).map((row) => row.seq)).toEqual([
      2, 3, 4,
    ]);
    expect(reads.entries).toEqual([
      {
        prefix: chunkPrefix("c"),
        opts: { startAfter: chunkKey("c", 1), endBefore: chunkKey("c", 5) },
      },
    ]);
    expectRangeOnly(reads, 3);
  });

  it.each([
    { since: 4, beforeSeq: 4 },
    { since: 5, beforeSeq: 2 },
  ])("inverted/empty bounds return no rows: $since..$beforeSeq", async ({ since, beforeSeq }) => {
    const { store, reads } = trackedStorage(seed([1, 2, 3, 4, 5]));
    expect(await store.loadSince("c", since, { beforeSeq, limit: 5 })).toEqual([]);
    expect(reads.entries).toHaveLength(1);
    expectRangeOnly(reads, 0);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("invalid window/since values remain forgiving: %s", async (invalid) => {
    const { store } = trackedStorage(seed([1, 2, 3]));
    expect(
      (await store.loadSince("c", invalid, { beforeSeq: invalid, limit: invalid })).map(
        (row) => row.seq,
      ),
    ).toEqual([1, 2, 3]);
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    1e20,
    1e21,
    Number.MAX_VALUE,
  ])("unsafe integer limits do not throw and large bounds preserve selection: %s", async (large) => {
    const { store } = trackedStorage(seed([1, 2, 3]));
    expect((await store.loadSince("c", 0, { limit: large })).map((row) => row.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(
      (await store.loadSince("c", 0, { beforeSeq: large, limit: 2 })).map((row) => row.seq),
    ).toEqual([2, 3]);
    expect(await store.loadSince("c", large, { limit: 2 })).toEqual([]);
  });

  it("bounds wider than pad10 preserve numeric selection and existing key order", async () => {
    const { store } = trackedStorage(seed([1, 2, 9_999_999_999, 10_000_000_000, 20_000_000_000]));
    expect(
      (await store.loadSince("c", 0, { beforeSeq: 10_000_000_000 })).map((row) => row.seq),
    ).toEqual([1, 2, 9_999_999_999]);
    expect(
      (await store.loadSince("c", 10_000_000_000, { limit: 2 })).map((row) => row.seq),
    ).toEqual([20_000_000_000]);
  });
});
