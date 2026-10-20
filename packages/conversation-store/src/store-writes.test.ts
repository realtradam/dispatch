import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { chunkKey, metaKey, seqKey } from "./keys.js";
import { type ConversationStore, createConversationStore } from "./store.js";
import { createWriteLock } from "./write-lock.js";

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const message = (text: string): ChatMessage[] => [
  { role: "user", chunks: [{ type: "text", text }] },
];

function fixture() {
  const data = new Map<string, string>();
  const reference = storageFromMap(data);
  let transactions = 0;
  let failKey: string | undefined;
  const storage: StorageNamespace = {
    ...reference,
    transaction: (fn) => {
      transactions++;
      return reference.transaction((tx) =>
        fn({
          ...tx,
          set: (key, value) => {
            if (key === failKey) throw new Error("injected write failure");
            tx.set(key, value);
          },
        }),
      );
    },
  };
  return {
    data,
    store: createConversationStore(storage),
    count: () => transactions,
    fail: (key?: string) => {
      failKey = key;
    },
  };
}

describe("serialized transactional writes", () => {
  it("20 concurrent appends retain every chunk and unique seq 1..20 in one transaction each", async () => {
    const { store, count } = fixture();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append("c", message(String(i)))));
    const rows = await store.loadSince("c");
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rows.map((r) => r.chunk)).toEqual(
      Array.from({ length: 20 }, (_, i) => message(String(i))[0]?.chunks[0]),
    );
    expect(count()).toBe(20);
  });

  it("concurrent creates and deletes preserve all remaining index ids", async () => {
    const { store } = fixture();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.setConversationTitle(String(i), String(i))),
    );
    await Promise.all([store.deleteConversation("0"), store.append("new", message("new"))]);
    expect((await store.listConversations()).map((m) => m.id).sort()).toEqual(
      [...Array.from({ length: 19 }, (_, i) => String(i + 1)), "new"].sort(),
    );
  });

  it("a failed replacement restores old chunks, seq, metadata, index and workspace", async () => {
    const f = fixture();
    await f.store.append("c", message("old"));
    const before = new Map(f.data);
    f.fail(chunkKey("c", 2));
    await expect(
      f.store.replaceHistory("c", [...message("new"), ...message("fail")]),
    ).rejects.toThrow("injected");
    expect(f.data).toEqual(before);
    expect(f.count()).toBe(2);
    f.fail();
    await f.store.append("c", message("after"));
    expect(f.data.get(seqKey("c"))).toBe("2");
  });

  it("a failure at workspace update rolls back the complete append", async () => {
    const f = fixture();
    f.fail("workspace:default");
    await expect(f.store.append("c", message("new"))).rejects.toThrow("injected");
    expect(f.data.size).toBe(0);
  });

  it("metadata, workspace fields, activity and metrics do not lose concurrent updates", async () => {
    const { store } = fixture();
    await Promise.all([
      store.setConversationTitle("c", "title"),
      store.setConversationStatus("c", "active"),
      store.setWorkspaceId("c", "w"),
      store.setCompactedFrom("c", "archive"),
    ]);
    await Promise.all([
      store.append("c", message("hello")),
      store.setWorkspaceTitle("w", "Workspace"),
      store.setWorkspaceDefaultCwd("w", "/work"),
      store.setWorkspaceStarred("w", true),
      ...Array.from({ length: 20 }, (_, i) =>
        store.appendMetrics("c", {
          turnId: String(i),
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: [],
        }),
      ),
    ]);
    expect(await store.getConversationMeta("c")).toMatchObject({
      title: "title",
      status: "active",
      workspaceId: "w",
      compactedFrom: "archive",
    });
    expect(await store.getWorkspace("w")).toMatchObject({
      title: "Workspace",
      defaultCwd: "/work",
      starred: true,
    });
    expect(await store.loadMetrics("c")).toHaveLength(20);
  });

  it("supports source-exclusive fork plus replacement with two atomic writes", async () => {
    const f = fixture();
    await f.store.append("c", message("old"), { turnId: "turn" });
    const original = f.data.get(chunkKey("c", 1));
    const start = f.count();
    await f.store.runExclusive("c", async () => {
      await f.store.forkHistory("c", "archive");
      await f.store.replaceHistory("c", message("summary"));
    });
    expect(f.count() - start).toBe(2);
    expect(f.data.get(chunkKey("archive", 1))).toBe(original);
    expect(await f.store.load("c")).toEqual(message("summary"));
    expect(await f.store.getConversationStatus("archive")).toBe("closed");
  });

  it("fork failure rolls back target writes and index", async () => {
    const f = fixture();
    await f.store.append("c", message("old"));
    const before = new Map(f.data);
    f.fail(metaKey("archive"));
    await expect(f.store.forkHistory("c", "archive")).rejects.toThrow("injected");
    expect(f.data).toEqual(before);
  });

  it("holds exclusion across await, admits nested writes, and queues outsiders FIFO after rejection", async () => {
    const { store } = fixture();
    const entered = gate();
    const release = gate();
    const order: string[] = [];
    const first = store.runExclusive("c", async () => {
      entered.open();
      await release.promise;
      await store.runExclusive("c", async () => {
        await store.append("c", message("nested"));
        order.push("nested");
      });
      throw new Error("release me");
    });
    const rejected = expect(first).rejects.toThrow("release me");
    await entered.promise;
    const second = store.runExclusive("c", () => {
      order.push("second");
      return 42;
    });
    const third = store.runExclusive("c", () => {
      order.push("third");
    });
    expect(await store.runExclusive("other", () => "independent")).toBe("independent");
    expect(order).toEqual([]);
    release.open();
    await rejected;
    expect(await second).toBe(42);
    await third;
    expect(order).toEqual(["nested", "second", "third"]);
  });

  it("escaped async descendants must queue after ownership has expired", async () => {
    const { store } = fixture();
    const escaped = gate();
    const attempted = gate();
    const holding = gate();
    const release = gate();
    const order: string[] = [];
    let descendant: Promise<void> = Promise.resolve();
    await store.runExclusive("c", () => {
      descendant = (async () => {
        await escaped.promise;
        const write = store.runExclusive("c", () => {
          order.push("descendant");
        });
        attempted.open();
        await write;
      })();
    });
    const outsider = store.runExclusive("c", async () => {
      holding.open();
      await release.promise;
      order.push("outsider");
    });
    await holding.promise;
    escaped.open();
    await attempted.promise;
    expect(order).toEqual([]);
    release.open();
    await Promise.all([outsider, descendant]);
    expect(order).toEqual(["outsider", "descendant"]);
  });

  it.each([
    ["cwd", (s) => s.setCwd("c", "/new")],
    ["clear cwd", (s) => s.clearCwd("c")],
    ["computer", (s) => s.setComputerId("c", "remote")],
    ["clear computer", (s) => s.clearComputerId("c")],
    ["effort", (s) => s.setReasoningEffort("c", "high")],
    ["model", (s) => s.setModel("c", "model")],
    ["clear model and snapshot", (s) => s.setModel("c", "")],
    ["group", (s) => s.setTabGroupParentId("c", null)],
    ["parent", (s) => s.setParentConversationId("c", "parent")],
    ["tool policy", (s) => s.setToolPolicy("c", { mode: "all" })],
    [
      "selection",
      (s) => s.setNamedAgentSelection("c", { namedAgentId: "a", namedAgentName: "A", model: "m" }),
    ],
    ["compact percent", (s) => s.setCompactPercent("c", 30)],
    ["transcription", (s) => s.setImageTranscription("c", "url", "text")],
    ["title", (s) => s.setConversationTitle("c", "title")],
    ["status", (s) => s.setConversationStatus("c", "active")],
    ["workspace", (s) => s.setWorkspaceId("c", "other")],
    ["compacted from", (s) => s.setCompactedFrom("c", "archive")],
    ["delete conversation", (s) => s.deleteConversation("c")],
    ["replace", (s) => s.replaceHistory("c", message("new"))],
    ["fork target", (s) => s.forkHistory("source", "c")],
    [
      "metrics",
      (s) =>
        s.appendMetrics("c", {
          turnId: "t",
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: [],
        }),
    ],
    ["model migration", (s) => s.migrateLegacyOpenCodeModels()],
    ["transcription migration", (s) => s.migrateImageTranscriptions()],
    ["workspace deletion", (s) => s.deleteWorkspace("w")],
  ] satisfies Array<
    [string, (store: ConversationStore) => Promise<unknown>]
  >)("%s respects conversation exclusion", async (_name, mutate) => {
    const { store, data } = fixture();
    await store.setWorkspaceId("c", "w");
    data.set("conv:c:model", "opencode/legacy");
    data.set("conv:c:image-transcriptions", JSON.stringify({ url: "legacy" }));
    const entered = gate();
    const release = gate();
    const held = store.runExclusive("c", async () => {
      entered.open();
      await release.promise;
    });
    await entered.promise;
    let done = false;
    const write = mutate(store).then(() => {
      done = true;
    });
    await store.runExclusive("other", () => undefined);
    expect(done).toBe(false);
    release.open();
    await Promise.all([held, write]);
    expect(done).toBe(true);
  });
});

it("pure keyed mutex propagates sync throws and removes idle entries without losing queued waiters", async () => {
  const tails = new Map<string, Promise<void>>();
  const lock = createWriteLock(tails);
  const release = gate();
  const first = lock.runExclusive("c", () => release.promise);
  const failure = lock.runExclusive("c", () => {
    throw new Error("sync");
  });
  const rejected = expect(failure).rejects.toThrow("sync");
  const last = lock.runExclusive("c", () => 7);
  expect(tails.size).toBe(1);
  expect(await lock.runExclusive("other", () => 9)).toBe(9);
  expect(tails.size).toBe(1);
  release.open();
  await first;
  await rejected;
  expect(await last).toBe(7);
  expect(tails.size).toBe(0);
});

describe("deletion notification seam", () => {
  it("notifies only after commit, including retries, and removes new scalar keys", async () => {
    const data = new Map<string, string>();
    const storage = storageFromMap(data);
    let notified = 0;
    const store = createConversationStore(
      storage,
      undefined,
      undefined,
      undefined,
      ({ conversationId }) => {
        expect(conversationId).toBe("c");
        expect([...data.keys()].filter((k) => k.startsWith("conv:c:"))).toEqual([]);
        notified++;
      },
    );
    await store.append("c", message("original"));
    await store.replaceHistory("c", message("replacement"));
    await store.setConversationTitle("keep", "untouched");
    await store.runExclusive("c", () => store.deleteConversation("c"));
    await store.deleteConversation("c");
    expect(notified).toBe(2);
    expect((await store.listConversations()).map((m) => m.id)).toEqual(["keep"]);
  });

  it("rolls back failed deletion without notifying and waits for the same-id owner", async () => {
    const data = new Map<string, string>();
    const storage = storageFromMap(data);
    let fail = false,
      notified = 0;
    const store = createConversationStore(
      {
        ...storage,
        transaction: (fn) =>
          storage.transaction((tx) => {
            const result = fn(tx);
            if (fail) throw new Error("delete failure");
            return result;
          }),
      },
      undefined,
      undefined,
      undefined,
      () => {
        notified++;
      },
    );
    await store.append("c", message("original"));
    const before = new Map(data);
    fail = true;
    await expect(store.deleteConversation("c")).rejects.toThrow("delete failure");
    expect(data).toEqual(before);
    expect(notified).toBe(0);
    fail = false;
    const held = gate(),
      entered = gate();
    const owner = store.runExclusive("c", async () => {
      entered.open();
      await held.promise;
    });
    await entered.promise;
    const deletion = store.deleteConversation("c");
    await Promise.resolve();
    expect(notified).toBe(0);
    held.open();
    await Promise.all([owner, deletion]);
    expect(notified).toBe(1);
  });
});
