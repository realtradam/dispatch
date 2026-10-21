import type {
  ConcurrencyCooldownResponse,
  ConcurrencyLimitResponse,
  ConcurrencyLimitsResponse,
  ConcurrencyStatusResponse,
  SetConcurrencyCooldownRequest,
  SetConcurrencyLimitRequest,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Provider concurrency limits ────────────────────────────────────────────

  app.get("/concurrency/limits", (c) => {
    if (opts.concurrencyService === undefined) {
      const body: ConcurrencyLimitsResponse = { limits: [] };
      return c.json(body, 200);
    }
    const limits = opts.concurrencyService.getLimits();
    const body: ConcurrencyLimitsResponse = { limits };
    return c.json(body, 200);
  });

  app.get("/concurrency/limits/:providerId", (c) => {
    const providerId = c.req.param("providerId");
    if (opts.concurrencyService === undefined) {
      return c.json({ error: "Concurrency service not available" }, 503);
    }
    const limit = opts.concurrencyService.getLimit(providerId);
    if (limit === undefined) {
      return c.json({ error: "No concurrency limit configured for this provider" }, 404);
    }
    const body: ConcurrencyLimitResponse = { providerId, limit };
    return c.json(body, 200);
  });

  app.put("/concurrency/limits/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (opts.concurrencyService === undefined) {
      return c.json({ error: "Concurrency service not available" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("concurrency: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = body as SetConcurrencyLimitRequest;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.limit !== "number" ||
      !Number.isInteger(parsed.limit) ||
      parsed.limit <= 0
    ) {
      return c.json({ error: "Body must be { limit: <positive integer> }" }, 400);
    }

    opts.concurrencyService.setLimit(providerId, parsed.limit);
    const responseBody: ConcurrencyLimitResponse = { providerId, limit: parsed.limit };
    return c.json(responseBody, 200);
  });

  app.delete("/concurrency/limits/:providerId", (c) => {
    const providerId = c.req.param("providerId");
    if (opts.concurrencyService === undefined) {
      return c.json({ error: "Concurrency service not available" }, 503);
    }
    const existing = opts.concurrencyService.getLimit(providerId);
    if (existing === undefined) {
      return c.json({ error: "No concurrency limit configured for this provider" }, 404);
    }
    opts.concurrencyService.removeLimit(providerId);
    return c.json({ ok: true, providerId }, 200);
  });

  app.get("/concurrency/cooldown/:providerId", (c) => {
    const providerId = c.req.param("providerId");
    if (opts.concurrencyService === undefined) {
      return c.json({ error: "Concurrency service not available" }, 503);
    }
    // A cooldown may be the default (when a limit is configured but no explicit
    // cooldown was set) or explicitly set. getCooldown returns undefined only
    // when the provider has NO state at all (no limit, no cooldown) — treat that
    // as "not configured".
    const cooldownMs = opts.concurrencyService.getCooldown(providerId);
    if (cooldownMs === undefined) {
      return c.json({ error: "No concurrency configuration for this provider" }, 404);
    }
    const body: ConcurrencyCooldownResponse = { providerId, cooldownMs };
    return c.json(body, 200);
  });

  app.put("/concurrency/cooldown/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (opts.concurrencyService === undefined) {
      return c.json({ error: "Concurrency service not available" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("concurrency: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = body as SetConcurrencyCooldownRequest;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.cooldownMs !== "number" ||
      !Number.isInteger(parsed.cooldownMs) ||
      parsed.cooldownMs < 0
    ) {
      return c.json({ error: "Body must be { cooldownMs: <non-negative integer> }" }, 400);
    }

    opts.concurrencyService.setCooldown(providerId, parsed.cooldownMs);
    const responseBody: ConcurrencyCooldownResponse = { providerId, cooldownMs: parsed.cooldownMs };
    return c.json(responseBody, 200);
  });

  app.get("/concurrency/status", (c) => {
    if (opts.concurrencyService === undefined) {
      const body: ConcurrencyStatusResponse = { providers: [] };
      return c.json(body, 200);
    }
    const statuses = opts.concurrencyService.getStatusAll();
    const body: ConcurrencyStatusResponse = { providers: statuses };
    return c.json(body, 200);
  });
}
