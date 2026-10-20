import type {
  CreateNamedAgentRequest,
  DeleteNamedAgentResponse,
  NamedAgentResponse,
  NamedAgentsResponse,
  UpdateNamedAgentRequest,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import { mapCreateError, mapUpdateError } from "../logic.js";
import type { RouteOptions } from "../route-options.js";
import type { NamedAgentsService } from "../seam.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Named Agents (CRUD over the local registry) ───────────────────────────
  // The four routes delegate to `opts.namedAgentService` (a typed service, never
  // a raw store) provided by the `named-agents` extension. They read/write ONLY
  // the local registry — they NEVER call the provider catalog (plan §10.2, §14).
  // When the service is absent (extension not loaded) every route degrades to
  // 503. Service typed errors map to HTTP statuses: duplicate-name → 409,
  // invalid-name/invalid-model → 400, not-found → 404; anything else → 500.

  app.get("/named-agents", async (c) => {
    if (opts.namedAgentService === undefined) {
      return c.json({ error: "Named Agents service not available" }, 503);
    }
    try {
      const namedAgents = await opts.namedAgentService.list();
      log.info("named-agents: list", { count: namedAgents.length });
      const body: NamedAgentsResponse = { namedAgents };
      return c.json(body, 200);
    } catch (err) {
      log.error("named-agents: list failure", { err });
      return c.json({ error: "Failed to list Named Agents" }, 500);
    }
  });

  app.post("/named-agents", async (c) => {
    if (opts.namedAgentService === undefined) {
      return c.json({ error: "Named Agents service not available" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("named-agents: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    // Basic shape validation; semantic validation (non-empty name, canonical
    // model, uniqueness) is owned by the registry service and mapped below.
    if (typeof obj.name !== "string") {
      return c.json({ error: "Field 'name' is required and must be a string" }, 400);
    }
    if (typeof obj.model !== "string") {
      return c.json({ error: "Field 'model' is required and must be a string" }, 400);
    }
    const input = body as CreateNamedAgentRequest;

    let result: Awaited<ReturnType<NamedAgentsService["create"]>>;
    try {
      result = await opts.namedAgentService.create(input);
    } catch (err) {
      log.error("named-agents: create failure", { err });
      return c.json({ error: "Failed to create Named Agent" }, 500);
    }
    if (!result.ok) {
      const { status, message } = mapCreateError(result.error);
      log.warn("named-agents: create rejected", { error: result.error });
      return c.json({ error: message }, status);
    }
    const response: NamedAgentResponse = { namedAgent: result.agent };
    return c.json(response, 200);
  });

  app.put("/named-agents/:id", async (c) => {
    const id = c.req.param("id");
    if (opts.namedAgentService === undefined) {
      return c.json({ error: "Named Agents service not available" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("named-agents: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.name !== "string") {
      return c.json({ error: "Field 'name' is required and must be a string" }, 400);
    }
    if (typeof obj.model !== "string") {
      return c.json({ error: "Field 'model' is required and must be a string" }, 400);
    }
    const input = body as UpdateNamedAgentRequest;

    let result: Awaited<ReturnType<NamedAgentsService["update"]>>;
    try {
      result = await opts.namedAgentService.update(id, input);
    } catch (err) {
      log.error("named-agents: update failure", { err, id });
      return c.json({ error: "Failed to update Named Agent" }, 500);
    }
    if (!result.ok) {
      const { status, message } = mapUpdateError(result.error);
      log.warn("named-agents: update rejected", { id, error: result.error });
      return c.json({ error: message }, status);
    }
    const response: NamedAgentResponse = { namedAgent: result.agent };
    return c.json(response, 200);
  });

  app.delete("/named-agents/:id", async (c) => {
    const id = c.req.param("id");
    if (opts.namedAgentService === undefined) {
      return c.json({ error: "Named Agents service not available" }, 503);
    }
    let result: Awaited<ReturnType<NamedAgentsService["delete"]>>;
    try {
      result = await opts.namedAgentService.delete(id);
    } catch (err) {
      log.error("named-agents: delete failure", { err, id });
      return c.json({ error: "Failed to delete Named Agent" }, 500);
    }
    if (!result.ok) {
      log.warn("named-agents: delete rejected", { id, error: result.error });
      return c.json({ error: "Named Agent not found" }, 404);
    }
    const response: DeleteNamedAgentResponse = { id: result.id };
    return c.json(response, 200);
  });
}
