import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
/**
 * The plan-08 `lsp` MECHANISM PILOT (§12) — end-to-end proof that a real,
 * bundled STANDARD plugin flows through the new system:
 *
 * 1. lsp is loaded at boot (bundled, tier standard) and its tool registers
 *    under the plan-01 ledger (attribution: tool "lsp" → plugin "lsp").
 * 2. BLANK per-workspace default → INERT everywhere: `undefined` behaves as
 *    disabled for the standard tier (`isPluginUsable`), so the plan-06 tool
 *    gate drops the `lsp` tool from every workspace's assembly.
 * 3. Enabling `lsp` in ONE workspace adds the tool to THAT workspace's turns
 *    only — other workspaces stay inert.
 * 4. Disabling removes it again.
 * 5. Unloading the plugin (plan-01 engine) leaves ZERO dangling
 *    registrations and removes the tool globally.
 *
 * The workspace-plugin-config CORE extension is loaded REAL (it provides the
 * enforcement plane's store over the host's storage factory), so the pilot
 * exercises the actual wiring, not a stand-in.
 *
 * lsp's crash/leak fix is explicitly OUT OF SCOPE (§12) — the plugin is
 * known-broken WHEN USED; this test never starts a language server. The
 * point is the load/unload/enable machinery.
 */

import { createBus, createHost, createLogger, type Host, type HostDeps } from "@dispatch/kernel";
import { extension as lspExt } from "@dispatch/lsp";
import { gateToolsForWorkspace, type ToolAssembly } from "@dispatch/session-orchestrator";
import {
  DEFAULT_WORKSPACE_ID,
  usablePluginsInWorkspace,
  type WorkspacePluginConfigService,
  extension as workspacePluginConfigExt,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import { describe, expect, it } from "vitest";

/** In-memory host deps (same shape the kernel's own tests use — no mocks). */
function makeDeps(): HostDeps {
  const logger = createLogger(
    { extensionId: "lsp-pilot-test" },
    { emit: () => {} },
    {
      now: () => 0,
      newId: () => "pilot",
    },
  );
  const stores = new Map<string, Map<string, string>>();
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
    events: { emit: () => {} },
    logSink: { emit: () => {} },
    logDeps: { now: () => 0, newId: () => "pilot" },
  };
}

/** The per-workspace config service, resolved through the REAL core extension's handle. */
function configServiceOf(host: Host): WorkspacePluginConfigService {
  return host.getHostAPI().getService(workspacePluginConfigHandle);
}

/** Resolve the workspace's tool assembly the way the orchestrator's gate does. */
async function gatedTools(host: Host, workspaceId: string): Promise<readonly string[]> {
  const config = configServiceOf(host);
  const toolNames = [...host.getTools().keys()];
  const tierById = new Map(host.getExtensions().map((m) => [m.id, m.tier]));
  const usable = await usablePluginsInWorkspace(
    workspaceId,
    [...new Set(host.getToolOwners().values())],
    config,
    (pluginId) => tierById.get(pluginId),
  );
  const assembly: ToolAssembly = {
    tools: toolNames.map((name) => {
      const tool = host.getTool(name);
      if (tool === undefined) throw new Error(`tool "${name}" vanished mid-assembly`);
      return tool;
    }),
    conversationId: "pilot-conv",
    workspaceId,
  };
  const ownerOfTool = (name: string) => host.getToolOwners().get(name);
  return gateToolsForWorkspace(assembly, usable, ownerOfTool).tools.map((t) => t.name);
}

describe("lsp pilot — bundled standard plugin through the new machinery (plan 08 §8.5)", () => {
  it("boot → blank default is inert → workspace opt-in adds the tool there only → disable → unload leaves zero dangling", async () => {
    const deps = makeDeps();
    const host = createHost([workspacePluginConfigExt, lspExt], deps);
    await host.activate();

    // 1. Loaded globally; the ledger attributes the tool to the plugin.
    expect(host.getExtensions().some((m) => m.id === "lsp")).toBe(true);
    expect(host.getTool("lsp")).toBeDefined();
    expect(host.getToolOwners().get("lsp")).toBe("lsp");

    // 2. Blank default → INERT: the default workspace has no lsp record, and
    //    undefined behaves as disabled for the standard tier.
    const config = configServiceOf(host);
    expect(config).toBeDefined();
    expect(await config.stateOf(DEFAULT_WORKSPACE_ID, "lsp")).toBeUndefined();
    expect(await gatedTools(host, DEFAULT_WORKSPACE_ID)).not.toContain("lsp");
    // A FRESH workspace (never touched) is equally inert.
    expect(await gatedTools(host, "ws-fresh")).not.toContain("lsp");

    // 3. Opting in ONE workspace adds the tool THERE — and only there.
    const enable = await config.setState("ws-a", "lsp", "enabled");
    expect(enable).toEqual({ ok: true, state: "enabled" });
    expect(await gatedTools(host, "ws-a")).toContain("lsp");
    expect(await gatedTools(host, "ws-fresh")).not.toContain("lsp");
    expect(await gatedTools(host, DEFAULT_WORKSPACE_ID)).not.toContain("lsp");

    // 4. Disabling removes it again.
    const disable = await config.setState("ws-a", "lsp", "disabled");
    expect(disable).toEqual({ ok: true, state: "disabled" });
    expect(await gatedTools(host, "ws-a")).not.toContain("lsp");

    // 5. Unload: zero dangling registrations, tool gone globally.
    const unload = await host.unloadExtension("lsp");
    expect(unload.ok).toBe(true);
    expect(unload.dangling).toBeUndefined();
    expect(host.getTool("lsp")).toBeUndefined();
    expect(host.getToolOwners().has("lsp")).toBe(false);
  });

  it("the engine refuses a duplicate load of an already-loaded plugin id with a reason (the machinery lsp rides on)", async () => {
    const deps = makeDeps();
    const host = createHost([workspacePluginConfigExt, lspExt], deps);
    await host.activate();
    const dup = await host.loadExtension(lspExt);
    expect(dup.ok).toBe(false);
    expect(dup.reason).toContain("already loaded");
  });
});
