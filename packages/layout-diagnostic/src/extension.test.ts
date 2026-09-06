/**
 * layout-diagnostic integration tests — a REAL kernel host (createBus +
 * createHost + in-memory storage, the plugin-verify pattern — zero Dispatch
 * mocks) with the REAL workspace-plugin-config extension (the enablement
 * plane) and the REAL layout-provider registry:
 *
 * - activation REGISTERS the provider (no error, loaded — alongside
 *   layout-chat, which it never races: coexistence is the design);
 * - a workspace that ENABLES layout-diagnostic resolves it as ITS provider
 *   and GETS DIAGNOSTIC_LAYOUT (the derived default + the two root-tile
 *   markers), materialized in the plugin's OWN storage namespace;
 * - a workspace that keeps layout-chat enabled is UNAFFECTED (per-workspace
 *   activation — the human's flow: enable diagnostic in the workspace's
 *   plugins modal, no unload dance, no restart);
 * - the disposal contract: unload removes the registration with ZERO
 *   dangling ledger entries (the registry subscription included).
 */

import type { EventsEmitter } from "@dispatch/kernel";
import { createBus, createHost, createLogger } from "@dispatch/kernel";
import { extension as layoutChat } from "@dispatch/layout-chat";
import { DEFAULT_LAYOUT, type LayoutTree } from "@dispatch/layout-contract";
import { layoutProviderRegistryHandle } from "@dispatch/layout-provider-contract";
import { createLayoutProviderRegistryExtension } from "@dispatch/layout-provider-registry";
import {
  extension as workspacePluginConfigExtension,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import { describe, expect, it } from "vitest";
import { extension as layoutDiagnostic } from "./extension.js";
import { DIAGNOSTIC_LAYOUT } from "./tree.js";

/** In-memory host deps — the kernel's own host-test shape (no Dispatch mocks). */
function makeHostDeps() {
  const logger = createLogger(
    { extensionId: "layout-diagnostic-test" },
    { emit: () => {} },
    {
      now: () => 0,
      newId: () => "layout-diagnostic-test",
    },
  );
  const stores = new Map<string, Map<string, string>>();
  const emitted: Array<{ type: string; [key: string]: unknown }> = [];
  const events: EventsEmitter = {
    emit: (event) => {
      emitted.push(event);
    },
  };
  return {
    logger,
    config: { get: () => undefined, getAll: () => ({}) },
    storageFactory: (ns: string) => {
      let store = stores.get(ns);
      if (!store) {
        store = new Map();
        stores.set(ns, store);
      }
      const s = store;
      return {
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
    events,
    logSink: { emit: () => {} },
    logDeps: { now: () => 0, newId: () => "layout-diagnostic-test" },
    emitted,
  };
}

/** Both layout plugins + the registry + the enablement plane — the real set. */
function makeHost(): Awaited<ReturnType<typeof createHost>> {
  return createHost(
    [
      workspacePluginConfigExtension,
      createLayoutProviderRegistryExtension(),
      layoutChat,
      layoutDiagnostic,
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

describe("layout-diagnostic — integration (real host, plugin registered)", () => {
  it("activation registers the provider under the plugin id — alongside layout-chat, without error", async () => {
    const host = makeHost();
    await host.activate();

    expect(host.getDisabled()).toEqual([]);
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(registry?.ids().sort()).toEqual(["layout-chat", "layout-diagnostic"]);
  });

  it("a workspace that ENABLES layout-diagnostic GETS DIAGNOSTIC_LAYOUT — the default tree plus the two root-tile markers", async () => {
    const deps = makeHostDeps();
    const host = createHost(
      [
        workspacePluginConfigExtension,
        createLayoutProviderRegistryExtension(),
        layoutChat,
        layoutDiagnostic,
      ],
      deps,
    );
    await host.activate();

    await setState(host, "ws-diag", "layout-diagnostic", "enabled");
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    const provider = await registry?.providerFor("ws-diag");
    expect(provider).toBeDefined();
    if (provider === undefined) return;

    const tree = await provider.getTree("fresh-workspace");
    expect(tree).toEqual(DIAGNOSTIC_LAYOUT);
    // The seed IS the default layout plus the markers — nothing else changed.
    expect(stripMarkers(tree)).toEqual(stripMarkers(DEFAULT_LAYOUT));
    // Read-through materialized the seed in the plugin's own namespace.
    const ns = deps.storageFactory("layout-diagnostic");
    expect(await ns.get("tree:fresh-workspace")).toBe(JSON.stringify(DIAGNOSTIC_LAYOUT));
  });

  it("PER-WORKSPACE activation: the diagnostic workspace gets the marked tree, the chat workspace is UNAFFECTED", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    // The human's flow, with NO unload dance and NO restart: enable
    // diagnostic in one workspace, keep chat in the other.
    await setState(host, "ws-diag", "layout-diagnostic", "enabled");
    await setState(host, "ws-chat", "layout-chat", "enabled");

    const diagTree: LayoutTree | undefined = await registry
      .providerFor("ws-diag")
      .then((p) => p?.getTree("w"));
    const chatTree: LayoutTree | undefined = await registry
      .providerFor("ws-chat")
      .then((p) => p?.getTree("w"));

    expect(diagTree).toEqual(DIAGNOSTIC_LAYOUT);
    expect(chatTree).toEqual(DEFAULT_LAYOUT);
  });

  it("switching a workspace between providers is a per-workspace state change (disable chat, enable diagnostic)", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    await setState(host, "ws-a", "layout-chat", "enabled");
    const chatProvider = await registry.providerFor("ws-a");
    expect(await chatProvider?.getTree("w")).toEqual(DEFAULT_LAYOUT);

    // The workspace switches to the diagnostic layout.
    await setState(host, "ws-a", "layout-chat", "disabled");
    await setState(host, "ws-a", "layout-diagnostic", "enabled");
    const diagProvider = await registry.providerFor("ws-a");
    expect(await diagProvider?.getTree("w")).toEqual(DIAGNOSTIC_LAYOUT);
  });

  it("a workspace with NO layout plugin enabled resolves NO provider (the 404 degrade)", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    if (registry === undefined) return;

    expect(await registry.providerFor("ws-none")).toBeUndefined();
  });

  it("the disposal contract holds: unload removes the registration with ZERO dangling ledger entries", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(registry?.get("layout-diagnostic")).toBeDefined();

    const unload = await host.unloadExtension("layout-diagnostic");
    expect(unload.ok).toBe(true);
    // Zero dangling: the ledger reports nothing force-cleaned (the standby
    // subscription of the old design is gone; the registry-availability
    // subscription is ledger-tracked and disposed in deactivate()).
    expect(unload.dangling ?? []).toEqual([]);
    // The service-mediated registration is gone too.
    expect(registry?.get("layout-diagnostic")).toBeUndefined();
  });
});

/** A fresh marker-free copy of a tree (the diff seam for "default + markers only"). */
function stripMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMarkers);
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  delete record.marker;
  for (const [key, inner] of Object.entries(record)) record[key] = stripMarkers(inner);
  return record;
}
