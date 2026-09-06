/**
 * The layout-provider REGISTRY (per-workspace activation) — the evolution of
 * the plan-02 single-slot, first-provider-wins provider handle. Every LOADED
 * layout plugin registers its provider here under its own plugin id; the ONE
 * provider that serves a given workspace is decided PER WORKSPACE by the
 * per-workspace enablement state (plan 06) — the workspace plugin modal's
 * per-workspace checkboxes are the activation UI:
 *
 * - multiple layout plugins coexist LOADED (each registered under its id);
 * - exactly ONE is ACTIVE per workspace — the enabled one; a workspace with
 *   none enabled has NO provider (the well-known routes 404 and clients
 *   render their built-in default with ephemeral edits — graceful degrade);
 * - a workspace with SEVERAL enabled layout plugins is a misconfiguration;
 *   {@link selectLayoutPlugin} breaks the tie deterministically (alphabetical
 *   plugin id) so the system stays correct while the user fixes it.
 *
 * The registry itself is pure in-memory data + ONE injected decision (the
 * enablement lookup) — no I/O, no ambient state. The extension that provides
 * it (`layout-provider-registry`, standard tier) wires the enablement plane
 * in; layout plugins and consumers share the typed
 * {@link layoutProviderRegistryHandle}.
 */

import type { Logger } from "@dispatch/kernel";
import type { LayoutProvider } from "@dispatch/layout-contract";

/**
 * The registry service — what layout plugins register into and what consumers
 * resolve the workspace-active provider from (the transport's route handlers
 * call {@link LayoutProviderRegistry.providerFor} per request).
 */
export interface LayoutProviderRegistry {
  /**
   * Register a layout provider under its PLUGIN id (the manifest id — the
   * same id the per-workspace enablement store keys states by). Last-wins on
   * a duplicate id (a reload re-registering replaces its own entry). Returns
   * the unregister disposer — call it in `deactivate()` (the registration is
   * SERVICE-mediated and invisible to the disposal ledger).
   */
  readonly register: (pluginId: string, provider: LayoutProvider) => () => void;
  /** The registered layout plugin ids (registration order). */
  readonly ids: () => readonly string[];
  /** One plugin's provider by id (undefined when that plugin is not loaded). */
  readonly get: (pluginId: string) => LayoutProvider | undefined;
  /**
   * THE per-workspace resolution: the provider of the ONE layout plugin
   * enabled in `workspaceId`. `undefined` = no provider for this workspace
   * (none enabled, the enablement plane unavailable, or nothing registered)
   * — the caller's degrade path (HTTP 404 → the frontend's no-provider mode).
   * Never throws.
   */
  readonly providerFor: (workspaceId: string) => Promise<LayoutProvider | undefined>;
}

export interface LayoutProviderRegistryDeps {
  /**
   * The per-workspace ACTIVATION decision — injected (AGENTS.md: effects at
   * the edges, decision logic pure). Given the workspace and the currently-
   * registered layout plugin ids, returns the id of the ONE plugin enabled
   * in that workspace, or `undefined` when none is. The
   * `layout-provider-registry` extension wires this to the per-workspace
   * enablement plane (`workspace-plugin-config`); tests inject a stub.
   * MUST return a registered id (or undefined) — a stale pick is dropped
   * with a warning, never a crash.
   */
  readonly pickPlugin: (
    workspaceId: string,
    pluginIds: readonly string[],
  ) => Promise<string | undefined>;
  readonly logger: Logger;
}

export function createLayoutProviderRegistry(
  deps: LayoutProviderRegistryDeps,
): LayoutProviderRegistry {
  const providers = new Map<string, LayoutProvider>();

  return {
    register(pluginId, provider) {
      providers.set(pluginId, provider);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        // Only remove OUR registration — a re-register with the same id
        // (last-wins replace) must survive an older disposer running late.
        if (providers.get(pluginId) === provider) providers.delete(pluginId);
      };
    },

    ids() {
      return [...providers.keys()];
    },

    get(pluginId) {
      return providers.get(pluginId);
    },

    async providerFor(workspaceId) {
      const ids = [...providers.keys()];
      // Nothing loaded → the enablement plane is not even consulted (the
      // same degrade shape as before any layout plugin existed).
      if (ids.length === 0) return undefined;
      const picked = await deps.pickPlugin(workspaceId, ids);
      if (picked === undefined) return undefined;
      const provider = providers.get(picked);
      if (provider === undefined) {
        // A pick that lost its registration between selection and lookup
        // (the plugin was unloaded mid-request): degrade, never crash.
        deps.logger.warn(
          "layout-provider-registry: the workspace's layout plugin is no longer registered — treating the workspace as provider-less",
          { workspaceId, pluginId: picked, registered: ids.join(",") },
        );
        return undefined;
      }
      return provider;
    },
  };
}

// ── The pure selection rule (unit-test dense) ───────────────────────────────

/**
 * The outcome of {@link selectLayoutPlugin}: the plugin id that serves the
 * workspace. `contested` marks the misconfiguration case (SEVERAL layout
 * plugins enabled at once) — the tie-break still picked one, deterministically
 * (alphabetical plugin id), so callers should log a warning naming the
 * workspace's enabled set and the served plugin.
 */
export type LayoutPluginSelection =
  | { readonly ok: true; readonly pluginId: string; readonly contested: boolean }
  | { readonly ok: false; readonly reason: "none" };

/**
 * Pick THE active layout plugin for a workspace from the ENABLED candidates
 * (pure). The caller resolves "enabled" via the per-workspace enablement
 * plane; this rule is the single source of truth for the ONE-of-N choice:
 *
 * - exactly one enabled → that one;
 * - none enabled → `{ ok: false, reason: "none" }` (the workspace's
 *   no-provider mode — routes 404, clients degrade);
 * - several enabled → the alphabetically FIRST id wins, `contested: true`
 *   (a stable, load-order-independent tie-break for a state the workspace
 *   plugin modal treats as a misconfiguration — fix it by disabling all
 *   but one).
 */
export function selectLayoutPlugin(usableIds: readonly string[]): LayoutPluginSelection {
  if (usableIds.length === 0) return { ok: false, reason: "none" };
  const sorted = [...usableIds].sort();
  const first = sorted[0];
  if (first === undefined) return { ok: false, reason: "none" };
  return { ok: true, pluginId: first, contested: usableIds.length > 1 };
}
