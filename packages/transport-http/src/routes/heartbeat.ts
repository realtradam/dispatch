import { DEFAULT_HEARTBEAT_CONFIG } from "@dispatch/heartbeat";
import type {
  HeartbeatConfig,
  HeartbeatRunsResponse,
  StopHeartbeatRunResponse,
  UpdateHeartbeatRequest,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import { isValidReasoningEffort } from "../logic.js";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Heartbeat (per-workspace AI loop) ─────────────────────────────────────
  // The config + run history for a workspace's heartbeat loop. Delegated to
  // the HeartbeatService (provided by the `heartbeat` extension). When
  // heartbeat is NOT loaded the routes degrade: GET config → the defaults,
  // GET runs → empty, PUT/POST → 503 (mirrors how /system-prompt returns the
  // default template when its service is absent but 503s writes).

  app.get("/workspaces/:id/heartbeat", async (c) => {
    const workspaceId = c.req.param("id");
    if (opts.heartbeatService === undefined) {
      // Graceful: no heartbeat configured → return the defaults so the FE
      // always gets a usable config shape (enabled: false, etc.).
      const body: HeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG;
      return c.json(body, 200);
    }
    try {
      const config = await opts.heartbeatService.getConfig(workspaceId);
      log.info("heartbeat: config read", { workspaceId, enabled: config.enabled });
      const body: HeartbeatConfig = config;
      return c.json(body, 200);
    } catch (err) {
      log.error("heartbeat: config read failure", { err, workspaceId });
      return c.json({ error: "Failed to read heartbeat config" }, 500);
    }
  });

  app.put("/workspaces/:id/heartbeat", async (c) => {
    const workspaceId = c.req.param("id");
    if (opts.heartbeatService === undefined) {
      return c.json({ error: "Heartbeat service not available" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("heartbeat: invalid JSON body", { workspaceId });
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;

    // Build a partial update, validating each present field. All fields are
    // optional (a partial update); only provided fields are forwarded.
    const update: Record<string, unknown> = {};

    if (obj.enabled !== undefined) {
      if (typeof obj.enabled !== "boolean") {
        return c.json({ error: "Field 'enabled' must be a boolean" }, 400);
      }
      update.enabled = obj.enabled;
    }

    // inactiveOnly: when true (the default), the heartbeat skips a fire while
    // the configured workspace has active agents. A boolean; absent leaves it
    // unchanged.
    if (obj.inactiveOnly !== undefined) {
      if (typeof obj.inactiveOnly !== "boolean") {
        return c.json({ error: "Field 'inactiveOnly' must be a boolean" }, 400);
      }
      update.inactiveOnly = obj.inactiveOnly;
    }

    if (obj.systemPrompt !== undefined) {
      if (typeof obj.systemPrompt !== "string") {
        return c.json({ error: "Field 'systemPrompt' must be a string" }, 400);
      }
      update.systemPrompt = obj.systemPrompt;
    }

    if (obj.taskPrompt !== undefined) {
      if (typeof obj.taskPrompt !== "string") {
        return c.json({ error: "Field 'taskPrompt' must be a string" }, 400);
      }
      update.taskPrompt = obj.taskPrompt;
    }

    if (obj.intervalMinutes !== undefined) {
      if (typeof obj.intervalMinutes !== "number" || !Number.isFinite(obj.intervalMinutes)) {
        return c.json({ error: "Field 'intervalMinutes' must be a number" }, 400);
      }
      update.intervalMinutes = obj.intervalMinutes;
    }

    if (obj.model !== undefined) {
      if (typeof obj.model !== "string") {
        return c.json({ error: "Field 'model' must be a string" }, 400);
      }
      update.model = obj.model;
    }

    // `reasoningEffort` accepts a valid level string OR null (clear the
    // override → inherit the workspace default). Absent (undefined) leaves
    // it unchanged. An unrecognized string → 400.
    if (obj.reasoningEffort !== undefined) {
      if (obj.reasoningEffort !== null && !isValidReasoningEffort(obj.reasoningEffort)) {
        return c.json(
          {
            error: "Field 'reasoningEffort' must be one of: low, medium, high, xhigh, max, or null",
          },
          400,
        );
      }
      update.reasoningEffort = obj.reasoningEffort;
    }

    try {
      const config = await opts.heartbeatService.updateConfig(
        workspaceId,
        update as UpdateHeartbeatRequest,
      );
      log.info("heartbeat: config updated", {
        workspaceId,
        enabled: config.enabled,
        intervalMinutes: config.intervalMinutes,
      });
      const response: HeartbeatConfig = config;
      return c.json(response, 200);
    } catch (err) {
      log.error("heartbeat: config update failure", { err, workspaceId });
      return c.json({ error: "Failed to update heartbeat config" }, 500);
    }
  });

  app.get("/workspaces/:id/heartbeat/runs", async (c) => {
    const workspaceId = c.req.param("id");
    if (opts.heartbeatService === undefined) {
      // Graceful: no heartbeat → no runs.
      const body: HeartbeatRunsResponse = { runs: [] };
      return c.json(body, 200);
    }
    try {
      const runs = await opts.heartbeatService.listRuns(workspaceId);
      log.info("heartbeat: runs listed", { workspaceId, count: runs.length });
      const body: HeartbeatRunsResponse = { runs };
      return c.json(body, 200);
    } catch (err) {
      log.error("heartbeat: runs list failure", { err, workspaceId });
      return c.json({ error: "Failed to list heartbeat runs" }, 500);
    }
  });

  // The server-authoritative next-fire time for a workspace's heartbeat. A
  // lightweight read of the scheduler's pending fire time (polled by the FE
  // alongside the runs list). `nextRunAt` is null when the heartbeat is
  // disabled/disarmed, or when a run is in flight and the next hasn't been
  // queued yet — the FE then shows no countdown, not a fabricated one.
  app.get("/workspaces/:id/heartbeat/next-run", async (c) => {
    const workspaceId = c.req.param("id");
    if (opts.heartbeatService === undefined) {
      // Graceful: no heartbeat configured → no next run scheduled.
      return c.json({ nextRunAt: null }, 200);
    }
    try {
      const nextRunAt = await opts.heartbeatService.nextRunAt(workspaceId);
      log.info("heartbeat: next-run read", { workspaceId, nextRunAt });
      return c.json({ nextRunAt }, 200);
    } catch (err) {
      log.error("heartbeat: next-run read failure", { err, workspaceId });
      return c.json({ error: "Failed to read heartbeat next-run" }, 500);
    }
  });

  app.post("/workspaces/:id/heartbeat/runs/:runId/stop", async (c) => {
    const workspaceId = c.req.param("id");
    const runId = c.req.param("runId");
    if (opts.heartbeatService === undefined) {
      return c.json({ error: "Heartbeat service not available" }, 503);
    }
    try {
      const result = await opts.heartbeatService.stopRun(workspaceId, runId);
      log.info("heartbeat: run stopped", { workspaceId, runId });
      const body: StopHeartbeatRunResponse = result;
      return c.json(body, 200);
    } catch (err) {
      // stopRun throws "Heartbeat run not found" for an unknown run id.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return c.json({ error: "Heartbeat run not found" }, 404);
      }
      log.error("heartbeat: run stop failure", { err, workspaceId, runId });
      return c.json({ error: "Failed to stop heartbeat run" }, 500);
    }
  });
}
