/**
 * layout-diagnostic extension — a DIAGNOSTIC layout provider plugin (D-L3).
 * Built from the SAME generic machinery as layout-chat (the plan-02
 * `createLayoutProvider` kit + the same well-known routes), seeding
 * `DIAGNOSTIC_LAYOUT` — the default layout with border markers on its two
 * root tiles — instead of the plain default.
 *
 * It exists purely so a human can SEE the layout system's tiles in the
 * browser; it changes nothing else about the layout system.
 *
 * PER-WORKSPACE ACTIVATION (the evolved decision 8): this plugin REGISTERS
 * its provider in the layout-provider registry (reactively —
 * `onServiceAvailable`, no ordering assumption) alongside layout-chat, and
 * the workspace's enablement state decides which ONE serves each workspace:
 * open the workspace plugins modal and enable `layout-diagnostic` (and
 * disable `layout-chat`) in a workspace — that workspace's layout routes
 * then serve the diagnostic tree, and the frontend renders the red/green
 * tile-border markers. Workspaces that keep layout-chat enabled are
 * unaffected (multiple layout plugins coexist loaded; exactly one is active
 * per workspace).
 *
 * Disabling/unloading THIS plugin removes it from the workspace's
 * resolution: with no other layout plugin enabled there, the well-known
 * routes 404 and clients render their built-in default while edits become
 * ephemeral until a layout plugin is enabled — the system degrades, it
 * never breaks (§2.3).
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import {
  createLayoutProvider,
  type LayoutProviderRegistry,
  layoutChanged,
  layoutProviderRegistryHandle,
} from "@dispatch/layout-provider-contract";
import { manifest } from "./manifest.js";
import { DIAGNOSTIC_LAYOUT } from "./tree.js";

export { manifest };

/** The un-register disposer captured when the plugin registers (the disposal contract). */
let disposeRegistration: (() => void) | undefined;
/** The registry-availability subscription (ledger-tracked; disposed in deactivate). */
let disposeSubscription: (() => void) | undefined;

export function activate(host: HostAPI): void {
  const provider = createLayoutProvider({
    // This plugin's OWN storage namespace (D-L4/D-L6: the plugin stores the
    // persisted trees — there is no core layout store).
    storage: host.storage("layout-diagnostic"),
    defaultTree: DIAGNOSTIC_LAYOUT,
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
    host.logger.info("layout-diagnostic: registered in the layout-provider registry");
  };

  // Late-join semantics: fires immediately when the registry is already
  // provided, and on every subsequent provide (a registry reload).
  disposeSubscription = host.onServiceAvailable(layoutProviderRegistryHandle, register);

  host.logger.info(
    "layout-diagnostic: layout provider ready (enable it in a workspace's plugins to activate)",
  );
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
