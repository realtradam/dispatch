import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Migration } from "./migrate.js";
import { computePending } from "./migrate.js";
import type { SqliteStorageBackend } from "./storage.js";
import { createSqliteStorage } from "./storage.js";

describe("computePending (pure)", () => {
  it("returns all migrations when none applied", () => {
    const migrations: Migration[] = [
      { version: 2, name: "b", up: "" },
      { version: 1, name: "a", up: "" },
    ];
    const result = computePending(new Set(), migrations);
    expect(result.map((m) => m.version)).toEqual([1, 2]);
  });

  it("skips already-applied versions", () => {
    const migrations: Migration[] = [
      { version: 1, name: "a", up: "" },
      { version: 2, name: "b", up: "" },
      { version: 3, name: "c", up: "" },
    ];
    const result = computePending(new Set([1, 3]), migrations);
    expect(result.map((m) => m.version)).toEqual([2]);
  });

  it("returns empty when all applied", () => {
    const migrations: Migration[] = [{ version: 1, name: "a", up: "" }];
    const result = computePending(new Set([1]), migrations);
    expect(result).toEqual([]);
  });

  it("sorts by version ascending", () => {
    const migrations: Migration[] = [
      { version: 3, name: "c", up: "" },
      { version: 1, name: "a", up: "" },
      { version: 2, name: "b", up: "" },
    ];
    const result = computePending(new Set(), migrations);
    expect(result.map((m) => m.version)).toEqual([1, 2, 3]);
  });
});

describe("createSqliteStorage", () => {
  let backend: SqliteStorageBackend;

  beforeEach(() => {
    backend = createSqliteStorage({ path: ":memory:" });
  });

  afterEach(() => {
    backend.close();
  });

  describe("StorageNamespace get/set/delete/has", () => {
    it("returns null for missing key", async () => {
      const ns = backend.storage("test");
      expect(await ns.get("missing")).toBeNull();
    });

    it("roundtrips set then get", async () => {
      const ns = backend.storage("test");
      await ns.set("key1", "value1");
      expect(await ns.get("key1")).toBe("value1");
    });

    it("overwrites existing value", async () => {
      const ns = backend.storage("test");
      await ns.set("key1", "v1");
      await ns.set("key1", "v2");
      expect(await ns.get("key1")).toBe("v2");
    });

    it("has returns false for missing, true for existing", async () => {
      const ns = backend.storage("test");
      expect(await ns.has("key1")).toBe(false);
      await ns.set("key1", "val");
      expect(await ns.has("key1")).toBe(true);
    });

    it("delete removes the key", async () => {
      const ns = backend.storage("test");
      await ns.set("key1", "val");
      await ns.delete("key1");
      expect(await ns.get("key1")).toBeNull();
      expect(await ns.has("key1")).toBe(false);
    });

    it("delete on missing key is a no-op", async () => {
      const ns = backend.storage("test");
      await ns.delete("nonexistent");
    });
  });

  describe("keys", () => {
    it("returns all keys in namespace", async () => {
      const ns = backend.storage("test");
      await ns.set("a", "1");
      await ns.set("b", "2");
      await ns.set("c", "3");
      const keys = await ns.keys();
      expect(keys.toSorted()).toEqual(["a", "b", "c"]);
    });

    it("filters by prefix", async () => {
      const ns = backend.storage("test");
      await ns.set("foo:1", "a");
      await ns.set("foo:2", "b");
      await ns.set("bar:1", "c");
      const keys = await ns.keys("foo");
      expect(keys.toSorted()).toEqual(["foo:1", "foo:2"]);
    });

    it("returns empty for no matches", async () => {
      const ns = backend.storage("test");
      await ns.set("a", "1");
      expect(await ns.keys("zzz")).toEqual([]);
    });
  });

  describe("namespace isolation", () => {
    it("same key in different namespaces does not collide", async () => {
      const ns1 = backend.storage("ns1");
      const ns2 = backend.storage("ns2");
      await ns1.set("key", "value1");
      await ns2.set("key", "value2");
      expect(await ns1.get("key")).toBe("value1");
      expect(await ns2.get("key")).toBe("value2");
    });

    it("delete in one namespace does not affect another", async () => {
      const ns1 = backend.storage("ns1");
      const ns2 = backend.storage("ns2");
      await ns1.set("key", "v1");
      await ns2.set("key", "v2");
      await ns1.delete("key");
      expect(await ns1.has("key")).toBe(false);
      expect(await ns2.get("key")).toBe("v2");
    });

    it("keys are scoped to namespace", async () => {
      const ns1 = backend.storage("ns1");
      const ns2 = backend.storage("ns2");
      await ns1.set("a", "1");
      await ns1.set("b", "2");
      await ns2.set("c", "3");
      expect((await ns1.keys()).toSorted()).toEqual(["a", "b"]);
      expect(await ns2.keys()).toEqual(["c"]);
    });
  });

  describe("migrate", () => {
    it("runs pending migrations in order", async () => {
      const migrations: Migration[] = [
        { version: 1, name: "create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY);" },
        { version: 2, name: "create_bar", up: "CREATE TABLE bar (id INTEGER PRIMARY KEY);" },
      ];
      await backend.migrate("ext1", migrations);

      const ns = backend.storage("ext1");
      await ns.set("test", "val");
      expect(await ns.get("test")).toBe("val");
    });

    it("skips already-applied migrations", async () => {
      const migrations: Migration[] = [
        { version: 1, name: "create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY);" },
      ];
      await backend.migrate("ext1", migrations);
      await backend.migrate("ext1", [
        ...migrations,
        { version: 2, name: "create_bar", up: "CREATE TABLE bar (id INTEGER PRIMARY KEY);" },
      ]);
    });

    it("is idempotent — calling migrate twice with same migrations is safe", async () => {
      const migrations: Migration[] = [
        { version: 1, name: "create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY);" },
      ];
      await backend.migrate("ext1", migrations);
      await backend.migrate("ext1", migrations);
    });

    it("migrations are per-namespace", async () => {
      const m1: Migration[] = [
        { version: 1, name: "create_t1", up: "CREATE TABLE t1 (id INTEGER PRIMARY KEY);" },
      ];
      const m2: Migration[] = [
        { version: 1, name: "create_t2", up: "CREATE TABLE t2 (id INTEGER PRIMARY KEY);" },
      ];
      await backend.migrate("ext1", m1);
      await backend.migrate("ext2", m2);
    });
  });
});

describe("createSqliteStorage — persistence across reopen", () => {
  it("migrations survive close and reopen", async () => {
    const tmpPath = `/tmp/storage-sqlite-test-${Date.now()}.db`;
    const migrations: Migration[] = [
      { version: 1, name: "create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY);" },
    ];

    const first = createSqliteStorage({ path: tmpPath });
    await first.migrate("ext1", migrations);
    first.close();

    const second = createSqliteStorage({ path: tmpPath });
    await second.migrate("ext1", [
      ...migrations,
      { version: 2, name: "create_bar", up: "CREATE TABLE bar (id INTEGER PRIMARY KEY);" },
    ]);
    second.close();

    const { unlinkSync } = await import("node:fs");
    unlinkSync(tmpPath);
  });
});
