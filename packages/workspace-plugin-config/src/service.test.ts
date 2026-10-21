import type { PluginTier, StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { materializedMarkerKey, storageKey } from "./pure.js";
import { createWorkspacePluginConfigService } from "./service.js";

/**
 * A plain in-memory `StorageNamespace` implementation (no mocks — the same
 * seam the SQLite backend fills, realized in memory). Sorted-keys + prefix
 * semantics mirror the real KV.
 */
function createInMemoryStorage(): StorageNamespace & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    ...storageFromMap(data),
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async has(key) {
      return data.has(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)).sort();
    },
  };
}

interface FakePlugin {
  readonly id: string;
  readonly tier: PluginTier;
}

/** The loaded-plugin catalog a test builds its service over. */
function fakeCatalog(...plugins: readonly FakePlugin[]): () => readonly FakePlugin[] {
  return () => plugins;
}

function noopLogger(): {
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
} {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

const CORE: FakePlugin = { id: "kernel-core", tier: "core" };
const PROVIDER: FakePlugin = { id: "provider-umans", tier: "providers" };
const STANDARD: FakePlugin = { id: "tool-shell", tier: "standard" };

describe("WorkspacePluginConfigService — read-through materialization (§6.1)", () => {
  it("first read materializes: core → enabled; default's enabled/disabled inherited; undefined → no write", async () => {
    const storage = createInMemoryStorage();
    // The DEFAULT workspace's current state: provider enabled, standard disabled.
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(CORE, PROVIDER, STANDARD),
      logger: noopLogger() as never,
    });
    await service.setState("default", "provider-umans", "enabled");
    await service.setState("default", "tool-shell", "disabled");

    const states = await service.effectiveStates("team-a");
    expect(states.get("kernel-core")).toBe("enabled"); // core rule
    expect(states.get("provider-umans")).toBe("enabled"); // inherited
    expect(states.get("tool-shell")).toBe("disabled"); // inherited
  });

  it("the default workspace's blank slate stays blank for providers/standard (nothing written)", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(CORE, PROVIDER, STANDARD),
      logger: noopLogger() as never,
    });
    const states = await service.effectiveStates("default");
    // Only core is written (enabled-by-default); the rest is the blank slate.
    expect(states.size).toBe(1);
    expect(states.get("kernel-core")).toBe("enabled");
  });

  it("materialization is a SNAPSHOT: later default-workspace changes never rewrite a materialized workspace", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(PROVIDER),
      logger: noopLogger() as never,
    });
    await service.setState("default", "provider-umans", "enabled");
    await service.effectiveStates("team-a"); // materializes enabled
    await service.setState("default", "provider-umans", "disabled");
    const states = await service.effectiveStates("team-a");
    expect(states.get("provider-umans")).toBe("enabled"); // unchanged
  });

  it("fill-gaps-only: an existing per-workspace record is never overwritten by materialization", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(PROVIDER),
      logger: noopLogger() as never,
    });
    await service.setState("default", "provider-umans", "enabled");
    await service.setState("team-a", "provider-umans", "disabled");
    const states = await service.effectiveStates("team-a");
    expect(states.get("provider-umans")).toBe("disabled");
  });

  it("materialization is latched by a marker (idempotent across reads)", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(CORE, PROVIDER),
      logger: noopLogger() as never,
    });
    await service.effectiveStates("team-a");
    expect(await storage.has(materializedMarkerKey("team-a"))).toBe(true);
    // A second read does not duplicate or change anything.
    const states = await service.effectiveStates("team-a");
    expect(states.get("kernel-core")).toBe("enabled");
    const materializedKeys = (await storage.keys("team-a/")).length;
    expect(materializedKeys).toBe(2); // core record + marker
  });

  it("mid-session catalog additions appear on later materialization but not retroactively", async () => {
    const storage = createInMemoryStorage();
    let plugins: readonly FakePlugin[] = [CORE];
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: () => plugins,
      logger: noopLogger() as never,
    });
    await service.effectiveStates("team-a"); // materializes core only
    plugins = [CORE, PROVIDER];
    const states = await service.effectiveStates("team-a");
    // The workspace is already latched — the new plugin stays undefined.
    expect(states.get("provider-umans")).toBeUndefined();
  });
});

describe("WorkspacePluginConfigService — enforcement reads", () => {
  it("stateOf returns the recorded state, undefined for the blank slate", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(PROVIDER),
      logger: noopLogger() as never,
    });
    expect(await service.stateOf("team-a", "provider-umans")).toBeUndefined();
    await service.setState("team-a", "provider-umans", "disabled");
    expect(await service.stateOf("team-a", "provider-umans")).toBe("disabled");
  });
});

describe("WorkspacePluginConfigService — view + enabledProviderCount (§6.5/§6.6)", () => {
  it("view reports loaded rows with locked/loaded metadata; unloaded records are greyed", async () => {
    const storage = createInMemoryStorage();
    let plugins: readonly FakePlugin[] = [CORE, PROVIDER];
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: () => plugins,
      logger: noopLogger() as never,
    });
    await service.setState("team-a", "provider-umans", "enabled");
    // Unload the provider: its stored record now renders as an unloaded row.
    plugins = [CORE];
    const view = await service.view("team-a");
    const providerRow = view.plugins.find((r) => r.pluginId === "provider-umans");
    expect(providerRow).toEqual({
      pluginId: "provider-umans",
      tier: "providers",
      state: "enabled",
      loaded: false,
      locked: false,
    });
    const coreRow = view.plugins.find((r) => r.pluginId === "kernel-core");
    expect(coreRow?.locked).toBe(true);
    expect(coreRow?.loaded).toBe(true);
    expect(coreRow?.state).toBe("enabled");
  });

  it("enabledProviderCount counts LOADED provider-tier plugins effectively enabled", async () => {
    const storage = createInMemoryStorage();
    let plugins: readonly FakePlugin[] = [CORE, PROVIDER, { id: "provider-2", tier: "providers" }];
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: () => plugins,
      logger: noopLogger() as never,
    });
    // Blank slate: no providers enabled (the §7 first-boot guardrail signal).
    expect(await service.enabledProviderCount("team-a")).toBe(0);
    await service.setState("team-a", "provider-umans", "enabled");
    expect(await service.enabledProviderCount("team-a")).toBe(1);
    // An unloaded provider does not count.
    plugins = [CORE, PROVIDER];
    expect(await service.enabledProviderCount("team-a")).toBe(1);
  });
});

describe("WorkspacePluginConfigService — setState refusals (§6.6 strict layering)", () => {
  it("sets enabled/disabled, and unset deletes the record (back to the blank slate)", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(PROVIDER),
      logger: noopLogger() as never,
    });
    await service.setState("team-a", "provider-umans", "enabled");
    expect(await service.stateOf("team-a", "provider-umans")).toBe("enabled");
    await service.setState("team-a", "provider-umans", "unset");
    expect(await service.stateOf("team-a", "provider-umans")).toBeUndefined();
    expect(await storage.has(storageKey("team-a", "provider-umans"))).toBe(false);
  });

  it("refuses an UNLOADED plugin (unloaded)", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(PROVIDER),
      logger: noopLogger() as never,
    });
    const result = await service.setState("team-a", "ghost", "enabled");
    expect(result).toEqual({ ok: false, reason: "unloaded" });
    expect(await storage.has(storageKey("team-a", "ghost"))).toBe(false);
  });

  it("refuses a CORE plugin (core-locked)", async () => {
    const storage = createInMemoryStorage();
    const service = createWorkspacePluginConfigService({
      storage,
      getPlugins: fakeCatalog(CORE),
      logger: noopLogger() as never,
    });
    const result = await service.setState("team-a", "kernel-core", "disabled");
    expect(result).toEqual({ ok: false, reason: "core-locked" });
    expect(await storage.has(storageKey("team-a", "kernel-core"))).toBe(false);
  });
});
