/**
 * The plan-04 PILOT — the harness's test-host integration over the REAL
 * layout machinery (plan 04 §4.6). Loads `layout-chat` (the provider plugin)
 * + `plugin-scaffold` (the layout-op example) into ONE kernel test host and
 * asserts the whole pilot story:
 *
 * 1. the scaffold's activation applies its `ensurePanel` op through the
 *    provider — the workspace tree gains the panel EXACTLY ONCE, across
 *    double activation (ensure-first idempotence);
 * 2. the deferred-provider path: a scaffold activated with NO provider
 *    applies its ops when a provider loads LATER (`onServiceAvailable` —
 *    the real reactive-registry path, real bus, real kit provider);
 * 3. NO-REVERT (decision 6): deactivating the scaffold leaves the tree
 *    UNCHANGED (its panel stays; its edits are permanent);
 * 4. reset: `resetTree` re-seeds — the tree returns to `DEFAULT_LAYOUT`.
 *
 * No internal mocks (AGENTS.md): a real bus/host, the real kit provider over
 * an in-memory storage namespace, the real scaffold + layout-chat extensions.
 * The only fakes are the kernel's own in-memory host deps (the disposal.ts
 * pattern) and a silent logger.
 */

import { createHost, createLogger, type Logger } from "@dispatch/kernel";
import { extension as layoutChat } from "@dispatch/layout-chat";
import { DEFAULT_LAYOUT, findById, type LayoutProvider } from "@dispatch/layout-contract";
import { layoutProviderHandle } from "@dispatch/layout-provider-contract";
import { extension as scaffold } from "@dispatch/plugin-scaffold";
import { createSurfaceRegistryExtension } from "@dispatch/surface-registry";
import { beforeEach, describe, expect, it } from "vitest";
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

/** The real kit provider over in-memory storage (what layout-chat provides). */
async function makeProvider() {
  const deps = makeHostDeps(silentLogger);
  const host = createHost([layoutChat], deps);
  await host.activate();
  const api = host.getHostAPI();
  const provider = api.tryGetService(layoutProviderHandle);
  if (provider === undefined) throw new Error("layout-chat did not provide the layout provider");
  return { host, provider };
}

let provider: Awaited<ReturnType<typeof makeProvider>>["provider"];
beforeEach(async () => {
  provider = (await makeProvider()).provider;
});

describe("layout pilot — scaffold layout ops through the provider (plan 04 §4.6)", () => {
  it("activation applies the ensurePanel op: the panel appears EXACTLY ONCE, across double activation", async () => {
    const host = createHost(
      [createSurfaceRegistryExtension(), layoutChat, scaffold],
      makeHostDeps(silentLogger),
    );
    await host.activate();
    await settle();

    const api = host.getHostAPI();
    const liveProvider = api.tryGetService(layoutProviderHandle);
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

  it("deferred provider: a scaffold activated with NO provider applies its ops when a provider loads later", async () => {
    // Real bus + real host deps; the provider arrives AFTER the scaffold
    // activated and subscribed (the reactive-registry path — no mocks).
    const deps = makeHostDeps(silentLogger);
    const host = createHost([createSurfaceRegistryExtension(), scaffold], deps);
    await host.activate();
    await settle();

    const api = host.getHostAPI();
    // Absent entirely: no provider → no ops ran → the scaffold degraded.
    expect(api.tryGetService(layoutProviderHandle)).toBeUndefined();

    // A provider loads MID-SESSION: provide the kit provider on the SAME bus
    // the scaffold subscribed to (exactly what layout-chat's activate does —
    // the provider here IS the real kit provider over in-memory storage).
    deps.bus.provideService(layoutProviderHandle, provider);
    await settle();

    // The scaffold's onServiceAvailable callback ran its ops.
    const liveProvider = api.tryGetService(layoutProviderHandle);
    expect(liveProvider).toBeDefined();
    if (liveProvider === undefined) return;
    expect(await scaffoldPanels(liveProvider)).toBe(1);
  });

  it("NO-REVERT (decision 6): deactivating the scaffold leaves the tree UNCHANGED — its panel stays", async () => {
    const host = createHost(
      [createSurfaceRegistryExtension(), layoutChat, scaffold],
      makeHostDeps(silentLogger),
    );
    await host.activate();
    await settle();

    const api = host.getHostAPI();
    const liveProvider = api.tryGetService(layoutProviderHandle);
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
    const host = createHost(
      [createSurfaceRegistryExtension(), layoutChat, scaffold],
      makeHostDeps(silentLogger),
    );
    await host.activate();
    await settle();

    const api = host.getHostAPI();
    const liveProvider = api.tryGetService(layoutProviderHandle);
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
    // The pilot added an onServiceAvailable subscription — a ledger-tracked
    // registration. The disposal round-trip proves the scaffold still
    // disposes EVERYTHING (the subscription included) on deactivate. The
    // frontend entry must exist (the verify.test.ts precedent: build it when
    // missing — vitest file order is not guaranteed).
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
