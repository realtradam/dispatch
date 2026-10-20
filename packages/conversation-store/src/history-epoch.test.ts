import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createConversationStore } from "./store.js";

const user = (text: string): ChatMessage => ({ role: "user", chunks: [{ type: "text", text }] });

function fixture() {
  const data = new Map<string, string>();
  const reference = storageFromMap(data);
  let failKey: string | undefined;
  const storage: StorageNamespace = {
    ...reference,
    transaction: (fn) =>
      reference.transaction((tx) =>
        fn({
          ...tx,
          set(key, value) {
            tx.set(key, value);
            if (key === failKey) throw new Error("injected failure");
          },
        }),
      ),
  };
  return {
    data,
    storage,
    store: createConversationStore(storage),
    fail(key: string) {
      failKey = key;
    },
  };
}

describe("history epochs and monotonic replacement", () => {
  it("defaults to zero; replacement retains turnIds, metadata and fresh message ordinals", async () => {
    const { store, data } = fixture();
    expect(await store.getHistoryEpoch("unknown")).toBe(0);
    await store.append("c", [user("old")], { turnId: "old-turn" });
    await store.append("c", [user("kept")], { turnId: "kept-turn" });
    await store.setConversationTitle("c", "title");
    const meta = await store.getConversationMeta("c");
    expect(await store.getHistoryEpoch("c")).toBe(0);
    await store.replaceHistory("c", [user("summary"), user("kept")]);
    const rows = await store.loadSince("c", 2);
    expect(rows.map(({ seq, turnId }) => [seq, turnId])).toEqual([
      [3, undefined],
      [4, "kept-turn"],
    ]);
    expect(await store.loadSince("c")).toEqual(rows);
    expect(await store.load("c")).toEqual([user("summary"), user("kept")]);
    expect(await store.getHistoryEpoch("c")).toBe(1);
    expect(data.get("conv:c:msg-seq")).toBe("4");
    expect(await store.getConversationMeta("c")).toMatchObject({
      createdAt: meta?.createdAt,
      title: "title",
      status: meta?.status,
    });
  });

  it("persists repeated and empty replacements and appends above the old maximum", async () => {
    const { store, storage, data } = fixture();
    await store.append("c", [user("one"), user("two")]);
    await store.replaceHistory("c", [user("summary")]);
    await store.replaceHistory("c", [user("summary2")]);
    expect((await store.loadSince("c", 3)).map(({ seq }) => seq)).toEqual([4]);
    await store.replaceHistory("c", []);
    expect(await store.loadSince("c")).toEqual([]);
    expect(data.get("conv:c:seq")).toBe("4");
    const reopened = createConversationStore(storage);
    expect(await reopened.getHistoryEpoch("c")).toBe(3);
    await reopened.append("c", [user("after")]);
    expect((await reopened.loadSince("c", 4)).map(({ seq }) => seq)).toEqual([5]);
    expect(await reopened.getHistoryEpoch("c")).toBe(3);
    await reopened.replaceHistory("empty", []);
    await reopened.replaceHistory("empty", []);
    expect(await reopened.getHistoryEpoch("empty")).toBe(2);
  });

  it.each([
    "conv:c:msg-seq",
    "conv:c:history-epoch",
  ])("rolls back chunks, counters and epoch on failure at %s", async (key) => {
    const f = fixture();
    await f.store.append("c", [user("old")]);
    await f.store.replaceHistory("c", [user("existing summary")]);
    const before = new Map(f.data);
    f.fail(key);
    await expect(f.store.replaceHistory("c", [user("failed")])).rejects.toThrow("injected failure");
    expect(f.data).toEqual(before);
    expect(await f.store.getHistoryEpoch("c")).toBe(1);
    expect((await f.store.loadSince("c", 1)).map(({ seq }) => seq)).toEqual([2]);
    expect(await f.store.load("c")).toEqual([user("existing summary")]);
  });
});
