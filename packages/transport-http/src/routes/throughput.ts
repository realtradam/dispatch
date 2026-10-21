import type { ThroughputResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";
import { ThroughputQueryError, type ThroughputStore } from "../seam.js";
import type { CreateServerOptions } from "../server-options.js";

const noopThroughputStore: ThroughputStore = {
  record: async () => {},
  aggregate: async (q) => ({ period: q.period, date: q.date, start: 0, end: 0, models: [] }),
};

/**
 * The CURRENT throughput store per use — never captured at app-creation
 * time. The extension passes `throughputStore` as a live getter over a
 * registry slot, so a throughput-store loaded/unloaded mid-session is picked
 * up on the next sample/report (absent → the no-op store records nothing and
 * aggregates empty).
 */
export function currentThroughputStore(opts: CreateServerOptions): ThroughputStore {
  return opts.throughputStore ?? noopThroughputStore;
}

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  app.get("/metrics/throughput", async (c) => {
    const period = c.req.query("period");
    const date = c.req.query("date");
    if (period !== "day" && period !== "week" && period !== "month") {
      return c.json({ error: "query param 'period' must be one of: day, week, month" }, 400);
    }
    if (date === undefined || date === "") {
      return c.json({ error: "query param 'date' is required" }, 400);
    }
    try {
      // Typed against the wire contract: if the store's report shape ever
      // drifts from ThroughputResponse, this assignment fails to compile.
      // Read per request: the current registry slot's store (or the no-op).
      const body: ThroughputResponse = await currentThroughputStore(opts).aggregate({
        period,
        date,
      });
      return c.json(body);
    } catch (err) {
      if (err instanceof ThroughputQueryError) {
        return c.json({ error: err.message }, 400);
      }
      log.error("throughput: aggregate failed", { err });
      return c.json({ error: "Failed to aggregate throughput" }, 502);
    }
  });
}
