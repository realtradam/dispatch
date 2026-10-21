import { createTileLayoutRouteHandlers } from "@dispatch/home-tile-layout-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Home tile-layout (the workspace home grid's synced layouts) ────────────
  // Owned by the bundled standard `home-tile-layout` plugin (D-L6: a plugin's
  // domain, not core's). The service is consumed REACTIVELY (per-request
  // slot) and serves ONE shared document per device orientation (`mode`:
  // "wide" = landscape/desktop, "tall" = portrait/mobile — every landscape
  // device syncs `wide`, every portrait device `tall`); the decision logic —
  // mode validation, body parsing, absent→503, status mapping — lives in the
  // contract kit (`createTileLayoutRouteHandlers`), so these handlers are
  // thin shells. There is no per-workspace enablement and NO missing-document
  // 404: a fresh orientation reads as the seeded empty document.
  const tileLayoutRoutes = createTileLayoutRouteHandlers({
    getService: async () => opts.homeTileLayout,
    logger: log,
  });

  app.get("/home/tile-layout/:mode", async (c) => {
    const result = await tileLayoutRoutes.get(c.req.param("mode"));
    return c.json(result.body, result.status);
  });

  app.put("/home/tile-layout/:mode", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const result = await tileLayoutRoutes.put(c.req.param("mode"), body);
    return c.json(result.body, result.status);
  });

  app.delete("/home/tile-layout/:mode", async (c) => {
    const result = await tileLayoutRoutes.delete(c.req.param("mode"));
    return c.json(result.body, result.status);
  });
}
