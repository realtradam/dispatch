/**
 * layout-diagnostic integration tests — the layout-chat gate run against the
 * diagnostic provider (a REAL kernel host: createBus + createHost +
 * in-memory storage, the plugin-verify pattern — zero Dispatch mocks):
 *
 * - activation provides the `layout/provider` service;
 * - a fresh workspace GETS DIAGNOSTIC_LAYOUT (the derived default + the two
 *   root-tile markers) through the live service, materialized in the
 *   plugin's OWN storage namespace;
 * - deactivation (unload) un-provides the service (tryGetService →
 *   undefined) and leaves ZERO dangling registrations;
 * - decision 8 (one provider at a time): when a layout provider got there
 *   first, THIS plugin's activation fails LOUDLY into the
 *   disabled-with-reason grammar — and once that provider is unloaded,
 *   enabling this one takes over and serves the marked tree. (The first
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

describe("decision 8 — one provider at a time (first-provider-wins, loud loser)", () => {
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

  it("loaded after an active provider, THIS plugin's activation fails LOUDLY (disabled-with-reason), and the first provider keeps serving the plain default", async () => {
    const deps = makeHostDeps();
    // The bundled array order puts layout-chat first, so the diagnostic
    // plugin is the expected loser at boot (first-provider-wins).
    const host = createHost([firstProviderPlugin(), layoutDiagnostic], deps);
    await host.activate();

    // The diagnostic provider's activation failed LOUDLY into the disabled
    // grammar ("another layout provider is active")…
    const disabled = host.getDisabled();
    expect(disabled.map((d) => d.manifest.id)).toEqual(["layout-diagnostic"]);
    expect(disabled[0]?.reason).toContain("Activation failed");
    expect(disabled[0]?.reason).toContain("already provided");

    // …and the FIRST provider keeps ownership, serving the PLAIN default.
    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    expect(await provider?.getTree("ws-a")).toEqual(DEFAULT_LAYOUT);
  });

  it("enabled AFTER the active provider is unloaded, the diagnostic provider takes over and serves the marked tree", async () => {
    const deps = makeHostDeps();
    const host = createHost([firstProviderPlugin(), layoutDiagnostic], deps);
    await host.activate();

    // The human's flow: disable layout-chat (whichever provider is active),
    // then enable the diagnostic one.
    const unloadFirst = await host.unloadExtension("layout-first");
    expect(unloadFirst.ok).toBe(true);
    const loadDiagnostic = await host.loadExtension(layoutDiagnostic);
    expect(loadDiagnostic.ok).toBe(true);

    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    expect(await provider?.getTree("ws-a")).toEqual(DIAGNOSTIC_LAYOUT);
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
