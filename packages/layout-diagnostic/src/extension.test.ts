/**
 * layout-diagnostic integration tests — the layout-chat gate run against the
 * diagnostic provider (a REAL kernel host: createBus + createHost +
 * in-memory storage, the plugin-verify pattern — zero Dispatch mocks):
 *
 * - activation provides the `layout/provider` service (when the handle is
 *   free) and a fresh workspace GETS DIAGNOSTIC_LAYOUT (the derived default
 *   + the two root-tile markers) through the live service, materialized in
 *   the plugin's OWN storage namespace;
 * - deactivation (unload) un-provides the service (tryGetService →
 *   undefined) and leaves ZERO dangling registrations;
 * - decision 8 (one provider at a time): when another layout provider got
 *   there first, THIS plugin loads as a HOT STANDBY — no error, no service —
 *   and provides automatically the moment that provider unloads. (The first
 *   provider is the layout-chat impostor pattern — a minimal inline
 *   provider — because layout plugins never import one another; the handle
 *   package exists so consumers and providers meet ONLY there.)
 */

import type { EventsEmitter, Extension, Manifest } from "@dispatch/kernel";
import { createBus, createHost, createLogger } from "@dispatch/kernel";
import { DEFAULT_LAYOUT } from "@dispatch/layout-contract";
import { layoutProviderHandle } from "@dispatch/layout-provider-contract";
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

describe("layout-diagnostic — integration (real host, plugin active)", () => {
  it("activation provides the layout provider service", async () => {
    const deps = makeHostDeps();
    const host = createHost([layoutDiagnostic], deps);
    await host.activate();

    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
  });

  it("a fresh workspace GETS DIAGNOSTIC_LAYOUT — the default tree plus the two root-tile markers", async () => {
    const deps = makeHostDeps();
    const host = createHost([layoutDiagnostic], deps);
    await host.activate();

    const api = host.getHostAPI();
    const provider = api.tryGetService(layoutProviderHandle);
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

  it("the disposal contract holds: unload reports ZERO dangling registrations (the verify-plugin disposal assertion, run here against a real host)", async () => {
    const deps = makeHostDeps();
    const host = createHost([layoutDiagnostic], deps);
    await host.activate();
    expect(host.getHostAPI().tryGetService(layoutProviderHandle)).toBeDefined();

    const unload = await host.unloadExtension("layout-diagnostic");
    expect(unload.ok).toBe(true);
    // Zero dangling: the ledger reports nothing force-cleaned (the field is
    // absent/empty when the disposal contract held — the same assertion
    // verify-plugin's disposal check makes over UnloadResult).
    expect(unload.dangling ?? []).toEqual([]);
    expect(host.getHostAPI().tryGetService(layoutProviderHandle)).toBeUndefined();
  });
});

describe("decision 8 — one provider at a time (hot standby while another provider is active)", () => {
  /** A minimal provider that got there FIRST (the layout-chat impostor pattern). */
  function firstProviderPlugin(): Extension {
    const manifest: Manifest = {
      id: "layout-first",
      name: "Layout First",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      tier: "standard",
      trust: "bundled",
      activation: "eager",
    };
    return {
      manifest,
      activate(host) {
        host.provideService(layoutProviderHandle, {
          getTree: async () => DEFAULT_LAYOUT,
          setTree: async () => ({ ok: true, tree: DEFAULT_LAYOUT }),
          applyOps: async () => ({ ok: true, tree: DEFAULT_LAYOUT, applied: 0 }),
          resetTree: async () => DEFAULT_LAYOUT,
        });
      },
    };
  }

  it("activated alongside an active provider, THIS plugin loads WITHOUT error as a hot standby (no service, no disabled entry)", async () => {
    const deps = makeHostDeps();
    // The bundled array order puts layout-chat first, so the diagnostic
    // plugin boots as the standby (first-provider-wins).
    const host = createHost([firstProviderPlugin(), layoutDiagnostic], deps);
    await host.activate();

    // No loud failure: the plugin is LOADED, not in the disabled grammar…
    expect(host.getDisabled()).toEqual([]);

    // …and the FIRST provider keeps ownership (exactly one provider, and it
    // is not this plugin).
    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    expect(await provider?.getTree("ws-a")).toEqual(DEFAULT_LAYOUT);
  });

  it("the moment the active provider unloads, the standby takes over and serves the marked tree", async () => {
    const deps = makeHostDeps();
    const host = createHost([firstProviderPlugin(), layoutDiagnostic], deps);
    await host.activate();

    // The human's flow: unload the active layout provider in the plugin UI —
    // the standby provides automatically (no second UI step).
    const unloadFirst = await host.unloadExtension("layout-first");
    expect(unloadFirst.ok).toBe(true);

    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    expect(await provider?.getTree("ws-a")).toEqual(DIAGNOSTIC_LAYOUT);
  });

  it("a standby that unloads while waiting reports ZERO dangling registrations (the ledger-tracked standby subscription is disposed)", async () => {
    const deps = makeHostDeps();
    const host = createHost([firstProviderPlugin(), layoutDiagnostic], deps);
    await host.activate();

    const unload = await host.unloadExtension("layout-diagnostic");
    expect(unload.ok).toBe(true);
    expect(unload.dangling ?? []).toEqual([]);
    // The first provider was never disturbed.
    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(await provider?.getTree("ws-a")).toEqual(DEFAULT_LAYOUT);
  });

  it("a standby takeover is disposed on unload: after taking over, unloading THIS plugin frees the handle with zero dangling", async () => {
    const deps = makeHostDeps();
    const host = createHost([firstProviderPlugin(), layoutDiagnostic], deps);
    await host.activate();
    await host.unloadExtension("layout-first");
    expect(host.getHostAPI().tryGetService(layoutProviderHandle)).toBeDefined();

    const unload = await host.unloadExtension("layout-diagnostic");
    expect(unload.ok).toBe(true);
    expect(unload.dangling ?? []).toEqual([]);
    expect(host.getHostAPI().tryGetService(layoutProviderHandle)).toBeUndefined();
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
