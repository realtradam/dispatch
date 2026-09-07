/**
 * Well-known HTTP route handlers for the home tile-layout routes
 * (`GET/PUT/DELETE /home/tile-layout/:mode`) — the layout routes' thin-shell
 * pattern: ALL decision logic (mode validation, body parsing, absent-service
 * degradation, status mapping) lives HERE once; transport-http mounts them
 * as three-line shells over a per-request service lookup.
 *
 * Statuses: 200 with `{ layout }`; 400 for a bad mode or body; 503 while the
 * `home-tile-layout` service is absent (plugin unloaded — a degrade, not an
 * error: the frontend keeps rendering its local state with ephemeral edits);
 * 500 on storage failure. There is deliberately NO "missing document" 404 —
 * a fresh orientation reads as the seeded empty document, so any 404 the
 * frontend sees means "routes not served" (an old backend) and degrades the
 * same way.
 */

import type { Logger } from "@dispatch/kernel";
import {
  isTileGeometryMode,
  type TileLayoutData,
  validateTileLayoutData,
} from "@dispatch/tile-layout-contract";
import type { HomeTileLayoutService } from "./service";

/** One route outcome: an HTTP status + a JSON body — `{ layout }` or `{ error }`. */
export interface TileLayoutRouteResult {
  readonly status: 200 | 400 | 500 | 503;
  readonly body: { readonly layout: TileLayoutData } | { readonly error: string };
}

export interface TileLayoutRouteHandlers {
  /** GET /home/tile-layout/:mode — read (seeds a fresh orientation). */
  readonly get: (mode: string) => Promise<TileLayoutRouteResult>;
  /** PUT /home/tile-layout/:mode — body `{ layout }`; 200 `{ layout }` / 400 `{ error }`. */
  readonly put: (mode: string, body: unknown) => Promise<TileLayoutRouteResult>;
  /** DELETE /home/tile-layout/:mode — re-seed the empty document; returns it. */
  readonly delete: (mode: string) => Promise<TileLayoutRouteResult>;
}

const ABSENT_BODY = { error: "Home tile-layout service is not available" } as const;

/** Validate a PUT body's shape: `{ layout: TileLayoutData }` (strict, v2). */
export function parseTileLayoutBody(
  body: unknown,
):
  | { readonly ok: true; readonly data: TileLayoutData }
  | { readonly ok: false; readonly error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const validation = validateTileLayoutData((body as { layout?: unknown }).layout);
  if (!validation.ok) {
    return {
      ok: false,
      error: `Body must be { layout: <tile layout document> }: ${validation.error}`,
    };
  }
  return { ok: true, data: validation.data };
}

/**
 * Route handlers for the well-known home tile-layout routes, bound to a
 * per-request service lookup (the transport resolves the plugin's service
 * reactively). Every handler degrades to 503 while the service is absent.
 */
export function createTileLayoutRouteHandlers(deps: {
  readonly getService: () => Promise<HomeTileLayoutService | undefined>;
  readonly logger: Logger;
}): TileLayoutRouteHandlers {
  const { getService, logger } = deps;

  function withService(
    run: (service: HomeTileLayoutService) => Promise<TileLayoutRouteResult>,
  ): Promise<TileLayoutRouteResult> {
    return getService()
      .then((service) => {
        if (service === undefined) {
          return { status: 503 as const, body: ABSENT_BODY };
        }
        return run(service);
      })
      .catch((err) => {
        logger.error("home-tile-layout: route failure", { err });
        return { status: 500 as const, body: { error: "Home tile-layout storage failure" } };
      });
  }

  function modeOr400(mode: string): TileLayoutRouteResult | null {
    if (!isTileGeometryMode(mode)) {
      return {
        status: 400,
        body: { error: `mode must be one of ${'"wide" | "tall"'}` },
      };
    }
    return null;
  }

  return {
    get: (mode) => {
      const bad = modeOr400(mode);
      if (bad !== null) return Promise.resolve(bad);
      return withService(async (service) => ({
        status: 200 as const,
        body: { layout: await service.get(mode as "wide" | "tall") },
      }));
    },

    put: (mode, body) => {
      const bad = modeOr400(mode);
      if (bad !== null) return Promise.resolve(bad);
      const parsed = parseTileLayoutBody(body);
      if (!parsed.ok) {
        return Promise.resolve({ status: 400 as const, body: { error: parsed.error } });
      }
      return withService(async (service) => {
        const result = await service.put(mode as "wide" | "tall", parsed.data);
        return result.ok
          ? { status: 200 as const, body: { layout: result.data } }
          : { status: 400 as const, body: { error: result.error } };
      });
    },

    delete: (mode) => {
      const bad = modeOr400(mode);
      if (bad !== null) return Promise.resolve(bad);
      return withService(async (service) => ({
        status: 200 as const,
        body: { layout: await service.delete(mode as "wide" | "tall") },
      }));
    },
  };
}
