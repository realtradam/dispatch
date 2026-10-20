import type {
  ComputerListResponse,
  ComputerResponse,
  ComputerStatusResponse,
  TestComputerResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Computers (discovery + live state) ───────────────────────────────────
  // Read-only discovery + connection state is delegated to the ComputerService
  // (provided by the `ssh` extension). When ssh is NOT loaded the routes
  // degrade: list → empty, status → "disconnected", test → not-configured.

  app.get("/computers", async (c) => {
    if (opts.computerService === undefined) {
      // Graceful: no ssh configured → no computers discovered.
      const body: ComputerListResponse = { computers: [] };
      return c.json(body, 200);
    }
    try {
      const computers = await opts.computerService.listComputers();
      log.info("computers: list", { count: computers.length });
      const body: ComputerListResponse = { computers };
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: list failure", { err });
      return c.json({ error: "Failed to list computers" }, 500);
    }
  });

  app.get("/computers/:alias", async (c) => {
    const alias = c.req.param("alias");
    if (opts.computerService === undefined) {
      // No ssh configured → no computer resolves this alias.
      return c.json({ error: "Computer not found" }, 404);
    }
    try {
      const computer = await opts.computerService.getComputer(alias);
      if (computer === null) {
        return c.json({ error: "Computer not found" }, 404);
      }
      const body: ComputerResponse = computer;
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: get failure", { err, alias });
      return c.json({ error: "Failed to read computer" }, 500);
    }
  });

  app.get("/computers/:alias/status", async (c) => {
    const alias = c.req.param("alias");
    if (opts.computerService === undefined) {
      const body: ComputerStatusResponse = { alias, state: "disconnected", knownHost: false };
      return c.json(body, 200);
    }
    try {
      const body = await opts.computerService.getStatus(alias);
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: status failure", { err, alias });
      return c.json({ error: "Failed to read computer status" }, 500);
    }
  });

  app.post("/computers/:alias/test", async (c) => {
    const alias = c.req.param("alias");
    if (opts.computerService === undefined) {
      const body: TestComputerResponse = { alias, ok: false, error: "SSH not configured" };
      return c.json(body, 200);
    }
    try {
      const body = await opts.computerService.test(alias);
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: test failure", { err, alias });
      return c.json({ error: "Failed to test computer" }, 500);
    }
  });
}
