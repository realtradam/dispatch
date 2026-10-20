import { createConversationStore } from "@dispatch/conversation-store";
import type { HostAPI, StorageNamespace } from "@dispatch/kernel";
import type { ConversationListResponse } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createApp } from "./app.js";
import { conversationOpened, conversationTabGroupChanged } from "./seam.js";

async function setup() {
  const data = new Map<string, string>();
  const storage: StorageNamespace = {
    ...storageFromMap(data),
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    has: async (key) => data.has(key),
    keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix ?? "")),
  };
  const store = createConversationStore(storage);
  for (const id of ["child", "parent", "ancestor", "other-workspace"]) {
    await store.setConversationTitle(id, id);
    await store.setWorkspaceId(id, id === "other-workspace" ? "elsewhere" : "work");
  }
  await store.setParentConversationId("child", "parent");
  const events: Array<{ hook: unknown; payload: unknown }> = [];
  const emit: HostAPI["emit"] = (hook, payload) => {
    events.push({ hook, payload });
  };
  const app = createApp({
    conversationStore: store,
    // These routes do not invoke orchestrator or credentials.
    orchestrator: {} as Parameters<typeof createApp>[0]["orchestrator"],
    credentialStore: {} as Parameters<typeof createApp>[0]["credentialStore"],
    emit,
  });
  function put(body: unknown, id = "child") {
    return app.request(`/conversations/${id}/tab-group`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return { app, put, store, storage, events };
}

describe("PUT /conversations/:id/tab-group", () => {
  it.each([
    null,
    [],
    "parent",
    1,
    true,
    {},
    { parentId: "" },
    { parentId: "  " },
    { parentId: 4 },
    { parentId: false },
    { parentId: [] },
    { parentId: {} },
  ])("rejects invalid body %j with 400 and no changes", async (body) => {
    const { put, store, events } = await setup();
    expect((await put(body)).status).toBe(400);
    expect(events).toEqual([]);
    expect(await store.getTabGroupParentId("child")).toBe("parent");
  });

  it("rejects invalid JSON", async () => {
    const { app, events } = await setup();
    const res = await app.request("/conversations/child/tab-group", { method: "PUT", body: "{" });
    expect(res.status).toBe(400);
    expect(events).toEqual([]);
  });

  it.each([
    ["child", "child", 400],
    ["missing", null, 404],
    ["missing", "parent", 404],
    ["child", "missing", 404],
    ["child", "other-workspace", 400],
  ])("validates target %s and parent %s (%i)", async (id, parentId, status) => {
    const { put, store, events } = await setup();
    expect((await put({ parentId }, id)).status).toBe(status);
    expect(events).toEqual([]);
    expect(await store.getTabGroupParentId("child")).toBe("parent");
  });

  it("rejects cycles through effective lineage fallback or visual overrides", async () => {
    const { put, store, events } = await setup();
    // child -> parent (lineage fallback); parent -> child would cycle.
    expect((await put({ parentId: "child" }, "parent")).status).toBe(409);
    await store.setTabGroupParentId("ancestor", "child");
    expect((await put({ parentId: "ancestor" }, "parent")).status).toBe(409);
    expect(events).toEqual([]);
    // Explicitly clearing the child hides lineage: this is now acyclic.
    await store.setTabGroupParentId("child", null);
    expect((await put({ parentId: "ancestor" }, "parent")).status).toBe(200);
  });

  it("serializes concurrent graph writes so opposing parents cannot create a cycle", async () => {
    const { put, store, events } = await setup();
    await store.setTabGroupParentId("child", null);
    const results = await Promise.all([
      put({ parentId: "parent" }, "child"),
      put({ parentId: "child" }, "parent"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(events).toHaveLength(1);
    // A rejected write must release the queue so subsequent requests proceed.
    expect((await put({ parentId: null })).status).toBe(200);
  });

  it("bounds traversal through a pre-existing loop", async () => {
    const { put, store } = await setup();
    await store.setTabGroupParentId("parent", "ancestor");
    await store.setTabGroupParentId("ancestor", "parent");
    expect((await put({ parentId: "parent" })).status).toBe(200);
  });

  it("persists overrides and ungrouping, returns null on clear, and emits the typed hook", async () => {
    const { put, store, storage, events } = await setup();
    for (const parentId of ["ancestor", null, "parent"]) {
      const res = await put({ parentId });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ conversationId: "child", tabGroupParentId: parentId });
      expect(await createConversationStore(storage).getTabGroupParentId("child")).toBe(parentId);
      expect(events.at(-1)).toEqual({
        hook: conversationTabGroupChanged,
        payload: {
          conversationId: "child",
          workspaceId: "work",
          tabGroupParentId: parentId,
        },
      });
      expect(await store.getParentConversationId("child")).toBe("parent");
      expect(await store.listChildren("parent")).toEqual(["child"]);
    }
    expect(events).toHaveLength(3);
  });

  it("exposes effective grouping and lineage on GET /conversations, omitting grouping after clear", async () => {
    const { app, put } = await setup();
    const list = async () =>
      (await (await app.request("/conversations")).json()) as ConversationListResponse;
    expect((await list()).conversations.find((m) => m.id === "child")).toMatchObject({
      parentConversationId: "parent",
      tabGroupParentId: "parent",
    });
    await put({ parentId: "ancestor" });
    expect((await list()).conversations.find((m) => m.id === "child")).toHaveProperty(
      "tabGroupParentId",
      "ancestor",
    );
    await put({ parentId: null });
    const meta = (await list()).conversations.find((m) => m.id === "child");
    expect(meta).toHaveProperty("parentConversationId", "parent");
    expect(meta).not.toHaveProperty("tabGroupParentId");
  });

  it("does not write when the broadcast capability is unavailable", async () => {
    const { store } = await setup();
    const app = createApp({
      conversationStore: store,
      orchestrator: {} as Parameters<typeof createApp>[0]["orchestrator"],
      credentialStore: {} as Parameters<typeof createApp>[0]["credentialStore"],
    });
    expect(
      (
        await app.request("/conversations/child/tab-group", {
          method: "PUT",
          body: JSON.stringify({ parentId: null }),
        })
      ).status,
    ).toBe(500);
    expect(await store.getTabGroupParentId("child")).toBe("parent");
  });

  it("returns 500 without broadcasting when persistence fails", async () => {
    const { put, storage, events } = await setup();
    storage.set = async () => {
      throw new Error("storage unavailable");
    };
    expect((await put({ parentId: null })).status).toBe(500);
    expect(events).toEqual([]);
  });
});

describe("POST /conversations/:id/open visual grouping", () => {
  it("includes the effective parent and omits it for explicitly ungrouped conversations", async () => {
    const { app, store, events } = await setup();
    for (const parentId of ["parent", "ancestor", null]) {
      if (parentId !== "parent") await store.setTabGroupParentId("child", parentId);
      expect((await app.request("/conversations/child/open", { method: "POST" })).status).toBe(200);
      expect(events.at(-1)).toEqual({
        hook: conversationOpened,
        payload: {
          conversationId: "child",
          workspaceId: "work",
          ...(parentId !== null ? { tabGroupParentId: parentId } : {}),
        },
      });
    }
  });
});
