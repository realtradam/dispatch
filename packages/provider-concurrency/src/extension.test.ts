import type { Logger, StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { migrateObsoleteProviderKeys } from "./extension.js";

function createMemoryStorage(): StorageNamespace & {
  dump: () => Record<string, string>;
} {
  const data = new Map<string, string>();
  return {
    dump: () => Object.fromEntries(data),
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    has: async (key) => data.has(key),
    keys: async (prefix) =>
      [...data.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
  };
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  span() {
    return {
      id: "span",
      log: noopLogger,
      setAttributes() {},
      addLink() {},
      child() {
        return this;
      },
      end() {},
    };
  },
};

describe("migrateObsoleteProviderKeys (openai-compat → opencode-1)", () => {
  it("migrates the bare limit key to the numbered identity and deletes the obsolete key", async () => {
    const storage = createMemoryStorage();
    await storage.set("openai-compat", "4");

    await migrateObsoleteProviderKeys(storage, noopLogger);

    expect(storage.dump()).toEqual({ "opencode-1": "4" });
  });

  it("migrates cooldown + auto-reduce keys too", async () => {
    const storage = createMemoryStorage();
    await storage.set("cooldown:openai-compat", "500");
    await storage.set("auto-reduce:openai-compat", "8");

    await migrateObsoleteProviderKeys(storage, noopLogger);

    expect(storage.dump()).toEqual({
      "cooldown:opencode-1": "500",
      "auto-reduce:opencode-1": "8",
    });
  });

  it("does NOT overwrite an existing numbered target (drops the obsolete key instead)", async () => {
    const storage = createMemoryStorage();
    await storage.set("openai-compat", "4");
    await storage.set("opencode-1", "12");

    await migrateObsoleteProviderKeys(storage, noopLogger);

    // The legitimate numbered setting wins; the obsolete key is cleaned up.
    expect(storage.dump()).toEqual({ "opencode-1": "12" });
  });

  it("is idempotent", async () => {
    const storage = createMemoryStorage();
    await storage.set("openai-compat", "4");

    await migrateObsoleteProviderKeys(storage, noopLogger);
    await migrateObsoleteProviderKeys(storage, noopLogger);

    expect(storage.dump()).toEqual({ "opencode-1": "4" });
  });

  it("leaves unrelated provider keys untouched", async () => {
    const storage = createMemoryStorage();
    await storage.set("umans", "3");
    await storage.set("opencode-2", "5");

    await migrateObsoleteProviderKeys(storage, noopLogger);

    expect(storage.dump()).toEqual({
      umans: "3",
      "opencode-2": "5",
    });
  });
});
