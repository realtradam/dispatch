import type { StorageNamespace } from "@dispatch/kernel";
import type { HeartbeatRun } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { createHeartbeatRunStore } from "./run-store.js";

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
      if (prefix === undefined) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
  };
}

function run(id: string, conversationId: string, triggeredAt: string): HeartbeatRun {
  return { id, conversationId, triggeredAt, status: "running" };
}

describe("createHeartbeatRunStore", () => {
  it("creates and reads back a run", async () => {
    const store = createHeartbeatRunStore(createMemoryStorage());
    const created = await store.create("ws-1", run("r1", "c1", "2026-01-01T00:00:00.000Z"));
    expect(created.status).toBe("running");
    const read = await store.get("ws-1", "r1");
    expect(read).toEqual(created);
  });

  it("returns null for an unknown run", async () => {
    const store = createHeartbeatRunStore(createMemoryStorage());
    expect(await store.get("ws-1", "nope")).toBeNull();
  });

  it("updates the status of a run", async () => {
    const store = createHeartbeatRunStore(createMemoryStorage());
    await store.create("ws-1", run("r1", "c1", "2026-01-01T00:00:00.000Z"));
    const updated = await store.setStatus("ws-1", "r1", "completed");
    expect(updated?.status).toBe("completed");
    expect((await store.get("ws-1", "r1"))?.status).toBe("completed");
  });

  it("setStatus is a no-op (returns null) for an unknown run", async () => {
    const store = createHeartbeatRunStore(createMemoryStorage());
    expect(await store.setStatus("ws-1", "ghost", "stopped")).toBeNull();
  });

  it("lists runs most-recent first by triggeredAt", async () => {
    const store = createHeartbeatRunStore(createMemoryStorage());
    await store.create("ws-1", run("r1", "c1", "2026-01-01T00:00:00.000Z"));
    await store.create("ws-1", run("r2", "c2", "2026-02-01T00:00:00.000Z"));
    await store.create("ws-1", run("r3", "c3", "2026-01-15T00:00:00.000Z"));
    const runs = await store.list("ws-1");
    expect(runs.map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
  });

  it("scopes runs per workspace", async () => {
    const store = createHeartbeatRunStore(createMemoryStorage());
    await store.create("ws-1", run("r1", "c1", "2026-01-01T00:00:00.000Z"));
    await store.create("ws-2", run("r2", "c2", "2026-01-01T00:00:00.000Z"));
    expect((await store.list("ws-1")).map((r) => r.id)).toEqual(["r1"]);
    expect((await store.list("ws-2")).map((r) => r.id)).toEqual(["r2"]);
  });
});
