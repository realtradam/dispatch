/**
 * layout-chat extension (plan 02 §2.3, evolved for per-workspace activation)
 * — the default-layout provider plugin (D-L3). Builds the provider via the
 * kit with `DEFAULT_LAYOUT` (imported from `@dispatch/layout-contract` — the
 * single source of truth shared with the frontend's fallback renderer) and
 * REGISTERS it under this plugin's id in the layout-provider REGISTRY
 * (`layoutProviderRegistryHandle`).
 *
 * Registration is REACTIVE (the plan-03 pattern — no ordering assumption
 * with the registry extension): `onServiceAvailable` fires immediately when
 * the registry is already provided, and again if the registry itself
 * reloads. Multiple layout plugins coexist LOADED; which one serves a
 * workspace is decided PER WORKSPACE by the workspace's enablement state
 * (the workspace plugins modal's checkboxes) — enable `layout-chat` in a
 * workspace to make it that workspace's layout provider.
 *
 * Disabling THIS plugin's per-workspace state (or unloading it) removes it
 * from that workspace's resolution: if no other layout plugin is enabled
 * there, the well-known routes 404 and clients render their built-in
 * default while edits become ephemeral — the system degrades, it never
 * breaks (§2.3).
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import { DEFAULT_LAYOUT } from "@dispatch/layout-contract";
import {
  createLayoutProvider,
  type LayoutProviderRegistry,
  layoutChanged,
  layoutProviderRegistryHandle,
} from "@dispatch/layout-provider-contract";
import { manifest } from "./manifest.js";

export { manifest };

/** The un-register disposer captured when the plugin registers (the disposal contract). */
let disposeRegistration: (() => void) | undefined;
/** The registry-availability subscription (ledger-tracked; disposed in deactivate). */
let disposeSubscription: (() => void) | undefined;

export function activate(host: HostAPI): void {
  const provider = createLayoutProvider({
    // This plugin's OWN storage namespace (D-L4/D-L6: the plugin stores the
    // persisted trees — there is no core layout store).
    storage: host.storage("layout-chat"),
    defaultTree: DEFAULT_LAYOUT,
    // The outward change emitter — the kernel's event-hook bus (the live
    // `extensions-changed` path): transport-ws broadcasts the payload
    // verbatim to every connected frontend (§2.5).
    emitChange: (message) => host.emit(layoutChanged, message),
    logger: host.logger,
  });

  const register = (registry: LayoutProviderRegistry): void => {
    // Defensive: drop a stale registration before re-registering (a registry
    // reload re-runs this callback with a fresh registry instance).
    disposeRegistration?.();
    disposeRegistration = registry.register(manifest.id, provider);
    host.logger.info("layout-chat: registered in the layout-provider registry");
  };

  // Late-join semantics: fires immediately when the registry is already
  // provided, and on every subsequent provide (a registry reload).
  disposeSubscription = host.onServiceAvailable(layoutProviderRegistryHandle, register);

  host.logger.info("layout-chat: layout provider ready (per-workspace activation)");
}

export const extension: Extension = {
  manifest,
  activate,
  deactivate() {
    // Disposal contract: EVERYTHING this plugin registered goes now — the
    // availability subscription FIRST, then the service-mediated
    // registration (invisible to the ledger; verify-plugin's layout-leak
    // check asserts the registry no longer holds this plugin's id).
    disposeSubscription?.();
    disposeSubscription = undefined;
    disposeRegistration?.();
    disposeRegistration = undefined;
  },
};
