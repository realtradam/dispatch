/**
 * layout-provider-registry extension — the per-workspace layout ACTIVATION
 * plane.
 *
 * Provides the typed `layoutProviderRegistryHandle` (the in-memory
 * registry from `@dispatch/layout-provider-contract`) and wires its ONE
 * injected decision — `pickPlugin` — to the per-workspace enablement plane
 * (`workspace-plugin-config`, core): the workspace's enabled layout plugins
 * (per the plan-06 `isPluginUsable` rule over the loaded manifests' tiers)
 * are resolved through the pure `selectLayoutPlugin` rule, so EXACTLY ONE
 * registered layout plugin serves each workspace:
 *
 * - workspace with exactly one layout plugin enabled → that plugin's
 *   provider (the routes serve its tree; the frontend renders it);
 * - none enabled → no provider → the well-known routes 404 → clients
 *   render their built-in default with ephemeral edits (graceful degrade);
 * - several enabled → the pure rule's deterministic tie-break (alphabetical
 *   plugin id) + a WARN naming the contested set.
 *
 * Consumption of the config service is REACTIVE (plan 03 — a slot kept
 * fresh by availability subscriptions): the registry activates anywhere,
 * and while the config service is absent resolution fails CLOSED (no
 * provider → 404) — the safe side of gating. The registry itself never
 * reads a tree: it is the mechanism, not the domain (D-L6).
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import {
  createLayoutProviderRegistry,
  type LayoutProviderRegistry,
  layoutProviderRegistryHandle,
  selectLayoutPlugin,
} from "@dispatch/layout-provider-contract";
import type { WorkspacePluginConfigService } from "@dispatch/workspace-plugin-config";
import {
  usablePluginsInWorkspace,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import { manifest } from "./manifest.js";

export { manifest };

export function createLayoutProviderRegistryExtension(): Extension {
  /** Availability-subscription disposers (disposed on deactivate). */
  let availabilityDisposers: Array<() => void> = [];

  return {
    manifest,
    activate(host: HostAPI): void {
      // The reactive slot for the enablement plane (the transport-http slot
      // pattern): availability subscriptions keep `current` fresh;
      // resolution reads it per request, so a mid-session change is seen on
      // the next one.
      const slot: { current: WorkspacePluginConfigService | undefined } = {
        current: host.tryGetService(workspacePluginConfigHandle),
      };
      availabilityDisposers = [
        host.onServiceAvailable(workspacePluginConfigHandle, (service) => {
          slot.current = service;
        }),
        host.onServiceUnavailable(workspacePluginConfigHandle, () => {
          slot.current = undefined;
        }),
      ];

      const registry: LayoutProviderRegistry = createLayoutProviderRegistry({
        pickPlugin: async (workspaceId, pluginIds) => {
          const config = slot.current;
          if (config === undefined) {
            // Fail CLOSED: without the enablement plane we cannot attribute
            // a provider to the workspace — no layout serves it (the
            // degrade path, never an over-broad serve).
            host.logger.warn(
              "layout-provider-registry: workspace-plugin-config unavailable — no layout resolves (fail-closed)",
              { workspaceId },
            );
            return undefined;
          }
          // Live tier lookup over the loaded manifests (plan 06 §6.5 — the
          // transport-http `pluginTierOf` pattern): mid-session loads/unloads
          // are seen on the next request; an unclassifiable plugin fails OPEN
          // (the usablePluginsInWorkspace rule) like every other gate.
          const usable = await usablePluginsInWorkspace(
            workspaceId,
            pluginIds,
            config,
            (pluginId) => host.getExtensions().find((m) => m.id === pluginId)?.tier,
          );
          const selection = selectLayoutPlugin([...usable]);
          if (!selection.ok) return undefined; // the workspace's no-provider mode
          if (selection.contested) {
            host.logger.warn(
              "layout-provider-registry: multiple layout plugins are enabled in the workspace — serving the alphabetically first",
              {
                workspaceId,
                enabled: [...usable].sort().join(","),
                serving: selection.pluginId,
              },
            );
          }
          return selection.pluginId;
        },
        logger: host.logger,
      });

      host.provideService(layoutProviderRegistryHandle, registry);
      host.logger.info("layout-provider-registry: activated (per-workspace layout activation)");
    },

    deactivate() {
      // Disposal contract: the availability subscriptions this extension
      // created are its own — dispose them (the ledger-wrapped disposers
      // are idempotent; the host force-cleans the provided service itself).
      for (const dispose of availabilityDisposers) dispose();
      availabilityDisposers = [];
    },
  };
}
