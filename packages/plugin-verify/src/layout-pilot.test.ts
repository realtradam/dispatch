/**
 * The plan-04 PILOT — the harness's test-host integration over the REAL
 * layout machinery (plan 04 §4.6, evolved for PER-WORKSPACE activation).
 * Loads `layout-chat` + `layout-diagnostic` (coexisting layout providers) +
 * `plugin-scaffold` (the layout-op example) into ONE kernel host with the
 * REAL workspace-plugin-config extension (the enablement plane) and asserts
 * the whole story:
 *
 * 1. PER-WORKSPACE ACTIVATION: the workspace with layout-chat enabled gets
 *    the chat tree; the workspace with layout-diagnostic enabled gets the
 *    marked diagnostic tree; NEITHER enabled resolves no provider (404
 *    degrade); both plugins coexist LOADED without error (the old
 *    first-provider-wins throw is gone);
 * 2. the scaffold's activation applies its `ensurePanel` op through the
 *    workspace's resolved provider — the panel appears EXACTLY ONCE, across
 *    double activation (ensure-first idempotence);
 * 3. NO-REVERT (decision 6): deactivating the scaffold leaves the tree
 *    UNCHANGED (its panel stays; its edits are permanent);
 * 4. reset: `resetTree` re-seeds — the tree returns to `DEFAULT_LAYOUT`.
 *
 * No internal mocks (AGENTS.md): a real bus/host, the real kit providers
 * over in-memory storage, the real registry extension + config extension,
 * the real scaffold + layout-chat + layout-diagnostic extensions. The only
 * fakes are the kernel's own in-memory host deps (the disposal.ts pattern)
 * and a silent logger.
 */

import { createHost, createLogger, type Logger } from "@dispatch/kernel";
import { extension as layoutChat } from "@dispatch/layout-chat";
import { DEFAULT_LAYOUT, findById, type LayoutProvider } from "@dispatch/layout-contract";
import { extension as layoutDiagnostic } from "@dispatch/layout-diagnostic";
import { layoutProviderRegistryHandle } from "@dispatch/layout-provider-contract";
import { createLayoutProviderRegistryExtension } from "@dispatch/layout-provider-registry";
import { extension as scaffold } from "@dispatch/plugin-scaffold";
import { createSurfaceRegistryExtension } from "@dispatch/surface-registry";
import {
  extension as workspacePluginConfigExtension,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import { describe, expect, it } from "vitest";
import { makeHostDeps } from "./disposal.js";

const silentLogger: Logger = createLogger(
  { extensionId: "layout-pilot" },
  { emit: () => {} },
  { now: () => 0, newId: () => "layout-pilot" },
);

/** The workspace the scaffold's demo ops target (its documented demo constant). */
const WS = "default";

/** Flush the scaffold's fire-and-forget `applyOps` promise chain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The scaffold panel's leaf count, as the provider currently serves it. */
async function scaffoldPanels(provider: LayoutProvider): Promise<number> {
  const tree = await provider.getTree(WS);
  const side = findById(tree, "side");
  if (side === null || side.node.kind !== "panels") return 0;
  return side.node.panels.filter((p) => p.view === "plugin-scaffold").length;
}

/** The real host set: enablement plane + registry + BOTH layout plugins. */
function makeHost(): Awaited<ReturnType<typeof createHost>> {
  return createHost(
    [
      workspacePluginConfigExtension,
      createLayoutProviderRegistryExtension(),
      layoutChat,
      layoutDiagnostic,
      createSurfaceRegistryExtension(),
    ],
    makeHostDeps(silentLogger),
  );
}

/**
 * Enable a layout plugin in a workspace, THEN load the scaffold — the
 * production order for the demo (the scaffold applies its ops at
 * activation; loading it into a workspace with no enabled layout plugin
 * degrades gracefully and places nothing).
 */
async function loadScaffoldAfterEnable(
  host: Awaited<ReturnType<typeof createHost>>,
  workspaceId: string,
  pluginId: "layout-chat" | "layout-diagnostic",
): Promise<void> {
  await enable(host, workspaceId, pluginId);
  const load = await host.loadExtension(scaffold);
  expect(load.ok).toBe(true);
}

/** Enable a plugin in a workspace through the REAL config service. */
async function enable(
  host: Awaited<ReturnType<typeof createHost>>,
  workspaceId: string,
  pluginId: string,
): Promise<void> {
  const config = host.getHostAPI().tryGetService(workspacePluginConfigHandle);
  if (config === undefined) throw new Error("workspace-plugin-config not provided");
  await config.setState(workspaceId, pluginId, "enabled");
}

describe("layout pilot — per-workspace activation + scaffold layout ops (plan 04 §4.6)", () => {
  it("PER-WORKSPACE ACTIVATION: chat's workspace gets the chat tree; the diagnostic workspace gets the marked tree; neither enabled → no provider", async () => {
    const host = makeHost();
    await host.activate();
    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(registry).toBeDefined();
    if (registry === undefined) return;

    // Both layout plugins are LOADED and registered — no first-provider-wins
    // race, no disabled-with-reason entry (coexistence is the design).
    expect(host.getDisabled().map((d) => d.manifest.id)).not.toContain("layout-diagnostic");
    expect(registry.ids().sort()).toEqual(["layout-chat", "layout-diagnostic"]);

    // No workspace enabled yet → no provider anywhere (the degrade).
    expect(await registry.providerFor("ws-a")).toBeUndefined();

    // The chat workspace resolves the chat tree.
    await enable(host, "ws-a", "layout-chat");
    const chatProvider = await registry.providerFor("ws-a");
    expect(await chatProvider?.getTree("fresh")).toEqual(DEFAULT_LAYOUT);

    // The diagnostic workspace resolves the MARKED tree (markers ride the
    // root tiles — the frontend renders the red/green borders).
    await enable(host, "ws-b", "layout-diagnostic");
    const diagProvider = await registry.providerFor("ws-b");
    expect(await diagProvider?.getTree("fresh")).not.toEqual(DEFAULT_LAYOUT);
    expect(JSON.stringify(await diagProvider?.getTree("fresh"))).toContain('"marker"');

    // Switching ws-a to the diagnostic layout is a per-workspace state change.
    await enable(host, "ws-a", "layout-diagnostic");
    const config = host.getHostAPI().tryGetService(workspacePluginConfigHandle);
    await config?.setState("ws-a", "layout-chat", "disabled");
    const switched = await registry.providerFor("ws-a");
    expect(JSON.stringify(await switched?.getTree("fresh"))).toContain('"marker"');
  });

  it("activation applies the ensurePanel op: the panel appears EXACTLY ONCE, across double activation", async () => {
    const host = makeHost();
    await host.activate();
    await loadScaffoldAfterEnable(host, WS, "layout-chat");
    await settle();

    const api = host.getHostAPI();
    const registry = api.tryGetService(layoutProviderRegistryHandle);
    const liveProvider = await registry?.providerFor(WS);
    expect(liveProvider).toBeDefined();
    if (liveProvider === undefined) return;
    expect(await scaffoldPanels(liveProvider)).toBe(1);

    // Double activation (unload → load — the re-enable path): the ensure op
    // is idempotent, so the panel is STILL there exactly once.
    const unload = await host.unloadExtension(scaffold.manifest.id);
    expect(unload.ok).toBe(true);
    const reload = await host.loadExtension(scaffold);
    expect(reload.ok).toBe(true);
    await settle();
    expect(await scaffoldPanels(liveProvider)).toBe(1);
  });

  it("the scaffold degrades when NO layout plugin is enabled in its workspace (ops do not run)", async () => {
    // A host where the scaffold's workspace enables NOTHING: the scaffold
    // activates, its resolution finds no provider, the panel is not placed.
    const host = makeHost();
    await host.activate();
    const load = await host.loadExtension(scaffold);
    expect(load.ok).toBe(true);
    await settle();

    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    expect(await registry?.providerFor(WS)).toBeUndefined();
    // The scaffold itself is loaded (it degraded gracefully, no error).
    expect(host.getDisabled().map((d) => d.manifest.id)).not.toContain("plugin-scaffold");
  });

  it("NO-REVERT (decision 6): deactivating the scaffold leaves the tree UNCHANGED — its panel stays", async () => {
    const host = makeHost();
    await host.activate();
    await loadScaffoldAfterEnable(host, WS, "layout-chat");
    await settle();

    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    const liveProvider = await registry?.providerFor(WS);
    expect(liveProvider).toBeDefined();
    if (liveProvider === undefined) return;
    const before = await liveProvider.getTree(WS);

    const unload = await host.unloadExtension(scaffold.manifest.id);
    expect(unload.ok).toBe(true);
    expect(unload.dangling ?? []).toEqual([]);

    // The tree is UNCHANGED: unloading an op-writing plugin does NOT revert
    // its edits (later edits may have built on them; a revert graph is
    // unbounded). The scaffold's deactivate deliberately touches nothing.
    const after = await liveProvider.getTree(WS);
    expect(after).toEqual(before);
    expect(await scaffoldPanels(liveProvider)).toBe(1);
  });

  it("reset: resetTree re-seeds — the workspace tree returns to DEFAULT_LAYOUT", async () => {
    const host = makeHost();
    await host.activate();
    await loadScaffoldAfterEnable(host, WS, "layout-chat");
    await settle();

    const registry = host.getHostAPI().tryGetService(layoutProviderRegistryHandle);
    const liveProvider = await registry?.providerFor(WS);
    expect(liveProvider).toBeDefined();
    if (liveProvider === undefined) return;
    expect(await scaffoldPanels(liveProvider)).toBe(1);

    const reset = await liveProvider.resetTree(WS);
    expect(reset).toEqual(DEFAULT_LAYOUT);
    const after = await liveProvider.getTree(WS);
    expect(after).toEqual(DEFAULT_LAYOUT);
    expect(await scaffoldPanels(liveProvider)).toBe(0);
  });

  it("the scaffold itself passes the harness (the pilot must not break verify-plugin)", async () => {
    // The pilot's subscription + the scaffold's layout-resolution are
    // ledger-tracked registrations; the disposal round-trip proves the
    // scaffold still disposes EVERYTHING on deactivate. The frontend entry
    // must exist (the verify.test.ts precedent: build it when missing —
    // vitest file order is not guaranteed).
    const { verifyPlugin } = await import("./verify.js");
    const { join } = await import("node:path");
    const { stat } = await import("node:fs/promises");
    const { execSync } = await import("node:child_process");
    const dir = join(import.meta.dirname, "..", "..", "plugin-scaffold");
    try {
      await stat(join(dir, "frontend.js"));
    } catch {
      execSync("bun run build:frontend", { cwd: dir, stdio: "pipe" });
    }
    const report = await verifyPlugin(scaffold, { pluginDir: dir });
    if (!report.ok) {
      console.log("PILOT-VERIFY-PROBLEMS", JSON.stringify(report.problems, null, 2));
    }
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });
});
