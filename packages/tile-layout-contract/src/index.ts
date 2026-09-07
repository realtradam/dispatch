/**
 * `@dispatch/tile-layout-contract` — the PURE schema half of the home
 * tile-layout contract (the counterpart of `@dispatch/layout-contract` for
 * the workspace home grid): the `TileGeometryMode` (wide/tall — the two
 * synced device orientations), the `TileLayoutData` document both sides
 * exchange, and the strict write-time validation. Zero runtime deps — safe
 * for the web frontend to import.
 *
 * The BACKEND-ONLY half (the service handle, the change event hook, the
 * storage kit, the route handlers) lives in
 * `@dispatch/home-tile-layout-contract` — kept separate so this package
 * never pulls kernel types into a frontend graph.
 */

export {
  EMPTY_TILE_LAYOUT,
  isTileGeometryMode,
  TILE_GEOMETRY_MODES,
  type TileGeometryMode,
  type TileLayoutData,
  type TileLayoutEntry,
} from "./types";
export {
  isEmptyTileLayoutValid,
  type TileLayoutValidation,
  validateTileLayoutData,
} from "./validate";
