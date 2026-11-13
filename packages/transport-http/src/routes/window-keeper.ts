import type { WindowKeeperConfigResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

/**
 * `/window-keeper` — the per-provider usage-window keeper toggles, delegated
 * to the `WindowKeeperService` (provided by the `window-keeper` extension).
 * When the extension is not loaded both routes degrade to 503, like the other
 * optional-service surfaces.
 */
export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;

  app.get("/window-keeper", async (c) => {
    if (opts.windowKeeperService === undefined) {
      return c.json({ error: "Window keeper service not available" }, 503);
    }
    try {
      const config = await opts.windowKeeperService.getConfig();
      log.info("window-keeper: read");
      const body: WindowKeeperConfigResponse = config;
      return c.json(body, 200);
    } catch (err) {
      log.error("window-keeper: read failure", { err });
      return c.json({ error: "Failed to read window keeper config" }, 500);
    }
  });

  app.put("/window-keeper", async (c) => {
    if (opts.windowKeeperService === undefined) {
      return c.json({ error: "Window keeper service not available" }, 503);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const provider =
      typeof raw === "object" && raw !== null && "provider" in raw
        ? (raw as { provider?: unknown }).provider
        : undefined;
    const enabled =
      typeof raw === "object" && raw !== null && "enabled" in raw
        ? (raw as { enabled?: unknown }).enabled
        : undefined;
    try {
      const result = await opts.windowKeeperService.setEnabled({ provider, enabled });
      if (!result.ok) {
        log.warn("window-keeper: update rejected", { reason: result.error });
        return c.json(
          { error: 'Invalid body: expected { provider: "claude" | "codex", enabled: boolean }' },
          400,
        );
      }
      log.info("window-keeper: updated", {
        provider: provider as string,
        enabled: enabled as boolean,
      });
      const body: WindowKeeperConfigResponse = result.config;
      return c.json(body, 200);
    } catch (err) {
      log.error("window-keeper: update failure", { err });
      return c.json({ error: "Failed to update window keeper config" }, 500);
    }
  });
}
