import type {
  AccountUsageProviderId,
  AccountUsageReport,
  AccountUsageResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Account usage (Claude / Codex subscription quotas) ─────────────────────
  // Thin shells over the account-usage service, which owns caching (5 min TTL
  // ±25%), failure cooldowns, and in-flight dedup. `?refresh=1` asks for a
  // refresh but the service still enforces its cooldown / min interval, so a
  // client can never drive unrestricted provider requests.

  app.get("/usage", async (c) => {
    const svc = opts.accountUsageService;
    if (svc === undefined) return c.json({ error: "Account usage service not available" }, 503);
    const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    try {
      const body: AccountUsageResponse = await svc.getAll({ refresh });
      return c.json(body);
    } catch (err) {
      log.error("account-usage: getAll failed", { err });
      return c.json({ error: "Failed to load account usage" }, 500);
    }
  });

  app.get("/usage/:provider", async (c) => {
    const svc = opts.accountUsageService;
    if (svc === undefined) return c.json({ error: "Account usage service not available" }, 503);
    const provider = c.req.param("provider");
    if (provider !== "claude" && provider !== "codex" && provider !== "hyper") {
      return c.json({ error: "provider must be one of: claude, codex, hyper" }, 404);
    }
    const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    try {
      const body: AccountUsageReport = await svc.get(provider as AccountUsageProviderId, {
        refresh,
      });
      return c.json(body);
    } catch (err) {
      log.error("account-usage: get failed", { err, provider });
      return c.json({ error: "Failed to load account usage" }, 500);
    }
  });

  // Per-provider usage settings (today only `hyper`: daily allowance + manual
  // reset anchor — Hyper's API reports only the balance). Validation lives in
  // the service; this route maps its result to 200/400/404/503.
  app.put("/usage/:provider/settings", async (c) => {
    const svc = opts.accountUsageService;
    if (svc === undefined) return c.json({ error: "Account usage service not available" }, 503);
    const provider = c.req.param("provider");
    if (provider !== "claude" && provider !== "codex" && provider !== "hyper") {
      return c.json({ error: "provider must be one of: claude, codex, hyper" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    try {
      const result = await svc.updateSettings(provider as AccountUsageProviderId, body);
      if (!result.ok) return c.json({ error: result.error }, result.notFound ? 404 : 400);
      log.info("account-usage: settings updated", { provider });
      const response: AccountUsageReport = result.report;
      return c.json(response);
    } catch (err) {
      log.error("account-usage: settings update failed", { err, provider });
      return c.json({ error: "Failed to update account usage settings" }, 500);
    }
  });
}
