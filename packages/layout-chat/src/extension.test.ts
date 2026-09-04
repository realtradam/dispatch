/**
 * layout-chat integration tests (plan 02 verification gate) — a REAL kernel
 * host (createBus + createHost + in-memory storage, the plugin-verify
 * pattern — zero Dispatch mocks) with the plugin ACTIVE:
 *
 * - a fresh workspace GETS DEFAULT_LAYOUT (the plan-02 integration gate);
 * - the provider round-trips writes through its storage namespace and
 *   emits `layout` change events through the host's hook bus;
 * - deactivation (unload) un-provides the service (tryGetService →
 *   undefined) and leaves ZERO dangling registrations;
 * - the §2.4 conflict rule (decision 8): a SECOND provider of the same
 *   handle fails LOUDLY — provideService throws, the second plugin's
 *   activation errors into the disabled-with-reason grammar.
 */

import type { EventsEmitter, Extension, Manifest } from "@dispatch/kernel";
import { createBus, createHost, createLogger } from "@dispatch/kernel";
import { DEFAULT_LAYOUT, type LayoutTree } from "@dispatch/layout-contract";
import { layoutChanged, layoutProviderHandle } from "@dispatch/layout-provider-contract";
import { describe, expect, it } from "vitest";
import { extension as layoutChat } from "./extension.js";

/** In-memory host deps — the kernel's own host-test shape (no Dispatch mocks). */
function makeHostDeps() {
  const logger = createLogger(
    { extensionId: "layout-chat-test" },
    { emit: () => {} },
    {
      now: () => 0,
      newId: () => "layout-chat-test",
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
    logDeps: { now: () => 0, newId: () => "layout-chat-test" },
    emitted,
  };
}

function otherTree(): LayoutTree {
  return { version: 1, root: { kind: "leaf", view: "chat" } };
}

describe("layout-chat — integration (real host, plugin active)", () => {
  it("a fresh workspace GETS the DEFAULT_LAYOUT seed through the live service", async () => {
    const deps = makeHostDeps();
    const host = createHost([layoutChat], deps);
    await host.activate();

    const api = host.getHostAPI();
    const provider = api.tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    if (provider === undefined) return;

    const tree = await provider.getTree("fresh-workspace");
    expect(tree).toEqual(DEFAULT_LAYOUT);
    // Read-through materialized the seed in the plugin's own namespace.
    const ns = deps.storageFactory("layout-chat");
    expect(await ns.get("tree:fresh-workspace")).toBe(JSON.stringify(DEFAULT_LAYOUT));
  });

  it("writes round-trip and the layout change event flows through the host bus", async () => {
    const deps = makeHostDeps();
    const host = createHost([layoutChat], deps);
    await host.activate();

    const api = host.getHostAPI();
    const provider = api.tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    if (provider === undefined) return;

    // The plugin wires emitChange → host.emit(layoutChanged, …); assert the
    // hook payload via the same bus the transport subscribes to.
    const received: unknown[] = [];
    const dispose = api.on(layoutChanged, (message) => {
      received.push(message);
    });

    const result = await provider.setTree("ws-a", otherTree());
    expect(result.ok).toBe(true);
    expect(received).toEqual([{ type: "layout", workspaceId: "ws-a", tree: otherTree() }]);
    expect(await provider.getTree("ws-a")).toEqual(otherTree());

    dispose();
  });

  it("the disposal contract holds: unload reports ZERO dangling registrations (the verify-plugin disposal assertion, run here against a real host)", async () => {
    const deps = makeHostDeps();
    const host = createHost([layoutChat], deps);
    await host.activate();
    expect(host.getHostAPI().tryGetService(layoutProviderHandle)).toBeDefined();

    const unload = await host.unloadExtension("layout-chat");
    expect(unload.ok).toBe(true);
    // Zero dangling: the ledger reports nothing force-cleaned (the field is
    // absent/empty when the disposal contract held — the same assertion
    // verify-plugin's disposal check makes over UnloadResult).
    expect(unload.dangling ?? []).toEqual([]);
    expect(host.getHostAPI().tryGetService(layoutProviderHandle)).toBeUndefined();
  });
});

describe("§2.4 provider-resolution rule (decision 8) — second provider rejected loudly", () => {
  it("a second provideService on layoutProviderHandle THROWS and the second plugin lands disabled-with-reason", async () => {
    // A second, independent plugin that provides the SAME handle.
    const secondManifest: Manifest = {
      id: "layout-impostor",
      name: "Layout Impostor",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      tier: "standard",
      trust: "bundled",
      activation: "eager",
    };
    const impostor: Extension = {
      manifest: secondManifest,
      activate(host) {
        // The kernel registry is FIRST-PROVIDER-WINS: this throws because
        // layout-chat (earlier in activation order) already provided it.
        host.provideService(layoutProviderHandle, {
          getTree: async () => otherTree(),
          setTree: async () => ({ ok: true, tree: otherTree() }),
          resetTree: async () => otherTree(),
        });
      },
    };

    const deps = makeHostDeps();
    const host = createHost([layoutChat, impostor], deps);
    await host.activate();

    // The impostor's activation failed LOUDLY into the disabled grammar…
    const disabled = host.getDisabled();
    expect(disabled.map((d) => d.manifest.id)).toEqual(["layout-impostor"]);
    expect(disabled[0]?.reason).toContain("Activation failed");
    expect(disabled[0]?.reason).toContain("already provided");

    // …and the FIRST provider keeps ownership (first-provider-wins).
    const provider = host.getHostAPI().tryGetService(layoutProviderHandle);
    expect(provider).toBeDefined();
    expect(await provider?.getTree("ws-a")).toEqual(DEFAULT_LAYOUT);
  });
});
