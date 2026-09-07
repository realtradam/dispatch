/**
 * STRICT structural validation for the home tile-layout document — the
 * backend's write-time gate (PUT /home/tile-layout/:mode). Deliberately the
 * STRICT counterpart of the frontend's lenient `sanitizeLayout` (which
 * coerces junk away for rendering): the server rejects malformed documents
 * with a 400 so a bad client can never poison the SHARED layout every device
 * then downloads.
 *
 * Pure: unknown value in, a typed verdict out.
 */

import { EMPTY_TILE_LAYOUT, type TileLayoutData, type TileLayoutEntry } from "./types.js";

/** Sanity ceiling for spans/orders — rejects junk while leaving the frontend free to clamp. */
const MAX_SPAN = 64;
const MAX_ORDER = 1_000_000_000;
const MAX_ANCHOR = 1_000_000;

export type TileLayoutValidation =
  | { readonly ok: true; readonly data: TileLayoutData }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite integer in `[min, max]`, or `undefined` when the check fails. */
function intIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }
  return value >= min && value <= max ? value : undefined;
}

/**
 * Validate an untyped value as a tile-layout document: `version` 2, a `tiles`
 * array of well-formed entries (non-empty unique ids, positive integer spans,
 * non-negative integer orders, paired optional anchors). Strict — no
 * coercion; the client sanitizes before it sends.
 */
export function validateTileLayoutData(value: unknown): TileLayoutValidation {
  if (!isRecord(value)) return { ok: false, error: "Layout must be a JSON object" };
  if (value.version !== 2) {
    return { ok: false, error: "Layout version must be 2" };
  }
  if (!Array.isArray(value.tiles)) return { ok: false, error: "Layout tiles must be an array" };
  const seen = new Set<string>();
  const tiles: TileLayoutEntry[] = [];
  for (const [index, raw] of value.tiles.entries()) {
    if (!isRecord(raw)) {
      return { ok: false, error: `tiles[${index}] must be an object` };
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      return { ok: false, error: `tiles[${index}].id must be a non-empty string` };
    }
    if (seen.has(id)) {
      return { ok: false, error: `tiles[${index}].id duplicates an earlier tile ("${id}")` };
    }
    seen.add(id);
    const colSpan = intIn(raw.colSpan, 1, MAX_SPAN);
    if (colSpan === undefined) {
      return { ok: false, error: `tiles[${index}].colSpan must be an integer in [1, ${MAX_SPAN}]` };
    }
    const rowSpan = intIn(raw.rowSpan, 1, MAX_SPAN);
    if (rowSpan === undefined) {
      return { ok: false, error: `tiles[${index}].rowSpan must be an integer in [1, ${MAX_SPAN}]` };
    }
    const order = intIn(raw.order, 0, MAX_ORDER);
    if (order === undefined) {
      return {
        ok: false,
        error: `tiles[${index}].order must be an integer in [0, ${MAX_ORDER}]`,
      };
    }
    // An anchor is meaningful only as a PAIR (the frontend's own sanitize
    // drops lone coordinates) — a lone coordinate is a malformed write.
    const hasCol = raw.col !== undefined;
    const hasRow = raw.row !== undefined;
    if (hasCol !== hasRow) {
      return { ok: false, error: `tiles[${index}] anchor must be a paired { col, row }` };
    }
    let anchor: { readonly col: number; readonly row: number } | undefined;
    if (hasCol) {
      const col = intIn(raw.col, 1, MAX_ANCHOR);
      const row = intIn(raw.row, 1, MAX_ANCHOR);
      if (col === undefined || row === undefined) {
        return { ok: false, error: `tiles[${index}] anchor coordinates must be positive integers` };
      }
      anchor = { col, row };
    }
    tiles.push({
      id,
      colSpan,
      rowSpan,
      order,
      ...(anchor === undefined ? {} : { col: anchor.col, row: anchor.row }),
    });
  }
  return { ok: true, data: { version: 2, tiles } };
}

/** The validation verdict for the fresh default (always valid; self-check). */
export function isEmptyTileLayoutValid(): TileLayoutValidation {
  return validateTileLayoutData(EMPTY_TILE_LAYOUT);
}
