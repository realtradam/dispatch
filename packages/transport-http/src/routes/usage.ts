import type {
  AccountUsageProviderId,
  AccountUsageReport,
  AccountUsageResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Account usage (Claude / Codex / OpenCode subscription quotas) ──────────
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
    if (provider !== "claude" && provider !== "codex" && provider !== "opencode") {
      return c.json({ error: "provider must be one of: claude, codex, opencode" }, 404);
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
}
