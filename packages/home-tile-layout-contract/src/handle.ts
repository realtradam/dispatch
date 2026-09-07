/**
 * The home tile-layout contract's PUBLIC typed symbols — the service binding
 * the `home-tile-layout` plugin provides (per-orientation document storage),
 * the change hook the transport broadcasts, the storage kit every
 * implementation composes, and the route handlers the transport mounts.
 *
 * Kept OUT of the providing plugin's own package so no consumer ever imports
 * a plugin (transports and plugins both import THIS package — the
 * layout-provider-contract pattern).
 *
 * Backend-only: touches kernel types (`ServiceHandle`) the frontend must
 * never depend on. The frontend consumes `@dispatch/tile-layout-contract`
 * (the pure schema) + the wire types.
 */

import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import type { TileLayoutChangedMessage } from "@dispatch/transport-contract";
import type { HomeTileLayoutService } from "./service";

/**
 * The typed service binding for the home tile-layout store. The bundled
 * `home-tile-layout` plugin provides ONE implementation (both orientations'
 * documents in its own storage namespace); transport-http resolves it
 * reactively and serves the `/home/tile-layout/:mode` routes through it.
 * There is no per-workspace enablement here — the home grid is a
 * global surface, so the service is always-on while the plugin is loaded.
 */
export const homeTileLayoutHandle: ServiceHandle<HomeTileLayoutService> =
  defineService<HomeTileLayoutService>("tile-layout/service");

/**
 * Fired after every successful home tile-layout write (PUT / DELETE) by the
 * service. The payload IS the wire message — transport-ws broadcasts it to
 * ALL connected frontends verbatim; clients filter by their active geometry
 * mode. Full document, no patch protocol (the layout feature's decision 7).
 */
export const tileLayoutChanged = defineEventHook<TileLayoutChangedMessage>(
  "tile-layout/tile-layout-changed",
);
