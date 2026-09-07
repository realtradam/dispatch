/**
 * `createHomeTileLayoutService` — the storage kit (the layout-provider kit's
 * counterpart for the home grid). Every implementation composes it, so
 * persistence/coherence behavior is identical and tested once:
 *
 * - orientation-keyed persistence over an injected `StorageNamespace`
 *   (`doc:<mode>` → JSON) — ONE shared document per device orientation;
 * - seed-on-miss: a fresh orientation reads as the empty document, which the
 *   first read materializes (read-through, NOT a user write — no event);
 * - STRICT `validateTileLayoutData` on every write (the server rejects junk
 *   with 400 so a bad client can never poison the layout every device then
 *   downloads — the frontend's own sanitize is the lenient render path);
 * - outward `tile-layout` change events after every successful WRITE (PUT /
 *   DELETE) — full document, no patch protocol. Reads never emit.
 *
 * Deps are INJECTED (effects at the edges): the plugin wires `storage` from
 * `host.storage(<its namespace>)`, `emitChange` from the kernel's event-hook
 * bus (`(message) => host.emit(tileLayoutChanged, message)`), `logger` from
 * `host.logger`.
 */

import type { Logger, StorageNamespace } from "@dispatch/kernel";
import {
  EMPTY_TILE_LAYOUT,
  type TileGeometryMode,
  type TileLayoutData,
  validateTileLayoutData,
} from "@dispatch/tile-layout-contract";
import type { TileLayoutChangedMessage } from "@dispatch/transport-contract";

/** Storage-key shape — `doc:<mode>` holds that orientation's JSON document. */
export function tileLayoutStorageKey(mode: TileGeometryMode): string {
  return `doc:${mode}`;
}

export interface HomeTileLayoutService {
  /**
   * Read the orientation's document — ALWAYS a document (a fresh orientation
   * is seeded with the empty layout on first read; a corrupt record re-seeds
   * the same way). Never throws for "missing"; storage failures DO throw
   * (the route layer maps them to 500).
   */
  readonly get: (mode: TileGeometryMode) => Promise<TileLayoutData>;
  /**
   * Validate + persist a document; emits `tileLayoutChanged` EXACTLY once on
   * success. A validation failure persists nothing and returns the error.
   */
  readonly put: (
    mode: TileGeometryMode,
    data: TileLayoutData,
  ) => Promise<
    | { readonly ok: true; readonly data: TileLayoutData }
    | { readonly ok: false; readonly error: string }
  >;
  /** Drop the orientation's document and re-seed the empty one; emits once. */
  readonly delete: (mode: TileGeometryMode) => Promise<TileLayoutData>;
}

export interface HomeTileLayoutDeps {
  /** The plugin's OWN storage namespace (`host.storage("home-tile-layout")`). */
  readonly storage: StorageNamespace;
  /**
   * The outward change emitter — wired by the plugin from the kernel's
   * event-hook bus (`host.emit(tileLayoutChanged, message)`); transport-ws
   * broadcasts the payload verbatim. Called EXACTLY once per successful
   * write, never on reads (a read-triggered seed is not a user write —
   * emitting would broadcast on every fresh-orientation GET).
   */
  readonly emitChange: (message: TileLayoutChangedMessage) => void;
  readonly logger: Logger;
}

/** Minimal structural check that a parsed storage record is a v2 tile document. */
function isDocumentShape(value: unknown): value is TileLayoutData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { version?: unknown; tiles?: unknown };
  return record.version === 2 && Array.isArray(record.tiles);
}

/**
 * Build the `HomeTileLayoutService` implementation. Pure decision logic over
 * the injected edges — no ambient state beyond the plugin's own storage.
 */
export function createHomeTileLayoutService(deps: HomeTileLayoutDeps): HomeTileLayoutService {
  const { storage, emitChange, logger } = deps;

  /** Persist + emit the change event EXACTLY once per successful write. */
  async function persist(mode: TileGeometryMode, data: TileLayoutData): Promise<void> {
    await storage.set(tileLayoutStorageKey(mode), JSON.stringify(data));
    // The kernel's hook bus is error-isolated; the guard keeps "never throws
    // for bad luck" true even for a misbehaving injected emitter.
    try {
      emitChange({ type: "tile-layout", mode, data });
    } catch (err) {
      logger.error("home-tile-layout: change emitter threw (write persisted)", { err });
    }
  }

  /** Seed the empty document for a fresh/corrupt orientation (no event). */
  async function seed(mode: TileGeometryMode): Promise<TileLayoutData> {
    await storage.set(tileLayoutStorageKey(mode), JSON.stringify(EMPTY_TILE_LAYOUT));
    logger.debug("home-tile-layout: seeded orientation", { mode });
    return EMPTY_TILE_LAYOUT;
  }

  return {
    async get(mode: TileGeometryMode): Promise<TileLayoutData> {
      let raw: string | null;
      try {
        raw = await storage.get(tileLayoutStorageKey(mode));
      } catch (err) {
        logger.error("home-tile-layout: storage read failed", { err, mode });
        throw err;
      }
      if (raw === null) return await seed(mode);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isDocumentShape(parsed)) return parsed;
        logger.warn("home-tile-layout: corrupt stored document (bad shape) — re-seeding", { mode });
      } catch {
        logger.warn("home-tile-layout: corrupt stored document (bad JSON) — re-seeding", { mode });
      }
      return await seed(mode);
    },

    async put(mode, data) {
      // STRICT structural validation on EVERY write path (not just HTTP):
      // this document is the one every device of the orientation downloads.
      const validation = validateTileLayoutData(data);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      await persist(mode, validation.data);
      return { ok: true, data: validation.data };
    },

    async delete(mode) {
      await storage.delete(tileLayoutStorageKey(mode));
      // The next read re-seeds via read-through; the event carries the fresh
      // empty document so every connected client of the orientation resets
      // to it immediately.
      return await seedAndEmit(mode);
    },
  };

  /** delete's tail: seed the empty document AND announce it (a user write). */
  async function seedAndEmit(mode: TileGeometryMode): Promise<TileLayoutData> {
    const fresh = await seed(mode);
    try {
      emitChange({ type: "tile-layout", mode, data: fresh });
    } catch (err) {
      logger.error("home-tile-layout: change emitter threw (reset persisted)", { err });
    }
    return fresh;
  }
}
