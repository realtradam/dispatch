import type { ChatMessage, Role, StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { chunkKey, chunkPrefix, seqKey } from "./keys.js";
import { createConversationStore } from "./store.js";

const user = (text: string): ChatMessage => ({ role: "user", chunks: [{ type: "text", text }] });
const counter = (id = "c") => `conv:${id}:msg-seq`;

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
          set: (key, value) => {
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
    fail: (key?: string) => {
      failKey = key;
    },
  };
}

function legacy(
  data: Map<string, string>,
  seq: number,
  msgIdx: number | undefined,
  role: Role = "user",
) {
  data.set(
    chunkKey("c", seq),
    JSON.stringify({ chunk: user(String(seq)).chunks[0], role, msgIdx, chunkIdx: 0 }),
  );
  data.set(seqKey("c"), String(seq));
}

function ordinals(data: Map<string, string>, id = "c") {
  return [...data]
    .filter(([key]) => key.startsWith(chunkPrefix(id)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => (JSON.parse(value) as { msgOrd?: number }).msgOrd);
}

describe("persisted message ordinals", () => {
  it("separates consecutive single-user appends across store recreation", async () => {
    const f = fixture();
    await f.store.append("c", [user("first")]);
    await createConversationStore(f.storage).append("c", [user("second")]);
    expect(await f.store.load("c")).toEqual([user("first"), user("second")]);
    expect(ordinals(f.data)).toEqual([1, 2]);
    expect(f.data.get(counter())).toBe("2");
  });

  it("allocates one ordinal per message, shared by all its chunks", async () => {
    const f = fixture();
    const multi: ChatMessage = { role: "user", chunks: [...user("a").chunks, ...user("b").chunks] };
    await f.store.append("c", [multi, user("c"), user("d")], { turnId: "turn" });
    expect(await f.store.load("c")).toEqual([multi, user("c"), user("d")]);
    expect(ordinals(f.data)).toEqual([1, 1, 2, 3]);
    expect((await f.store.loadSince("c")).map((row) => row.turnId)).toEqual([
      "turn",
      "turn",
      "turn",
      "turn",
    ]);
    expect(f.data.get(counter())).toBe("3");
  });

  it("retains distinct same-role messages and ordinals under concurrent appends", async () => {
    const f = fixture();
    const messages = Array.from({ length: 20 }, (_, i) => user(String(i)));
    await Promise.all(messages.map((message) => f.store.append("c", [message])));
    expect(await f.store.load("c")).toEqual(messages);
    expect(ordinals(f.data)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(f.data.get(counter())).toBe("20");
  });

  it("keeps the exact legacy index/role heuristic, including skipped JSON and invalid indexes", async () => {
    const f = fixture();
    legacy(f.data, 1, 0);
    f.data.set(chunkKey("c", 2), "invalid json");
    legacy(f.data, 3, 0);
    legacy(f.data, 4, 1);
    legacy(f.data, 5, 1, "assistant");
    legacy(f.data, 6, -1); // Legacy negative-index message is not emitted.
    legacy(f.data, 7, undefined); // Neither is a missing-index message.
    legacy(f.data, 8, 0);
    const before = new Map(f.data);
    expect(await f.store.load("c")).toEqual([
      { role: "user", chunks: [...user("1").chunks, ...user("3").chunks] },
      user("4"),
      { role: "assistant", chunks: user("5").chunks },
      user("8"),
    ]);
    expect(f.data).toEqual(before);
  });

  it("preserves the legacy null-row rejection rather than broadening corrupt-row recovery", async () => {
    const f = fixture();
    f.data.set(chunkKey("c", 1), "null");
    await expect(f.store.load("c")).rejects.toThrow(TypeError);
  });

  it.each([
    0, 1,
  ])("splits legacy/new rows even when role and index or ordinal coincide (%i)", async (idx) => {
    const f = fixture();
    legacy(f.data, 1, idx);
    await f.store.append("c", [user("new")]);
    expect(await f.store.load("c")).toEqual([user("1"), user("new")]);
    expect(ordinals(f.data)).toEqual([undefined, 1]);
  });

  it("uses explicit ordinals rather than local indexes and splits a return to legacy rows", async () => {
    const f = fixture();
    for (let seq = 1; seq <= 4; seq++) legacy(f.data, seq, seq === 2 ? 99 : 0);
    for (const seq of [1, 2, 3]) {
      const key = chunkKey("c", seq);
      f.data.set(
        key,
        JSON.stringify({ ...JSON.parse(f.data.get(key) ?? "{}"), msgOrd: seq < 3 ? 1 : 2 }),
      );
    }
    expect(await f.store.load("c")).toEqual([
      { role: "user", chunks: [...user("1").chunks, ...user("2").chunks] },
      user("3"),
      user("4"),
    ]);
  });

  it.each([
    "legacy",
    "mixed",
    "ordinal",
  ])("forks %s history verbatim and appends without collisions", async (kind) => {
    const f = fixture();
    if (kind !== "ordinal") legacy(f.data, 1, 0);
    if (kind !== "legacy") await f.store.append("c", [user("new"), user("next")]);
    const expected = await f.store.load("c");
    const before = [...f.data].filter(([key]) => key.startsWith(chunkPrefix("c")));
    await f.store.forkHistory("c", "archive");
    expect(await f.store.load("archive")).toEqual(expected);
    before.forEach(([, value], i) => {
      expect(f.data.get(chunkKey("archive", i + 1))).toBe(value);
    });
    await f.store.append("archive", [user("after")]);
    expect(await f.store.load("archive")).toEqual([...expected, user("after")]);
    expect(f.data.get(counter("archive"))).toBe(kind === "legacy" ? "1" : "3");
  });

  it("fork propagates the source counter even above the highest persisted chunk ordinal", async () => {
    const f = fixture();
    await f.store.append("c", [user("old"), { role: "user", chunks: [] }]);
    await f.store.forkHistory("c", "archive");
    expect(f.data.get(counter("archive"))).toBe("2");
    await f.store.append("archive", [user("new")]);
    expect(ordinals(f.data, "archive")).toEqual([1, 3]);
  });

  it("fork preserves corrupt chunk bytes without attempting to repair them", async () => {
    const f = fixture();
    for (const [i, value] of ["invalid json", "null", '{ "opaque": true }'].entries()) {
      f.data.set(chunkKey("c", i + 1), value);
    }
    await f.store.forkHistory("c", "archive");
    for (let seq = 1; seq <= 3; seq++) {
      expect(f.data.get(chunkKey("archive", seq))).toBe(f.data.get(chunkKey("c", seq)));
    }
  });

  it("replaces legacy history with consistent ordinals before further appends", async () => {
    const f = fixture();
    legacy(f.data, 1, 0);
    await f.store.replaceHistory("c", [user("summary"), user("recent")]);
    await f.store.append("c", [user("after")]);
    expect(ordinals(f.data)).toEqual([1, 2, 3]);
    expect(await f.store.load("c")).toEqual([user("summary"), user("recent"), user("after")]);
  });

  it("replacement allocates fresh ordinals without resetting the message counter", async () => {
    const f = fixture();
    await f.store.append("c", [user("old"), user("old2")]);
    await f.store.replaceHistory("c", [user("summary"), user("recent")]);
    await f.store.append("c", [user("after")]);
    expect(await f.store.load("c")).toEqual([user("summary"), user("recent"), user("after")]);
    expect(ordinals(f.data)).toEqual([3, 4, 5]);
    expect(f.data.get(counter())).toBe("5");
    await f.store.replaceHistory("c", []);
    await f.store.append("c", [user("restart")]);
    expect(ordinals(f.data)).toEqual([6]);
  });

  it.each([
    "append",
    "replaceHistory",
    "forkHistory",
  ] as const)("rolls back %s counter together with chunks", async (method) => {
    const f = fixture();
    await f.store.append("c", [user("old")]);
    const before = new Map(f.data);
    f.fail(counter(method === "forkHistory" ? "archive" : "c"));
    await expect(
      method === "forkHistory"
        ? f.store.forkHistory("c", "archive")
        : f.store[method]("c", [user("failed")]),
    ).rejects.toThrow("injected failure");
    expect(f.data).toEqual(before);
    f.fail();
    await f.store.append("c", [user("after")]);
    expect(ordinals(f.data)).toEqual([1, 2]);
  });
});
