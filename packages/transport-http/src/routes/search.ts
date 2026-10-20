import type { SearchBackendConfigResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Search backend selection (GLOBAL) ────────────────────────────────────
  // The `web_search` tool's search-mode engine selection, delegated to the
  // SearchConfigService (provided by the `tool-web-search` extension). When
  // the extension is NOT loaded the routes degrade like heartbeat: GET
  // returns the defaults (firecrawl selected, firecrawl-only availability),
  // PUT returns 503.
  app.get("/search/config", async (c) => {
    if (opts.searchConfigService === undefined) {
      // Graceful: no search-config service → the zero-migration defaults.
      return c.json(
        {
          backend: "firecrawl",
          available: [{ id: "firecrawl", label: "Firecrawl (self-hosted)", configured: true }],
        },
        200,
      );
    }
    try {
      const config = await opts.searchConfigService.getConfig();
      log.info("search-config: read", { backend: config.backend });
      const body: SearchBackendConfigResponse = config;
      return c.json(body, 200);
    } catch (err) {
      log.error("search-config: read failure", { err });
      return c.json({ error: "Failed to read search config" }, 500);
    }
  });

  app.put("/search/config", async (c) => {
    if (opts.searchConfigService === undefined) {
      return c.json({ error: "Search config service not available" }, 503);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      log.warn("search-config: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const backend =
      typeof raw === "object" && raw !== null && "backend" in raw
        ? (raw as { backend?: unknown }).backend
        : undefined;
    if (typeof backend !== "string" || backend.trim().length === 0) {
      return c.json({ error: "Invalid body: expected { backend: string }" }, 400);
    }
    try {
      const result = await opts.searchConfigService.updateConfig({ backend });
      if (!result.ok) {
        const message =
          result.error === "not-configured"
            ? `Search backend "${backend}" is not configured`
            : `Unknown search backend "${backend}"`;
        log.warn("search-config: update rejected", { backend, reason: result.error });
        return c.json({ error: message }, 400);
      }
      log.info("search-config: updated", { backend: result.config.backend });
      const body: SearchBackendConfigResponse = {
        backend: result.config.backend,
        available: opts.searchConfigService.availableBackends(),
      };
      return c.json(body, 200);
    } catch (err) {
      log.error("search-config: update failure", { err });
      return c.json({ error: "Failed to update search config" }, 500);
    }
  });
}
