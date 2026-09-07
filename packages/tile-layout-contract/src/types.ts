/**
 * The home tile-layout document — the PURE schema (zero runtime deps, safe
 * for every consumer including the web frontend). This is the persisted +
 * wire shape of the Win8-Start-style home grid's arrangement, shared verbatim
 * by the backend's `home-tile-layout` plugin (storage + validation) and the
 * frontend's `features/workspaces` store (render + edit).
 *
 * Mirrors the frontend's `features/workspaces/logic/tile-layout.ts` types —
 * that file owns the GEOMETRY logic (packing, universal-frame anchors); this
 * package owns only the DATA contract both sides exchange.
 */

/**
 * The grid geometry mode: landscape/desktop ("wide" — 4 fixed rows, column-
 * wise flow) or portrait/mobile ("tall" — 2 fixed columns, row-wise flow).
 * One shared layout document exists PER mode: every landscape device syncs
 * the `wide` document, every portrait device the `tall` one.
 */
export type TileGeometryMode = "wide" | "tall";

/** Every `TileGeometryMode` value (the route parameter's domain). */
export const TILE_GEOMETRY_MODES: readonly TileGeometryMode[] = ["wide", "tall"];

/** True when `value` is one of the two geometry modes. */
export function isTileGeometryMode(value: unknown): value is TileGeometryMode {
  return value === "wide" || value === "tall";
}

/** One persisted tile: a workspace's cell in the flat start-screen grid. */
export interface TileLayoutEntry {
  /** The workspace id (the slug). */
  readonly id: string;
  /** Requested horizontal span (render-time clamping is the frontend's job). */
  readonly colSpan: number;
  /** Requested vertical span (render-time clamping is the frontend's job). */
  readonly rowSpan: number;
  /** Lower sorts earlier. Arrival order for unpinned flow + tie-breaks. */
  readonly order: number;
  /**
   * The pinned anchor cell (1-based) in the universal 4-row frame, or absent =
   * unpinned (the tile flows into the first free cells at render time).
   * Meaningful only as a PAIR — both coordinates present or neither.
   */
  readonly col?: number;
  readonly row?: number;
}

/** The persisted document (v2). */
export interface TileLayoutData {
  readonly version: 2;
  readonly tiles: readonly TileLayoutEntry[];
}

/** The fresh default: no arrangement — every tile flows in arrival order. */
export const EMPTY_TILE_LAYOUT: TileLayoutData = { version: 2, tiles: [] };
