import type {
  SetWorkspacePluginStateRequest,
  WorkspacePluginProvidersStatusResponse,
  WorkspacePluginStateValue,
  WorkspacePluginsResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Per-workspace plugin enablement (plan 06 §6.6) ────────────────────────
  // The workspace modal's read+write contract for "is this plugin used HERE".
  // Delegated to the WorkspacePluginConfigService (provided by the CORE
  // `workspace-plugin-config` extension) — route handlers are thin shells
  // (parse → delegate → map to HTTP); the state-transition + validation
  // logic lives in the service. When the service is absent (somehow not
  // activated), every route degrades to 503. The GET's read-through
  // materialization (§6.1) is what lazily registers a workspace.

  app.get("/workspaces/:id/plugins", async (c) => {
    const workspaceId = c.req.param("id");
    if (opts.workspacePluginConfigService === undefined) {
      return c.json({ error: "Workspace plugin config service not available" }, 503);
    }
    try {
      const view = await opts.workspacePluginConfigService.view(workspaceId);
      log.info("workspaces: plugin states read", {
        workspaceId,
        plugins: view.plugins.length,
        enabledProviderCount: view.enabledProviderCount,
      });
      const body: WorkspacePluginsResponse = {
        workspaceId,
        plugins: view.plugins,
        enabledProviderCount: view.enabledProviderCount,
      };
      return c.json(body, 200);
    } catch (err) {
      log.error("workspaces: plugin states read failure", { err, workspaceId });
      return c.json({ error: "Failed to read workspace plugin states" }, 500);
    }
  });

  app.get("/workspaces/:id/plugins/providers-status", async (c) => {
    const workspaceId = c.req.param("id");
    if (opts.workspacePluginConfigService === undefined) {
      return c.json({ error: "Workspace plugin config service not available" }, 503);
    }
    try {
      const enabledProviderCount =
        await opts.workspacePluginConfigService.enabledProviderCount(workspaceId);
      const body: WorkspacePluginProvidersStatusResponse = { workspaceId, enabledProviderCount };
      return c.json(body, 200);
    } catch (err) {
      log.error("workspaces: providers-status failure", { err, workspaceId });
      return c.json({ error: "Failed to read workspace provider status" }, 500);
    }
  });

  app.put("/workspaces/:id/plugins/:pluginId", async (c) => {
    const workspaceId = c.req.param("id");
    const pluginId = c.req.param("pluginId");
    if (opts.workspacePluginConfigService === undefined) {
      return c.json({ error: "Workspace plugin config service not available" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("workspaces: plugin state invalid JSON body", { workspaceId, pluginId });
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const rawState = (body as Record<string, unknown>).state;
    if (rawState !== "enabled" && rawState !== "disabled" && rawState !== "unset") {
      return c.json({ error: "Field 'state' must be one of: enabled, disabled, unset" }, 400);
    }
    const request: SetWorkspacePluginStateRequest = { state: rawState };

    try {
      const result = await opts.workspacePluginConfigService.setState(
        workspaceId,
        pluginId,
        request.state,
      );
      if (!result.ok) {
        // Strict layering (§7): only the global plugin-manager loads code —
        // the per-workspace surface refuses unloaded (greyed) and core
        // (locked) plugins with 409.
        log.warn("workspaces: plugin state change refused", {
          workspaceId,
          pluginId,
          reason: result.reason,
        });
        const blocked = {
          workspaceId,
          pluginId,
          reason: result.reason,
          message:
            result.reason === "core-locked"
              ? "Core plugins cannot be changed per workspace"
              : "Plugin is not loaded — load it globally first",
        };
        return c.json(blocked, 409);
      }
      const stateValue: WorkspacePluginStateValue = result.state ?? "undefined";
      log.info("workspaces: plugin state set", { workspaceId, pluginId, state: stateValue });
      const response = { workspaceId, pluginId, state: stateValue };
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: plugin state set failure", { err, workspaceId, pluginId });
      return c.json({ error: "Failed to set workspace plugin state" }, 500);
    }
  });
}
