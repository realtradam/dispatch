/**
 * `@dispatch/home-tile-layout-contract` — the backend-only half of the home
 * tile-layout contract (the counterpart of `@dispatch/layout-provider-contract`
 * for the workspace home grid): the typed `homeTileLayoutHandle` service
 * binding, the `tileLayoutChanged` event hook (the WS broadcast path), the
 * `createHomeTileLayoutService` storage kit, and the well-known route
 * handlers transport-http mounts as thin shells.
 *
 * Touches kernel types (`ServiceHandle`, `StorageNamespace`, `Logger`) the
 * frontend must never depend on — the frontend consumes ONLY
 * `@dispatch/tile-layout-contract` (the pure schema) + the wire types.
 */

export { homeTileLayoutHandle, tileLayoutChanged } from "./handle";
export {
  createTileLayoutRouteHandlers,
  parseTileLayoutBody,
  type TileLayoutRouteHandlers,
  type TileLayoutRouteResult,
} from "./routes";
export {
  createHomeTileLayoutService,
  type HomeTileLayoutDeps,
  type HomeTileLayoutService,
  tileLayoutStorageKey,
} from "./service";
