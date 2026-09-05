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
 * Disabling/unloading this plugin removes layout persistence exactly like
 * layout-chat's unload does: the service is un-provided, the well-known
 * routes 404, and clients render their built-in default while edits become
 * ephemeral until a layout plugin is enabled — the system degrades, it never
 * breaks (§2.3).
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

/** The un-provide disposer captured at activate time (the disposal contract). */
let disposeService: (() => void) | undefined;

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

  // First-provider-wins (decision 8): the kernel's registry throws when the
  // handle is already taken, failing THIS activation into the manager's
  // disabled-with-reason grammar ("another layout provider is active").
  // With layout-chat bundled alongside, whoever activates first owns the
  // handle — enabling this one after disabling layout-chat is the expected
  // flow, and the loud failure is correct behavior, not a bug.
  disposeService = host.provideService(layoutProviderHandle, provider);

  host.logger.info("layout-diagnostic: diagnostic layout provider active");
}

export const extension: Extension = {
  manifest,
  activate,
  deactivate() {
    // Disposal contract: un-provide the service. verify-plugin asserts ZERO
    // dangling registrations after this runs (services ARE ledger-tracked,
    // unlike service-mediated registry writes).
    disposeService?.();
    disposeService = undefined;
  },
};
