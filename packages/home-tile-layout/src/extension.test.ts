import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
/**
 * home-tile-layout integration tests — a REAL kernel host (createBus +
 * createHost + in-memory storage, the plugin-verify pattern — zero Dispatch
 * mocks):
 *
 * - activation PROVIDES the service (no error, loaded; always-on — there is
 *   no per-workspace enablement for the home grid);
 * - the service stores ONE document PER orientation in the plugin's OWN
 *   storage namespace (`doc:<mode>`), seeding fresh orientations with the
 *   empty document;
 * - writes emit the `tile-layout` change event (the transport's broadcast
 *   payload) exactly once, with the full document;
 * - the disposal contract: unload removes the service with ZERO dangling
 *   ledger entries.
 */

import { homeTileLayoutHandle, tileLayoutChanged } from "@dispatch/home-tile-layout-contract";
import type { EventsEmitter } from "@dispatch/kernel";
import { createBus, createHost, createLogger } from "@dispatch/kernel";
import { EMPTY_TILE_LAYOUT } from "@dispatch/tile-layout-contract";
import { describe, expect, it } from "vitest";
import { extension as homeTileLayout } from "./extension.js";

/** In-memory host deps — the kernel's own host-test shape (no Dispatch mocks). */
function makeHostDeps() {
  const logger = createLogger(
    { extensionId: "home-tile-layout-test" },
    { emit: () => {} },
    {
      now: () => 0,
      newId: () => "home-tile-layout-test",
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
    events,
    logSink: { emit: () => {} },
    logDeps: { now: () => 0, newId: () => "home-tile-layout-test" },
    emitted,
    stores,
  };
}

describe("home-tile-layout — integration (real host, service provided)", () => {
  it("activation provides the service — always-on, no enablement step", async () => {
    const host = createHost([homeTileLayout], makeHostDeps());
    await host.activate();

    expect(host.getDisabled()).toEqual([]);
    expect(host.getHostAPI().tryGetService(homeTileLayoutHandle)).toBeDefined();
  });

  it("keeps ONE document PER orientation in the plugin's own namespace, seeded on first read", async () => {
    const deps = makeHostDeps();
    const host = createHost([homeTileLayout], deps);
    await host.activate();

    const service = host.getHostAPI().tryGetService(homeTileLayoutHandle);
    expect(service).toBeDefined();
    if (service === undefined) return;

    // Fresh orientations read as the empty document…
    expect(await service.get("wide")).toEqual(EMPTY_TILE_LAYOUT);
    expect(await service.get("tall")).toEqual(EMPTY_TILE_LAYOUT);
    // …materialized per-orientation in the plugin's OWN namespace.
    const ns = deps.stores.get("home-tile-layout");
    expect(await ns?.get("doc:wide")).toBe(JSON.stringify(EMPTY_TILE_LAYOUT));
    expect(await ns?.get("doc:tall")).toBe(JSON.stringify(EMPTY_TILE_LAYOUT));

    // The orientations are independent documents.
    const doc = {
      version: 2 as const,
      tiles: [{ id: "alpha", colSpan: 2, rowSpan: 1, order: 0 }],
    };
    await service.put("wide", doc);
    expect(await service.get("wide")).toEqual(doc);
    expect(await service.get("tall")).toEqual(EMPTY_TILE_LAYOUT);
  });

  it("a successful write emits the tile-layout change event EXACTLY once (the broadcast payload)", async () => {
    const deps = makeHostDeps();
    const host = createHost([homeTileLayout], deps);
    await host.activate();

    // A bus subscriber stands in for transport-ws (the verbatim ferry).
    const seen: Array<{ type: string; mode?: string; data?: unknown }> = [];
    host.getHostAPI().on(tileLayoutChanged, (message) => {
      seen.push(message);
    });

    const service = host.getHostAPI().tryGetService(homeTileLayoutHandle);
    if (service === undefined) throw new Error("service not provided");

    const doc = {
      version: 2 as const,
      tiles: [{ id: "alpha", colSpan: 2, rowSpan: 1, order: 0, col: 1, row: 1 }],
    };
    await service.put("tall", doc);
    expect(seen).toEqual([{ type: "tile-layout", mode: "tall", data: doc }]);

    // A read-triggered seed is NOT a write — no event.
    seen.length = 0;
    await service.get("wide");
    expect(seen).toEqual([]);
  });

  it("the disposal contract holds: unload removes the service with ZERO dangling ledger entries", async () => {
    const host = createHost([homeTileLayout], makeHostDeps());
    await host.activate();
    expect(host.getHostAPI().tryGetService(homeTileLayoutHandle)).toBeDefined();

    const unload = await host.unloadExtension("home-tile-layout");
    expect(unload.ok).toBe(true);
    expect(unload.dangling ?? []).toEqual([]);
    expect(host.getHostAPI().tryGetService(homeTileLayoutHandle)).toBeUndefined();
  });
});
