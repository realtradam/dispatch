/**
 * layout-chat extension (plan 02 §2.3) — the default-layout provider plugin
 * (D-L3). Builds the provider via the kit with `DEFAULT_LAYOUT` (imported
 * from `@dispatch/layout-contract` — the single source of truth shared with
 * the frontend's fallback renderer), provides it under the typed
 * `layoutProviderHandle`, and keeps the un-provide disposer for deactivate.
 *
 * Disabling/unloading this plugin removes layout persistence: the service is
 * un-provided, the well-known routes 404, and clients render their built-in
 * default while edits become ephemeral until a layout plugin is enabled —
 * the system degrades, it never breaks (§2.3).
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import { DEFAULT_LAYOUT } from "@dispatch/layout-contract";
import {
  createLayoutProvider,
  layoutChanged,
  layoutProviderHandle,
} from "@dispatch/layout-provider-contract";
import { manifest } from "./manifest.js";

export { manifest };

/** The un-provide disposer captured at activate time (the disposal contract). */
let disposeService: (() => void) | undefined;

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

  // First-provider-wins (decision 8): the kernel's registry throws when the
  // handle is already taken, failing THIS activation into the manager's
  // disabled-with-reason grammar ("another layout provider is active").
  disposeService = host.provideService(layoutProviderHandle, provider);

  host.logger.info("layout-chat: layout provider active");
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
