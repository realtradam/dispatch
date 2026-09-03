/**
 * The shared workspace-usability resolver for the enforcement plane
 * (plan 06): the tool gate (session-orchestrator), the provider/model gate
 * (transport-http `/models` + the orchestrator's model-unavailable error),
 * and the surface-catalog filter (transport-ws) all reduce to "which of
 * these plugin ids is usable in workspace W" — this computes exactly that,
 * once, over the ONE pure rule (`isPluginUsable`).
 *
 * Fail-open on the unclassifiable: a plugin id whose tier cannot be
 * determined (owner not in the loaded manifests — e.g. a stale
 * catalog entry or a race with an unload) is treated as USABLE. Global
 * loaded/unloaded state already gates it elsewhere (the host sweep removes
 * an unloaded plugin's registrations); per-workspace gating only narrows
 * what is already loadable, and gating what we cannot attribute would be
 * silent over-enforcement.
 */

import type { PluginTier } from "@dispatch/kernel";
import { isPluginUsable } from "./pure.js";
import type { WorkspacePluginConfigService } from "./service.js";

/**
 * Resolve the subset of `pluginIds` usable in `workspaceId`.
 *
 * @param config  The workspace-plugin-config service (structural: only
 *   `stateOf` is required, so fakes are trivial in tests).
 * @param tierOf  Live tier lookup for a plugin id (from the host's loaded
 *   manifests). `undefined` = not classifiable → treated usable.
 */
export async function usablePluginsInWorkspace(
  workspaceId: string,
  pluginIds: readonly string[],
  config: Pick<WorkspacePluginConfigService, "stateOf">,
  tierOf: (pluginId: string) => PluginTier | undefined,
): Promise<ReadonlySet<string>> {
  const usable = new Set<string>();
  const seen = new Set<string>();
  for (const pluginId of pluginIds) {
    if (seen.has(pluginId)) continue;
    seen.add(pluginId);
    const tier = tierOf(pluginId);
    if (tier === undefined) {
      usable.add(pluginId); // fail-open — see module doc
      continue;
    }
    // Read-through: the first stateOf for this workspace materializes it.
    const state = await config.stateOf(workspaceId, pluginId);
    if (isPluginUsable(tier, state)) usable.add(pluginId);
  }
  return usable;
}
