/**
 * layout-diagnostic extension — a DIAGNOSTIC layout provider plugin (D-L3).
 * Built from the SAME generic machinery as layout-chat (the plan-02
 * `createLayoutProvider` kit + the typed `layoutProviderHandle` + the
 * well-known routes), seeding `DIAGNOSTIC_LAYOUT` — the default layout with
 * border markers on its two root tiles — instead of the plain default.
 *
 * It exists purely so a human can SEE the layout system's tiles in the
 * browser; it changes nothing else about the layout system.
 *
 * ONE PROVIDER AT A TIME (decision 8) — this plugin's boot semantics:
 * bundled alongside layout-chat, BOTH are eager, and the kernel's registry
 * is first-provider-wins. Rather than fail its activation loudly into the
 * disabled-with-reason grammar (which would only repeat at every boot —
 * and a FAILED bundled plugin cannot be re-loaded from the plugin UI, whose
 * load path is directory-scan-based), this plugin activates as a HOT
 * STANDBY when another layout provider holds the handle: it subscribes
 * `onServiceUnavailable` and provides automatically the MOMENT that
 * provider unloads (the bus frees the registry slot before the unavailable
 * callbacks run, so the takeover inside the callback is safe). Unchecking
 * the active layout provider in the plugin UI therefore hands the layout to
 * this plugin with no further steps; a restart hands it back to layout-chat.
 *
 * Disabling/unloading THIS plugin while it provides removes layout
 * persistence exactly like layout-chat's unload does: the service is
 * un-provided, the well-known routes 404, and clients render their built-in
 * default while edits become ephemeral until a layout plugin provides —
 * the system degrades, it never breaks (§2.3).
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import {
  createLayoutProvider,
  layoutChanged,
  layoutProviderHandle,
} from "@dispatch/layout-provider-contract";
import { manifest } from "./manifest.js";
import { DIAGNOSTIC_LAYOUT } from "./tree.js";

export { manifest };

/** The un-provide disposer captured when this plugin provides (the disposal contract). */
let disposeService: (() => void) | undefined;
/** The standby subscription — ledger-tracked, disposed in deactivate. */
let disposeStandby: (() => void) | undefined;

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

  const takeOver = (): void => {
    // Defensive: the unavailable callback runs after the slot frees, but a
    // race-loss must be a no-op, never a thrown error inside the bus's
    // error-isolated callback dispatch.
    if (host.tryGetService(layoutProviderHandle) !== undefined) return;
    disposeService = host.provideService(layoutProviderHandle, provider);
    host.logger.info("layout-diagnostic: diagnostic layout provider active");
  };

  if (host.tryGetService(layoutProviderHandle) === undefined) {
    // No layout provider yet — provide immediately.
    takeOver();
  } else {
    // Another layout provider is active (layout-chat at boot): stand by and
    // take over the moment it unloads.
    disposeStandby = host.onServiceUnavailable(layoutProviderHandle, takeOver);
    host.logger.info(
      "layout-diagnostic: another layout provider is active — standing by (unload it to activate the diagnostic layout)",
    );
  }
}

export const extension: Extension = {
  manifest,
  activate,
  deactivate() {
    // Disposal contract: EVERYTHING this plugin registered goes now — the
    // standby subscription FIRST (so the service disposal below cannot
    // re-enter a takeover), then the service un-provide. verify-plugin
    // asserts ZERO dangling registrations after this runs (subscriptions and
    // services ARE ledger-tracked).
    disposeStandby?.();
    disposeStandby = undefined;
    disposeService?.();
    disposeService = undefined;
  },
};
