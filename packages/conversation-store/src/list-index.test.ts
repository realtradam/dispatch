import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { initializeConversationListIndex } from "./list-index.js";
import { createConversationStore } from "./store.js";

const message: ChatMessage[] = [{ role: "user", chunks: [{ type: "text", text: "hello" }] }];
const meta = (title: string) =>
  JSON.stringify({ createdAt: 1, lastActivityAt: 2, title, status: "idle" });

function fixture(data = new Map<string, string>()) {
  const reference = storageFromMap(data);
  const reads: string[] = [];
  let fail = "";
  let scans = 0;
  const storage: StorageNamespace = {
    ...reference,
    get: (key) => {
      reads.push(key);
      return reference.get(key);
    },
    keys: (prefix) => {
      reads.push(`keys:${prefix}`);
      return reference.keys(prefix);
    },
    entries: (prefix, opts) => {
      reads.push(prefix);
      if (prefix === "conv:") throw new Error("steady-state chunk scan");
      return reference.entries(prefix, opts);
    },
    transaction: (fn) =>
      reference.transaction((tx) =>
        fn({
          ...tx,
          entries: (prefix, opts) => {
            if (prefix === "conv:") scans++;
            return tx.entries(prefix, opts);
          },
          delete: (key) => {
            if (key === fail) throw new Error("injected projection failure");
            tx.delete(key);
          },
          set: (key, value) => {
            if (key === fail) throw new Error("injected projection failure");
            tx.set(key, value);
          },
        }),
      ),
  };
  return {
    data,
    storage,
    reads,
    scans: () => scans,
    store: createConversationStore(storage, undefined, () => 10),
    fail: (key = "") => {
      fail = key;
    },
  };
}

describe("conversation listing index", () => {
  it("preserves index ties, duplicate counts, missing meta children, corruption and overrides", async () => {
    const f = fixture(
      new Map([
        ["conv-index", JSON.stringify(["b", "a", "b", "missing", "bad", 7])],
        ["conv:a:meta", meta("A")],
        ["conv:b:meta", meta("B")],
        ["conv:bad:meta", "invalid"],
        ["conv:a:model", ""],
        ["conv:a:parent", "root"],
        ["conv:b:parent", "root"],
        ["conv:missing:parent", "root"],
        ["conv:a:tab-group-parent", ""],
        ["conv:b:tab-group-parent", "visual"],
        ["conv:orphan:meta", meta("invisible")],
        ["conv:a:chunk:0000000001", "not parsed"],
      ]),
    );
    expect(JSON.stringify(await f.store.listConversations())).toBe(
      JSON.stringify([
        {
          id: "b",
          createdAt: 1,
          lastActivityAt: 2,
          title: "B",
          status: "idle",
          workspaceId: "default",
          parentConversationId: "root",
          tabGroupParentId: "visual",
        },
        {
          id: "a",
          createdAt: 1,
          lastActivityAt: 2,
          title: "A",
          status: "idle",
          workspaceId: "default",
          model: "",
          parentConversationId: "root",
        },
      ]),
    );
    expect(await f.store.listChildren("root")).toEqual(["b", "a", "missing"]);
    expect((await f.store.listWorkspaces())[0]?.conversationCount).toBe(3);
    expect(await f.store.listConversations({ status: ["closed"] })).toEqual([]);
    expect(await f.store.listConversations({ workspaceId: "other" })).toEqual([]);
    f.reads.length = 0;
    await f.store.listConversations();
    await f.store.listChildren("root");
    await f.store.listWorkspaces();
    expect(f.reads).toEqual([
      "meta-index-version",
      "meta:",
      "conv-index",
      "meta-index-version",
      "meta:",
      "conv-index",
      "meta-index-version",
      "meta:",
      "workspace:",
      "conv-index",
    ]);
  });

  it("keeps counts and enrichment current through create, move, fork, replacement and deletes", async () => {
    const f = fixture();
    await f.store.listConversations();
    await f.store.ensureWorkspace("work");
    await f.store.append("a", message);
    await f.store.setWorkspaceId("a", "work");
    await f.store.setModel("a", "opencode/model");
    await f.store.migrateLegacyOpenCodeModels();
    await f.store.setParentConversationId("a", "root");
    await f.store.setTabGroupParentId("a", null);
    await f.store.forkHistory("a", "archive");
    await f.store.replaceHistory("a", message);
    await f.store.setConversationTitle("a", "Title");
    await f.store.setConversationStatus("a", "active");
    await f.store.setCompactedFrom("a", "archive");
    expect((await f.store.listWorkspaces()).find((w) => w.id === "work")?.conversationCount).toBe(
      2,
    );
    const listed = (await f.store.listConversations()).find((m) => m.id === "a");
    expect(listed).toEqual(await f.store.getConversationMeta("a"));
    expect(listed).toMatchObject({ model: "opencode-1/model", parentConversationId: "root" });
    expect(listed).not.toHaveProperty("tabGroupParentId");
    await f.store.setModel("a", "");
    await f.store.setTabGroupParentId("a", "group");
    await f.store.setParentConversationId("a", "other");
    expect((await f.store.listConversations()).find((m) => m.id === "a")).toEqual(
      await f.store.getConversationMeta("a"),
    );
    expect(await f.store.listChildren("other")).toEqual(["a"]);
    await f.store.deleteConversation("archive");
    expect((await f.store.listWorkspaces()).find((w) => w.id === "work")?.conversationCount).toBe(
      1,
    );
    await f.store.deleteWorkspace("work");
    expect((await f.store.listWorkspaces())[0]?.conversationCount).toBe(1);
    expect((await f.store.listConversations())[0]).toMatchObject({
      status: "closed",
      workspaceId: "default",
    });
    await f.store.deleteConversation("a");
    expect(await f.store.listConversations()).toEqual([]);
    expect(await f.store.listChildren("other")).toEqual([]);
  });

  it("rolls back projection failures with canonical writes and retries failed bootstrap", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a"]'],
        ["conv:a:meta", meta("A")],
      ]),
    );
    const before = new Map(f.data);
    f.fail("meta:a");
    await expect(f.store.listConversations()).rejects.toThrow("injected projection failure");
    expect(f.data).toEqual(before);
    f.fail();
    await f.store.listConversations();
    const initialized = new Map(f.data);
    f.fail("meta:a");
    await expect(f.store.append("a", message)).rejects.toThrow("injected projection failure");
    expect(f.data).toEqual(initialized);
    await expect(f.store.setModel("a", "changed")).rejects.toThrow("injected projection failure");
    expect(f.data).toEqual(initialized);
  });

  it("backfills once across concurrent callers/recreation and supports read-only steady state", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a"]'],
        ["conv:a:meta", meta("A")],
      ]),
    );
    await Promise.all([
      initializeConversationListIndex(f.storage),
      initializeConversationListIndex(f.storage),
      f.store.setModel("a", "model"),
    ]);
    expect(f.scans()).toBe(1);
    const before = new Map(f.data);
    await initializeConversationListIndex(f.storage);
    const readOnly: StorageNamespace = {
      ...f.storage,
      transaction: () => {
        throw new Error("unexpected transaction");
      },
    };
    const reopened = createConversationStore(readOnly);
    expect(await reopened.listConversations()).toEqual(await f.store.listConversations());
    await reopened.listChildren("root");
    await reopened.listWorkspaces();
    expect(f.data).toEqual(before);
    expect(f.scans()).toBe(1);
  });

  it.each([
    "fork",
    "workspace",
    "delete",
    "parent",
    "group",
  ])("%s projection failure rolls back its complete transaction", async (operation) => {
    const f = fixture();
    await f.store.ensureWorkspace("work");
    await f.store.append("a", message);
    await f.store.setWorkspaceId("a", "work");
    await f.store.listConversations();
    const before = new Map(f.data);
    f.fail(operation === "fork" ? "meta:archive" : "meta:a");
    const write =
      operation === "fork"
        ? () => f.store.forkHistory("a", "archive")
        : operation === "workspace"
          ? () => f.store.deleteWorkspace("work")
          : operation === "delete"
            ? () => f.store.deleteConversation("a")
            : operation === "parent"
              ? () => f.store.setParentConversationId("a", "root")
              : () => f.store.setTabGroupParentId("a", "group");
    await expect(write()).rejects.toThrow("injected projection failure");
    expect(f.data).toEqual(before);
  });
});
