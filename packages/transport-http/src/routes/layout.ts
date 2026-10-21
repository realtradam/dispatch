import { createLayoutRouteHandlers } from "@dispatch/layout-provider-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Layout (plan 02 — the workspace-ACTIVE layout provider's well-known
  //      routes) ────
  // Owned by whichever layout plugin the WORKSPACE enables (D-L6: a plugin's
  // domain, not core's). The provider is consumed REACTIVELY (per-request
  // registry slot) and resolved PER WORKSPACE (`providerFor` — the
  // per-workspace enablement state picks the ONE enabled layout plugin);
  // the decision logic — absent→404, body validation, status mapping —
  // lives in the provider kit (`createLayoutRouteHandlers`), so these
  // handlers are thin shells. While a workspace has no enabled layout
  // plugin every route 404s for it (the frontend's no-provider signal); a
  // mid-session load or enablement change applies on the next request with
  // no restart.
  const layoutRoutes = createLayoutRouteHandlers({
    getProvider: async (workspaceId) => await opts.layoutProviderRegistry?.providerFor(workspaceId),
    logger: log,
  });

  app.get("/workspaces/:id/layout", async (c) => {
    const result = await layoutRoutes.get(c.req.param("id"));
    return c.json(result.body, result.status);
  });

  app.put("/workspaces/:id/layout", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const result = await layoutRoutes.put(c.req.param("id"), body);
    return c.json(result.body, result.status);
  });

  // POST /workspaces/:id/layout/ops (plan 04 §4.2) — the op vocabulary over
  // HTTP, the SAME kit applyOps the service exposes (one code path, two
  // doors). 404 while no provider is active (the FE ABI's no-provider
  // signal); 400 for a bad body/op (failedOp names the offending op); 200
  // `{ tree, applied }` on success.
  app.post("/workspaces/:id/layout/ops", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const result = await layoutRoutes.ops(c.req.param("id"), body);
    return c.json(result.body, result.status);
  });

  app.delete("/workspaces/:id/layout", async (c) => {
    const result = await layoutRoutes.delete(c.req.param("id"));
    return c.json(result.body, result.status);
  });
}
