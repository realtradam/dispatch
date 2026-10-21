import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { createBus, createHost, createLogger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { extension } from "./extension.js";
import { initializeConversationListIndex } from "./list-index.js";
import { conversationStoreHandle, createConversationStore } from "./store.js";

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
      set: async () => {
        throw new Error("unexpected write");
      },
      delete: async () => {
        throw new Error("unexpected delete");
      },
      transaction: () => {
        throw new Error("unexpected transaction");
      },
    };
    await initializeConversationListIndex(readOnly);
    const reopened = createConversationStore(readOnly);
    expect(await reopened.listConversations()).toEqual(await f.store.listConversations());
    await reopened.listChildren("root");
    await reopened.listWorkspaces();
    expect(f.data).toEqual(before);
    expect(f.scans()).toBe(1);
  });

  it("repairs older-writer drift on the next activation, not just a changed row count", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a","deleted","missing-meta"]'],
        ["conv:a:meta", meta("A")],
        ["conv:a:model", "old-model"],
        ["conv:a:parent", "old-root"],
        ["conv:a:tab-group-parent", "old-group"],
        ["conv:deleted:meta", meta("Deleted")],
        ["conv:missing-meta:parent", "old-root"],
      ]),
    );
    await initializeConversationListIndex(f.storage);
    // Simulate a rolled-back binary: canonical rows/index only, marker untouched.
    f.data.set(
      "conv:a:meta",
      JSON.stringify({
        createdAt: 1,
        lastActivityAt: 99,
        title: "Renamed",
        status: "active",
        workspaceId: "work",
      }),
    );
    f.data.set("conv:a:model", "new-model");
    f.data.set("conv:a:parent", "new-root");
    f.data.set("conv:a:tab-group-parent", "");
    f.data.set("conv:new:meta", meta("New"));
    f.data.set("conv:missing-meta:parent", "new-root");
    f.data.delete("conv:deleted:meta");
    f.data.set("conv-index", '["a","new","missing-meta"]');
    await initializeConversationListIndex(f.storage);
    const reopened = createConversationStore(f.storage);
    expect(await reopened.listConversations()).toEqual([
      await reopened.getConversationMeta("a"),
      await reopened.getConversationMeta("new"),
    ]);
    expect((await reopened.listConversations({ status: ["active"] }))[0]).toMatchObject({
      id: "a",
      title: "Renamed",
      lastActivityAt: 99,
      model: "new-model",
      parentConversationId: "new-root",
    });
    expect((await reopened.listConversations())[0]).not.toHaveProperty("tabGroupParentId");
    expect(await reopened.listChildren("old-root")).toEqual([]);
    expect(await reopened.listChildren("new-root")).toEqual(["a", "missing-meta"]);
    expect(f.data.has("meta:deleted")).toBe(false);
    expect(await reopened.listWorkspaces()).toMatchObject([
      { id: "default", conversationCount: 1 },
    ]);
    // Deleting scalars must restore the canonical absent-value defaults too.
    f.data.delete("conv:a:model");
    f.data.delete("conv:a:parent");
    f.data.delete("conv:a:tab-group-parent");
    await initializeConversationListIndex(f.storage);
    expect((await reopened.listConversations())[0]).toEqual(
      await reopened.getConversationMeta("a"),
    );
    expect((await reopened.listConversations())[0]).not.toHaveProperty("model");
  });

  it("repairs same-count drift, corrupt projections and meta-only deletions atomically", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a","b"]'],
        ["conv:a:meta", meta("A")],
        ["conv:b:meta", meta("B")],
      ]),
    );
    await initializeConversationListIndex(f.storage);
    f.data.set("conv:a:meta", meta("Changed"));
    f.data.set("meta:b", "invalid projection");
    const before = new Map(f.data);
    f.fail("meta:b");
    await expect(initializeConversationListIndex(f.storage)).rejects.toThrow(
      "injected projection failure",
    );
    expect(f.data).toEqual(before);
    f.fail();
    await initializeConversationListIndex(f.storage);
    expect((await f.store.listConversations()).map((row) => row.title)).toEqual(["Changed", "B"]);
    // Even a legacy deletion that leaves a dangling conv-index id cannot retain stale meta.
    f.data.delete("conv:a:meta");
    await initializeConversationListIndex(f.storage);
    expect((await f.store.listConversations()).map((row) => row.id)).toEqual(["b"]);
    expect(f.data.has("meta:a")).toBe(false);
  });

  it.each([
    ["meta", meta("Changed")],
    ["model", "model"],
    ["parent", "root"],
    ["tab-group-parent", "group"],
    ["tab-group-parent", ""],
  ])("detects isolated same-count %s drift (%s) and repairs only changed rows", async (field, value) => {
    const f = fixture(
      new Map([
        ["conv-index", '["a","unchanged"]'],
        ["conv:a:meta", meta("A")],
        ["conv:unchanged:meta", meta("Unchanged")],
        ["conv:a:parent", "original"],
      ]),
    );
    await initializeConversationListIndex(f.storage);
    f.data.set(`conv:a:${field}`, value);
    f.fail("meta:unchanged");
    await initializeConversationListIndex(f.storage);
    expect((await f.store.listConversations()).find((row) => row.id === "a")).toEqual(
      await f.store.getConversationMeta("a"),
    );
    expect(f.scans()).toBe(1);
  });

  it("discovers an isolated older-writer creation from conv-index and removes an isolated deletion", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a"]'],
        ["conv:a:meta", meta("A")],
      ]),
    );
    await initializeConversationListIndex(f.storage);
    f.data.set("conv:b:meta", meta("B"));
    f.data.set("conv-index", '["a","b"]');
    await initializeConversationListIndex(f.storage);
    expect((await f.store.listConversations()).map((row) => row.id)).toEqual(["a", "b"]);
    f.data.delete("conv:b:meta");
    f.data.set("conv-index", '["a"]');
    await initializeConversationListIndex(f.storage);
    expect((await f.store.listConversations()).map((row) => row.id)).toEqual(["a"]);
    expect(f.data.has("meta:b")).toBe(false);
    expect(f.scans()).toBe(1);
  });

  it("rechecks canonical rows inside repair instead of committing a stale snapshot", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a"]'],
        ["conv:a:meta", meta("A")],
      ]),
    );
    await initializeConversationListIndex(f.storage);
    f.data.set("conv:a:meta", meta("Older writer"));
    const concurrent: StorageNamespace = {
      ...f.storage,
      transaction: (fn) => {
        f.data.set("conv:a:meta", meta("Latest writer"));
        return f.storage.transaction(fn);
      },
    };
    await initializeConversationListIndex(concurrent);
    expect((await f.store.listConversations())[0]?.title).toBe("Latest writer");
  });

  it("validates before the real extension boot status sweep and service publication", async () => {
    const f = fixture(
      new Map([
        ["conv-index", '["a"]'],
        ["conv:a:meta", meta("A")],
      ]),
    );
    await initializeConversationListIndex(f.storage);
    f.data.set(
      "conv:a:meta",
      JSON.stringify({
        createdAt: 1,
        lastActivityAt: 200,
        title: "Resumed",
        status: "active",
      }),
    );
    f.data.set("conv:new:meta", meta("New"));
    f.data.set("conv-index", '["a","new"]');
    const logSink = { emit: () => {} };
    const logDeps = { now: () => 0, newId: () => "test" };
    const logger = createLogger({ extensionId: "test" }, logSink, logDeps);
    const host = createHost([extension], {
      logger,
      logSink,
      logDeps,
      bus: createBus(logger),
      storageFactory: () => f.storage,
      config: { get: () => undefined, getAll: () => ({}) },
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
      permissions: { check: async () => ({ allowed: true }) },
      scheduler: { register: () => {}, unregister: () => {} },
      events: { emit: () => {} },
    });
    await host.activate();
    try {
      expect(host.getDisabled()).toEqual([]);
      const store = host.getHostAPI().getService(conversationStoreHandle);
      expect(
        (await store.listConversations()).map(({ id, status, title }) => ({ id, status, title })),
      ).toEqual([
        { id: "a", status: "idle", title: "Resumed" },
        { id: "new", status: "idle", title: "New" },
      ]);
      expect((await store.listConversations())[0]).toEqual(await store.getConversationMeta("a"));
    } finally {
      await host.deactivate();
    }
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
