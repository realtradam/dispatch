import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { createConversationStore, isValidWorkspaceSlug } from "./store.js";

function createMemoryStorage(): StorageNamespace {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    has: async (key) => data.has(key),
    keys: async (prefix) => {
      const all = [...data.keys()];
      if (!prefix) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
  };
}

describe("WorkspaceStore", () => {
  let storage: StorageNamespace;
  let clock: number;

  beforeEach(() => {
    storage = createMemoryStorage();
    clock = 1000;
  });

  function makeStore(serverDefaultCwd?: string) {
    return createConversationStore(storage, undefined, () => clock, serverDefaultCwd);
  }

  function userMessage(text: string): ChatMessage {
    return { role: "user", chunks: [{ type: "text", text }] };
  }

  it("ensureWorkspace creates with defaults", async () => {
    const store = makeStore();
    clock = 1000;
    const ws = await store.ensureWorkspace("my-work");
    expect(ws).toEqual({
      id: "my-work",
      title: "my-work",
      defaultCwd: null,
      defaultComputerId: null,
      starred: false,
      createdAt: 1000,
      lastActivityAt: 1000,
    });
  });

  it("ensureWorkspace returns existing as-is", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work");
    clock = 2000;
    const ws = await store.ensureWorkspace("my-work", {
      title: "New Title",
      defaultCwd: "/ignored",
    });
    expect(ws).toEqual({
      id: "my-work",
      title: "my-work",
      defaultCwd: null,
      defaultComputerId: null,
      starred: false,
      createdAt: 1000,
      lastActivityAt: 1000,
    });
  });

  it("ensureWorkspace with custom title/defaultCwd", async () => {
    const store = makeStore();
    clock = 3000;
    const ws = await store.ensureWorkspace("my-work", {
      title: "Custom",
      defaultCwd: "/projects/dispatch",
    });
    expect(ws).toEqual({
      id: "my-work",
      title: "Custom",
      defaultCwd: "/projects/dispatch",
      defaultComputerId: null,
      starred: false,
      createdAt: 3000,
      lastActivityAt: 3000,
    });
  });

  it("getWorkspace synthesizes default", async () => {
    const store = makeStore();
    const ws = await store.getWorkspace("default");
    expect(ws).toEqual({
      id: "default",
      title: "default",
      defaultCwd: null,
      defaultComputerId: null,
      starred: false,
      createdAt: 0,
      lastActivityAt: 0,
    });
  });

  it("getWorkspace returns null for unknown", async () => {
    const store = makeStore();
    expect(await store.getWorkspace("unknown")).toBeNull();
  });

  it("setWorkspaceTitle renames", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work");
    clock = 2000;
    const ws = await store.setWorkspaceTitle("my-work", "Renamed");
    expect(ws).toEqual({
      id: "my-work",
      title: "Renamed",
      defaultCwd: null,
      defaultComputerId: null,
      starred: false,
      createdAt: 1000,
      lastActivityAt: 1000,
    });
  });

  it("setWorkspaceDefaultCwd sets and clears", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work");
    clock = 2000;
    const setWs = await store.setWorkspaceDefaultCwd("my-work", "/some/path");
    expect(setWs.defaultCwd).toBe("/some/path");
    expect(setWs.lastActivityAt).toBe(1000); // does not bump on defaultCwd change
    const cleared = await store.setWorkspaceDefaultCwd("my-work", null);
    expect(cleared.defaultCwd).toBeNull();
  });

  it("deleteWorkspace closes conversations", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("work-a");
    await store.setWorkspaceId("conv1", "work-a");
    await store.setWorkspaceId("conv2", "work-a");
    await store.setWorkspaceId("conv3", "default");

    clock = 2000;
    await store.append("conv1", [userMessage("hi 1")]);
    await store.append("conv2", [userMessage("hi 2")]);
    await store.append("conv3", [userMessage("hi 3")]);

    const result = await store.deleteWorkspace("work-a");
    expect(result.closedCount).toBe(2);

    const meta1 = await store.getConversationMeta("conv1");
    expect(meta1?.status).toBe("closed");
    expect(meta1?.workspaceId).toBe("default");

    const meta2 = await store.getConversationMeta("conv2");
    expect(meta2?.status).toBe("closed");
    expect(meta2?.workspaceId).toBe("default");

    const meta3 = await store.getConversationMeta("conv3");
    expect(meta3?.status).toBe("idle");
    expect(meta3?.workspaceId).toBe("default");

    expect(await store.getWorkspace("work-a")).toBeNull();
  });

  it("deleteWorkspace throws for default", async () => {
    const store = makeStore();
    await expect(store.deleteWorkspace("default")).rejects.toThrow();
  });

  it("listWorkspaces sorted by lastActivityAt desc", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("alpha");
    clock = 2000;
    await store.ensureWorkspace("beta");
    clock = 3000;
    await store.ensureWorkspace("gamma");

    const list = await store.listWorkspaces();
    expect(list.map((w) => w.id)).toEqual(["gamma", "beta", "alpha", "default"]);
  });

  it("listWorkspaces includes conversationCount", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("work-a");
    await store.ensureWorkspace("work-b");
    await store.setWorkspaceId("a1", "work-a");
    await store.setWorkspaceId("a2", "work-a");
    await store.setWorkspaceId("b1", "work-b");
    await store.append("lonely", [userMessage("hi")]); // defaults to "default"

    const list = await store.listWorkspaces();
    const counts = Object.fromEntries(list.map((w) => [w.id, w.conversationCount]));
    expect(counts["work-a"]).toBe(2);
    expect(counts["work-b"]).toBe(1);
    expect(counts.default).toBe(1);
  });

  it("listWorkspaces always includes default", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("only");
    // No append or explicit default creation — default is synthesized.
    const list = await store.listWorkspaces();
    const ids = list.map((w) => w.id);
    expect(ids).toContain("default");
    const defaultWs = list.find((w) => w.id === "default");
    expect(defaultWs).toEqual({
      id: "default",
      title: "default",
      defaultCwd: null,
      defaultComputerId: null,
      starred: false,
      createdAt: 0,
      lastActivityAt: 0,
      conversationCount: 0,
    });
  });

  it("getWorkspaceId returns default for legacy", async () => {
    const store = makeStore();
    await store.append("conv1", [userMessage("hi")]);
    expect(await store.getWorkspaceId("conv1")).toBe("default");
    expect(await store.getWorkspaceId("never-seen")).toBe("default");
  });

  it("setWorkspaceId persists and reads back", async () => {
    const store = makeStore();
    clock = 1000;
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getWorkspaceId("conv1")).toBe("my-work");
    const meta = await store.getConversationMeta("conv1");
    expect(meta?.workspaceId).toBe("my-work");
    expect(meta?.status).toBe("idle");
  });

  it("getEffectiveCwd: absolute conversation cwd overrides workspace defaultCwd", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "/explicit/path");
    expect(await store.getEffectiveCwd("conv1")).toBe("/explicit/path");
  });

  it("getEffectiveCwd: workspace defaultCwd used when conversation cwd is unset (bug fix)", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/default");
  });

  it("getEffectiveCwd: serverDefaultCwd fallback when both conversation and workspace cwd are null", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getEffectiveCwd("conv1")).toBe("/server/default");
  });

  it("getEffectiveCwd: relative conversation cwd resolved against workspace defaultCwd", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "subdir");
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/root/subdir");
  });

  it("getEffectiveCwd: relative conversation cwd resolved against serverDefaultCwd when workspace defaultCwd is null", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "subdir");
    expect(await store.getEffectiveCwd("conv1")).toBe("/server/default/subdir");
  });

  it("getEffectiveCwd: relative cwd with nested segments resolved against workspace defaultCwd", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "a/b/c");
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/root/a/b/c");
  });

  it("getEffectiveCwd: relative cwd with .. segments normalizes via path.resolve", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root/sub" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "../sibling");
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/root/sibling");
  });

  it("getEffectiveCwd: default workspace (no defaultCwd) falls through to serverDefaultCwd", async () => {
    const store = makeStore("/server/default");
    // No explicit workspace assignment — defaults to "default" workspace
    // which has defaultCwd null.
    expect(await store.getEffectiveCwd("conv1")).toBe("/server/default");
  });

  // --- overrideCwd (per-turn cwd override) ---

  it("getEffectiveCwd: overrideCwd absolute (starts with /) returned as-is, overriding workspace defaultCwd", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
    await store.setWorkspaceId("conv1", "my-work");
    // An absolute override wins outright, even over a workspace defaultCwd.
    expect(await store.getEffectiveCwd("conv1", "/override/abs")).toBe("/override/abs");
  });

  it("getEffectiveCwd: overrideCwd relative resolved against workspace defaultCwd", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root" });
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getEffectiveCwd("conv1", "subdir")).toBe("/workspace/root/subdir");
  });

  it("getEffectiveCwd: overrideCwd relative resolved against serverDefaultCwd when workspace defaultCwd is null", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getEffectiveCwd("conv1", "subdir")).toBe("/server/default/subdir");
  });

  it("getEffectiveCwd: overrideCwd does NOT read the persisted getCwd (override wins over persisted)", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root" });
    await store.setWorkspaceId("conv1", "my-work");
    // Persist a cwd that differs from the override — the override must win.
    await store.setCwd("conv1", "/persisted/path");
    expect(await store.getEffectiveCwd("conv1", "override-rel")).toBe(
      "/workspace/root/override-rel",
    );
  });

  it("getEffectiveCwd: overrideCwd omitted behaves as today (uses persisted cwd)", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "persisted-rel");
    // No second arg — persisted cwd is used.
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/root/persisted-rel");
  });

  it("clearCwd → getEffectiveCwd falls through to workspace defaultCwd (un-shadows it)", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setCwd("conv1", "/explicit/path");
    // Before clear: the conversation cwd shadows the workspace defaultCwd.
    expect(await store.getEffectiveCwd("conv1")).toBe("/explicit/path");
    // After clear: the workspace defaultCwd is used (fall-through).
    await store.clearCwd("conv1");
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/default");
  });

  it("getEffectiveCwd: an empty-string cwd does NOT fall through (proving clear ≠ setCwd(''))", async () => {
    const store = makeStore("/server/default");
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
    await store.setWorkspaceId("conv1", "my-work");
    // An empty string is a non-null explicit cwd — it is resolved (not
    // treated as absent), so it does NOT fall through to the workspace
    // defaultCwd. This is the gap clearCwd fixes.
    await store.setCwd("conv1", "");
    expect(await store.getCwd("conv1")).toBe("");
    // path.resolve("/workspace/default", "") === "/workspace/default" —
    // but this is a RELATIVE cwd resolution, not a fall-through. The point
    // is that getCwd returns "" (not null), so the relative branch runs.
    // With a clearCwd, getCwd returns null and the fall-through branch runs.
    await store.clearCwd("conv1");
    expect(await store.getCwd("conv1")).toBeNull();
    expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/default");
  });

  it("listConversations filtered by workspaceId", async () => {
    const store = makeStore();
    await store.ensureWorkspace("work-a");
    await store.ensureWorkspace("work-b");
    await store.append("a1", [userMessage("a1")]);
    await store.append("a2", [userMessage("a2")]);
    await store.append("b1", [userMessage("b1")]);
    await store.setWorkspaceId("a1", "work-a");
    await store.setWorkspaceId("a2", "work-a");
    await store.setWorkspaceId("b1", "work-b");

    const aConvs = await store.listConversations({ workspaceId: "work-a" });
    expect(aConvs.map((c) => c.id).sort()).toEqual(["a1", "a2"]);

    const bConvs = await store.listConversations({ workspaceId: "work-b" });
    expect(bConvs.map((c) => c.id)).toEqual(["b1"]);
  });

  it("append updates workspace lastActivityAt", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work");
    clock = 2000;
    await store.setWorkspaceId("conv1", "my-work");
    clock = 3000;
    await store.append("conv1", [userMessage("hi")]);
    const ws = await store.getWorkspace("my-work");
    expect(ws?.lastActivityAt).toBe(3000);
  });

  it("forkHistory copies workspaceId", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceId("source", "my-work");
    await store.append("source", [userMessage("hello")]);
    await store.forkHistory("source", "target");
    const targetMeta = await store.getConversationMeta("target");
    expect(targetMeta?.workspaceId).toBe("my-work");
  });

  it("replaceHistory preserves workspaceId", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceId("conv1", "my-work");
    await store.append("conv1", [userMessage("original")]);
    await store.replaceHistory("conv1", [userMessage("replaced")]);
    const meta = await store.getConversationMeta("conv1");
    expect(meta?.workspaceId).toBe("my-work");
  });

  // --- starred (priority for concurrency limiting) ---

  it("ensureWorkspace creates with starred: false", async () => {
    const store = makeStore();
    const ws = await store.ensureWorkspace("star-work");
    expect(ws.starred).toBe(false);
  });

  it("setWorkspaceStarred true persists and reads back", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("star-work");
    clock = 2000;
    const ws = await store.setWorkspaceStarred("star-work", true);
    expect(ws.starred).toBe(true);
    expect(ws.id).toBe("star-work");
    const reRead = await store.getWorkspace("star-work");
    expect(reRead?.starred).toBe(true);
  });

  it("setWorkspaceStarred false unstars a previously starred workspace", async () => {
    const store = makeStore();
    await store.ensureWorkspace("star-work");
    await store.setWorkspaceStarred("star-work", true);
    await store.setWorkspaceStarred("star-work", false);
    const ws = await store.getWorkspace("star-work");
    expect(ws?.starred).toBe(false);
  });

  it("setWorkspaceStarred creates the workspace if missing", async () => {
    const store = makeStore();
    clock = 5000;
    const ws = await store.setWorkspaceStarred("brand-new", true);
    expect(ws).toEqual({
      id: "brand-new",
      title: "brand-new",
      defaultCwd: null,
      defaultComputerId: null,
      starred: true,
      createdAt: 5000,
      lastActivityAt: 5000,
    });
  });

  it("setWorkspaceStarred preserves title/defaultCwd/defaultComputerId", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work", {
      title: "Custom",
      defaultCwd: "/projects",
      defaultComputerId: "myserver",
    });
    clock = 2000;
    const ws = await store.setWorkspaceStarred("my-work", true);
    expect(ws.title).toBe("Custom");
    expect(ws.defaultCwd).toBe("/projects");
    expect(ws.defaultComputerId).toBe("myserver");
    expect(ws.starred).toBe(true);
    expect(ws.createdAt).toBe(1000);
  });

  it("listWorkspaces includes starred field", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("alpha");
    await store.setWorkspaceStarred("alpha", true);
    clock = 2000;
    await store.ensureWorkspace("beta");
    const list = await store.listWorkspaces();
    const alpha = list.find((w) => w.id === "alpha");
    expect(alpha?.starred).toBe(true);
    const beta = list.find((w) => w.id === "beta");
    expect(beta?.starred).toBe(false);
  });

  it("setWorkspaceTitle preserves starred state", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceStarred("my-work", true);
    const ws = await store.setWorkspaceTitle("my-work", "Renamed");
    expect(ws.starred).toBe(true);
    expect(ws.title).toBe("Renamed");
  });

  it("setWorkspaceDefaultCwd preserves starred state", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceStarred("my-work", true);
    const ws = await store.setWorkspaceDefaultCwd("my-work", "/new/path");
    expect(ws.starred).toBe(true);
    expect(ws.defaultCwd).toBe("/new/path");
  });

  it("setWorkspaceDefaultComputerId preserves starred state", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceStarred("my-work", true);
    const ws = await store.setWorkspaceDefaultComputerId("my-work", "new-host");
    expect(ws.starred).toBe(true);
    expect(ws.defaultComputerId).toBe("new-host");
  });

  it("a legacy WorkspaceRow without starred reads back as false", async () => {
    const store = makeStore();
    // Simulate a legacy row persisted before `starred` existed.
    await storage.set(
      "workspace:legacy",
      JSON.stringify({
        title: "legacy",
        defaultCwd: "/legacy/cwd",
        defaultComputerId: null,
        createdAt: 100,
        lastActivityAt: 200,
      }),
    );
    const ws = await store.getWorkspace("legacy");
    expect(ws?.starred).toBe(false);
  });
});

describe("ComputerStore", () => {
  let storage: StorageNamespace;
  let clock: number;

  beforeEach(() => {
    storage = createMemoryStorage();
    clock = 1000;
  });

  function makeStore() {
    return createConversationStore(storage, undefined, () => clock);
  }

  // --- per-conversation computerId (mirror getCwd/setCwd/clearCwd) ---

  it("setComputerId/getComputerId round-trips an alias", async () => {
    const store = makeStore();
    expect(await store.getComputerId("conv1")).toBeNull();
    await store.setComputerId("conv1", "myserver");
    expect(await store.getComputerId("conv1")).toBe("myserver");
  });

  it("setComputerId(null) clears (is idempotent local sentinel, like clearComputerId)", async () => {
    const store = makeStore();
    await store.setComputerId("conv1", "myserver");
    expect(await store.getComputerId("conv1")).toBe("myserver");
    // null is the "local" sentinel: it clears the persisted key so it does
    // NOT linger to shadow the workspace defaultComputerId.
    await store.setComputerId("conv1", null);
    expect(await store.getComputerId("conv1")).toBeNull();
    // idempotent — clearing an already-absent key is a no-op.
    await store.setComputerId("conv1", null);
    expect(await store.getComputerId("conv1")).toBeNull();
  });

  it("clearComputerId is idempotent and un-shadows the workspace default", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setComputerId("conv1", "per-conv-host");
    expect(await store.getEffectiveComputer("conv1")).toBe("per-conv-host");
    // After clear: the workspace defaultComputerId is used (fall-through).
    await store.clearComputerId("conv1");
    expect(await store.getComputerId("conv1")).toBeNull();
    expect(await store.getEffectiveComputer("conv1")).toBe("ws-host");
    // idempotent — deleting an already-absent key is a no-op.
    await store.clearComputerId("conv1");
    expect(await store.getComputerId("conv1")).toBeNull();
  });

  // --- setWorkspaceDefaultComputerId (mirror setWorkspaceDefaultCwd) ---

  it("setWorkspaceDefaultComputerId sets and clears", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work");
    clock = 2000;
    const setWs = await store.setWorkspaceDefaultComputerId("my-work", "remote-host");
    expect(setWs.defaultComputerId).toBe("remote-host");
    // does not bump lastActivityAt on defaultComputerId change (mirrors defaultCwd).
    expect(setWs.lastActivityAt).toBe(1000);
    const cleared = await store.setWorkspaceDefaultComputerId("my-work", null);
    expect(cleared.defaultComputerId).toBeNull();
  });

  it("setWorkspaceDefaultComputerId creates the workspace if missing", async () => {
    const store = makeStore();
    clock = 5000;
    const ws = await store.setWorkspaceDefaultComputerId("brand-new", "remote-host");
    expect(ws).toEqual({
      id: "brand-new",
      title: "brand-new",
      defaultCwd: null,
      defaultComputerId: "remote-host",
      starred: false,
      createdAt: 5000,
      lastActivityAt: 5000,
    });
  });

  it("setWorkspaceDefaultComputerId preserves defaultCwd on an existing workspace", async () => {
    const store = makeStore();
    clock = 1000;
    await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/root" });
    clock = 2000;
    const ws = await store.setWorkspaceDefaultComputerId("my-work", "remote-host");
    expect(ws.defaultCwd).toBe("/workspace/root");
    expect(ws.defaultComputerId).toBe("remote-host");
  });

  it("the synthesized 'default' workspace still returns defaultComputerId: null (local)", async () => {
    const store = makeStore();
    const ws = await store.getWorkspace("default");
    expect(ws).toEqual({
      id: "default",
      title: "default",
      defaultCwd: null,
      defaultComputerId: null,
      starred: false,
      createdAt: 0,
      lastActivityAt: 0,
    });
    // And it surfaces null in listWorkspaces too.
    const list = await store.listWorkspaces();
    const defaultWs = list.find((w) => w.id === "default");
    expect(defaultWs?.defaultComputerId).toBeNull();
  });

  // --- getEffectiveComputer resolution ladder (mirror getEffectiveCwd) ---

  it("getEffectiveComputer: per-conversation computerId overrides workspace defaultComputerId", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setComputerId("conv1", "per-conv-host");
    expect(await store.getEffectiveComputer("conv1")).toBe("per-conv-host");
  });

  it("getEffectiveComputer: workspace defaultComputerId used when conversation computerId is unset", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getEffectiveComputer("conv1")).toBe("ws-host");
  });

  it("getEffectiveComputer: null (LOCAL) when both conversation and workspace computerId are unset", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work");
    await store.setWorkspaceId("conv1", "my-work");
    expect(await store.getEffectiveComputer("conv1")).toBeNull();
  });

  it("getEffectiveComputer: default workspace (no defaultComputerId) falls through to null (local)", async () => {
    const store = makeStore();
    // No explicit workspace assignment — defaults to "default" workspace
    // which has defaultComputerId null.
    expect(await store.getEffectiveComputer("conv1")).toBeNull();
  });

  it("getEffectiveComputer: clearComputerId falls through to workspace defaultComputerId (un-shadows it)", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setComputerId("conv1", "per-conv-host");
    // Before clear: the conversation computerId shadows the workspace default.
    expect(await store.getEffectiveComputer("conv1")).toBe("per-conv-host");
    // After clear: the workspace defaultComputerId is used (fall-through).
    await store.clearComputerId("conv1");
    expect(await store.getEffectiveComputer("conv1")).toBe("ws-host");
  });

  // --- overrideAlias (per-turn computer override, mirror overrideCwd) ---

  it("getEffectiveComputer: overrideAlias string wins outright, overriding workspace defaultComputerId", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    // A string override wins outright, even over a workspace defaultComputerId.
    expect(await store.getEffectiveComputer("conv1", "override-host")).toBe("override-host");
  });

  it("getEffectiveComputer: overrideAlias string wins over the persisted per-conversation computerId", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setComputerId("conv1", "persisted-host");
    // The override must win over the persisted computerId.
    expect(await store.getEffectiveComputer("conv1", "override-host")).toBe("override-host");
  });

  it("getEffectiveComputer: overrideAlias null is explicitly local and does NOT fall through", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setComputerId("conv1", "persisted-host");
    // An explicit null override = "local for this turn": it wins outright and
    // does NOT fall through to the persisted value or the workspace default.
    expect(await store.getEffectiveComputer("conv1", null)).toBeNull();
  });

  it("getEffectiveComputer: overrideAlias omitted behaves as today (uses persisted computerId)", async () => {
    const store = makeStore();
    await store.ensureWorkspace("my-work", { defaultComputerId: "ws-host" });
    await store.setWorkspaceId("conv1", "my-work");
    await store.setComputerId("conv1", "persisted-host");
    // No second arg — persisted computerId is used.
    expect(await store.getEffectiveComputer("conv1")).toBe("persisted-host");
  });

  // --- round-trip through persistence (parse/toWorkspace) ---

  it("a Workspace with defaultComputerId round-trips through parse/toWorkspace", async () => {
    const store = makeStore();
    clock = 1000;
    // Create with a defaultComputerId via ensureWorkspace, then read it back
    // (exercises parseWorkspaceRow -> toWorkspace round-trip).
    const created = await store.ensureWorkspace("remote-work", {
      title: "Remote",
      defaultComputerId: "prod-server",
    });
    expect(created.defaultComputerId).toBe("prod-server");
    const roundTripped = await store.getWorkspace("remote-work");
    expect(roundTripped).toEqual({
      id: "remote-work",
      title: "Remote",
      defaultCwd: null,
      defaultComputerId: "prod-server",
      starred: false,
      createdAt: 1000,
      lastActivityAt: 1000,
    });
  });

  it("a legacy WorkspaceRow without defaultComputerId reads back as null (local)", async () => {
    const store = makeStore();
    // Simulate a legacy row persisted before defaultComputerId existed:
    // write a raw WorkspaceRow JSON lacking the field, then read it back.
    await storage.set(
      "workspace:legacy",
      JSON.stringify({
        title: "legacy",
        defaultCwd: "/legacy/cwd",
        createdAt: 100,
        lastActivityAt: 200,
      }),
    );
    const ws = await store.getWorkspace("legacy");
    expect(ws).toEqual({
      id: "legacy",
      title: "legacy",
      defaultCwd: "/legacy/cwd",
      defaultComputerId: null,
      starred: false,
      createdAt: 100,
      lastActivityAt: 200,
    });
  });
});

describe("isValidWorkspaceSlug", () => {
  it("accepts valid slugs", () => {
    expect(isValidWorkspaceSlug("my-work")).toBe(true);
    expect(isValidWorkspaceSlug("default")).toBe(true);
    expect(isValidWorkspaceSlug("a1b2")).toBe(true);
  });

  it("rejects invalid slugs", () => {
    expect(isValidWorkspaceSlug("My-Work")).toBe(false);
    expect(isValidWorkspaceSlug("-leading")).toBe(false);
    expect(isValidWorkspaceSlug("trailing-")).toBe(false);
    expect(isValidWorkspaceSlug("")).toBe(false);
    expect(isValidWorkspaceSlug("a".repeat(41))).toBe(false);
    expect(isValidWorkspaceSlug("has space")).toBe(false);
  });
});
