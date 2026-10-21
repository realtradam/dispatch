import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
/**
 * layout-provider-registry integration tests — a REAL kernel host (createBus
 * + createHost + in-memory storage — the plugin-verify pattern, zero
 * Dispatch mocks) with the REAL workspace-plugin-config extension providing
 * the enablement plane, and REAL kit providers registered by two test-only
 * layout plugins:
 *
 * - the workspace with layout-chat enabled resolves layout-chat's tree;
 * - the workspace with layout-diagnostic enabled resolves the diagnostic
 *   tree (the markers);
 * - a workspace with NEITHER enabled resolves no provider (the 404 degrade);
 * - disabling mid-session stops resolving it;
 * - several enabled → the deterministic alphabetical tie-break;
 * - the config service absent → fail-closed (no provider);
 * - the unregister disposer keeps replaced-registration semantics.
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createBus, createHost, createLogger, type StorageNamespace } from "@dispatch/kernel";
import type { LayoutTree } from "@dispatch/layout-contract";
import {
  createLayoutProvider,
  layoutProviderRegistryHandle,
} from "@dispatch/layout-provider-contract";
import {
  extension as workspacePluginConfigExtension,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import { describe, expect, it } from "vitest";
import { createLayoutProviderRegistryExtension } from "./extension.js";

/** In-memory host deps — the kernel's own host-test shape (no Dispatch mocks). */
function makeHostDeps() {
  const logger = createLogger(
    { extensionId: "layout-provider-registry-test" },
    { emit: () => {} },
    { now: () => 0, newId: () => "layout-provider-registry-test" },
  );
  const stores = new Map<string, Map<string, string>>();
  return {
    logger,
    config: { get: () => undefined, getAll: () => ({}) },
    storageFactory: (ns: string): StorageNamespace => {
      let store = stores.get(ns);
      if (!store) {
        store = new Map();
        stores.set(ns, store);
      }
      const s: Map<string, string> = store;
      return {
        ...storageFromMap(s),
        get: async (key: string) => s.get(key) ?? null,
        set: async (key: string, value: string) => {
          s.set(key, value);
        },
        delete: async (key: string) => {
          s.delete(key);
        },
        has: async (key: string) => s.has(key),
        keys: async () => [...s.keys()],
      };
    },
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    permissions: { check: async () => ({ allowed: true }) },
    scheduler: { register: () => {}, unregister: () => {} },
    bus: createBus(logger),
    events: { emit: () => {} },
    logSink: { emit: () => {} },
    logDeps: { now: () => 0, newId: () => "layout-provider-registry-test" },
  };
}

/** A minimal layout tree distinct per plugin (the resolution assert reads it). */
function treeOf(view: string): LayoutTree {
  return { version: 1, root: { kind: "leaf", view } };
}

/**
 * A test-only layout plugin: a real kit provider (its OWN storage namespace)
 * registered into the layout-provider registry — the same reactive
 * registration shape layout-chat/layout-diagnostic use.
 */
function makeLayoutPlugin(id: string, view: string): Extension {
  const manifest: Manifest = {
    id,
    name: id,
    version: "0.0.0",
    apiVersion: "^0.1.0",
    tier: "standard",
    trust: "bundled",
    activation: "eager",
  };
  return {
    manifest,
    activate(host: HostAPI) {
      const provider = createLayoutProvider({
        storage: host.storage(id),
        defaultTree: treeOf(view),
        emitChange: () => {},
        logger: host.logger,
      });
      // Reactive registration (onServiceAvailable fires immediately when the
      // registry is already provided — the late-join semantics).
      host.onServiceAvailable(layoutProviderRegistryHandle, (registry) => {
        registry.register(id, provider);
      });
    },
  };
}

const chatPlugin = makeLayoutPlugin("layout-chat", "chat-view");
const diagnosticPlugin = makeLayoutPlugin("layout-diagnostic", "diagnostic-view");

function makeHost(): Awaited<ReturnType<typeof createHost>> {
  return createHost(
    [
      workspacePluginConfigExtension,
      createLayoutProviderRegistryExtension(),
      chatPlugin,
      diagnosticPlugin,
    ],
    makeHostDeps(),
  );
}

/** Set one workspace's plugin state through the REAL config service. */
async function setState(
  host: Awaited<ReturnType<typeof createHost>>,
  workspaceId: string,
  pluginId: string,
  state: "enabled" | "disabled",
): Promise<void> {
  const config = host.getHostAPI().tryGetService(workspacePluginConfigHandle);
  if (config === undefined) throw new Error("workspace-plugin-config not provided");
  await config.setState(workspaceId, pluginId, state);
}

describe("layout-provider-registry — per-workspace layout activation (real host)", () => {
  it("a workspace with layout-chat enabled resolves layout-chat's tree", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(registry).toBeDefined();
    if (registry === undefined) return;

    await setState(host, "ws-a", "layout-chat", "enabled");

    const provider = await registry.providerFor("ws-a");
    expect(provider).toBeDefined();
    expect(await provider?.getTree("fresh")).toEqual(treeOf("chat-view"));
  });

  it("a workspace with layout-diagnostic enabled resolves the DIAGNOSTIC tree", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(registry).toBeDefined();
    if (registry === undefined) return;

    await setState(host, "ws-b", "layout-diagnostic", "enabled");

    const provider = await registry.providerFor("ws-b");
    expect(provider).toBeDefined();
    expect(await provider?.getTree("fresh")).toEqual(treeOf("diagnostic-view"));
  });

  it("two workspaces resolve INDEPENDENTLY: chat-enabled gets chat, diagnostic-enabled gets diagnostic", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    await setState(host, "ws-a", "layout-chat", "enabled");
    await setState(host, "ws-b", "layout-diagnostic", "enabled");

    const chatProvider = await registry.providerFor("ws-a");
    const diagProvider = await registry.providerFor("ws-b");
    expect(await chatProvider?.getTree("fresh")).toEqual(treeOf("chat-view"));
    expect(await diagProvider?.getTree("fresh")).toEqual(treeOf("diagnostic-view"));
  });

  it("a workspace with NO layout plugin enabled resolves no provider (the 404 degrade)", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    // Both plugins are LOADED (registered) — but no workspace enabled one.
    expect(registry.ids().sort()).toEqual(["layout-chat", "layout-diagnostic"]);
    expect(await registry.providerFor("ws-none")).toBeUndefined();
  });

  it("a workspace that DISABLES its layout plugin stops resolving it (mid-session)", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    await setState(host, "ws-a", "layout-chat", "enabled");
    expect(await registry.providerFor("ws-a")).toBeDefined();

    await setState(host, "ws-a", "layout-chat", "disabled");
    expect(await registry.providerFor("ws-a")).toBeUndefined();
  });

  it("SEVERAL enabled layout plugins → the deterministic alphabetical tie-break", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    await setState(host, "ws-c", "layout-diagnostic", "enabled");
    await setState(host, "ws-c", "layout-chat", "enabled");

    const provider = await registry.providerFor("ws-c");
    // "layout-chat" < "layout-diagnostic" — stable regardless of enable order.
    expect(await provider?.getTree("fresh")).toEqual(treeOf("chat-view"));
  });

  it("the config service absent → fail-closed (no provider resolves)", async () => {
    // NO workspace-plugin-config in this host — the registry rides alone.
    const host = createHost([createLayoutProviderRegistryExtension(), chatPlugin], makeHostDeps());
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(registry).toBeDefined();
    expect(await registry?.providerFor("ws-a")).toBeUndefined();
  });

  it("the unregister disposer keeps replaced-registration semantics (last-wins)", async () => {
    const host = makeHost();
    await host.activate();
    const api = host.getHostAPI();
    const registry = api.tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    const makeProvider = (view: string) =>
      createLayoutProvider({
        storage: api.storage(view),
        defaultTree: treeOf(view),
        emitChange: () => {},
        logger: api.logger,
      });
    const first = registry.register("layout-impostor", makeProvider("impostor-one"));
    const second = registry.register("layout-impostor", makeProvider("impostor-two"));
    // Last-wins replace: the registration now points at the SECOND provider.
    // A disposer from a REPLACED registration must not evict the current one
    // (the surface-registry semantics).
    first();
    expect(registry.get("layout-impostor")).toBeDefined();
    // The CURRENT registration's disposer removes it.
    second();
    expect(registry.get("layout-impostor")).toBeUndefined();
  });
});
