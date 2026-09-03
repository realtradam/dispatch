/**
 * workspace-plugin-config extension — the per-workspace plugin enablement
 * STORE (plan 06 §6.1): a CORE extension that owns the
 * `workspace-plugin-config` KV namespace and exposes the typed
 * {@link workspacePluginConfigHandle} service for the enforcement plane
 * (tool gate, model gate, surface filter) and the workspace-modal routes.
 *
 * Tier: core — the enforcement plane reads it every turn, so it must
 * always be loaded (user-confirmed classification, plan 00; do not
 * re-litigate). It has NO dependencies beyond the kernel: the loaded
 * plugin catalog comes from `host.getExtensions()` (a HostAPI surface), so
 * it activates anywhere without ordering constraints — every consumer
 * reads it reactively (plan 03).
 *
 * Blank slate (§7): NOTHING is written at activation. States appear only
 * via read-through materialization (the first read of a workspace) or an
 * explicit `setState`.
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { WORKSPACE_PLUGIN_CONFIG_NAMESPACE } from "./pure.js";
import { createWorkspacePluginConfigService } from "./service.js";
import { workspacePluginConfigHandle } from "./service-handle.js";

export const manifest: Manifest = {
  id: "workspace-plugin-config",
  name: "Workspace Plugin Config",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "core",
  trust: "bundled",
  activation: "eager",
  capabilities: { db: true },
  contributes: {
    services: ["workspace-plugin-config/store"],
  },
};

export function activate(host: HostAPI): void {
  const storage = host.storage(WORKSPACE_PLUGIN_CONFIG_NAMESPACE);
  const service = createWorkspacePluginConfigService({
    storage,
    // Live view of the loaded plugin catalog — read per call, so
    // mid-session loads/unloads are seen on the next read.
    getPlugins: () => host.getExtensions().map((m) => ({ id: m.id, tier: m.tier })),
    logger: host.logger,
  });
  host.provideService(workspacePluginConfigHandle, service);
  host.logger.info("workspace-plugin-config: activated");
}

export const extension: Extension = {
  manifest,
  activate,
};
