/**
 * home-tile-layout extension — the bundled STANDARD plugin that owns the
 * workspace home grid's synced layout documents. ONE shared document PER
 * device orientation (`wide` = landscape/desktop, `tall` = portrait/mobile),
 * persisted in this plugin's OWN storage namespace (the D-L4/D-L6 rule:
 * the plugin stores the persisted documents — there is no core layout store),
 * served through the well-known `/home/tile-layout/:mode` routes (transport-
 * http mounts them as thin shells over the reactive service slot), and
 * broadcast as `tile-layout` WS messages after every successful write
 * (transport-ws ferries the payload verbatim; clients filter by mode).
 *
 * Unlike the workspace layout providers there is NO per-workspace enablement:
 * the home grid is a global surface, so the service is always provided while
 * the plugin is loaded — the frontend's only degrade is a genuinely absent
 * backend (its edits stay ephemeral, no error UI).
 */

import {
  createHomeTileLayoutService,
  homeTileLayoutHandle,
  tileLayoutChanged,
} from "@dispatch/home-tile-layout-contract";
import type { Extension, HostAPI } from "@dispatch/kernel";
import { manifest } from "./manifest.js";

export { manifest };

/** The service registration disposer captured at activate (the disposal contract). */
let disposeRegistration: (() => void) | undefined;

export function activate(host: HostAPI): void {
  const service = createHomeTileLayoutService({
    // This plugin's OWN storage namespace (D-L4/D-L6: the plugin stores the
    // persisted documents — there is no core layout store).
    storage: host.storage("home-tile-layout"),
    // The outward change emitter — the kernel's event-hook bus: transport-ws
    // broadcasts the payload verbatim to every connected frontend.
    emitChange: (message) => host.emit(tileLayoutChanged, message),
    logger: host.logger,
  });

  disposeRegistration = host.provideService(homeTileLayoutHandle, service);
  host.logger.info("home-tile-layout: service ready (per-orientation documents)");
}

export const extension: Extension = {
  manifest,
  activate,
  deactivate() {
    // Disposal contract: the service registration is this plugin's own.
    disposeRegistration?.();
    disposeRegistration = undefined;
  },
};
