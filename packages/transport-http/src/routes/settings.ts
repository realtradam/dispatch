import { DEFAULT_TEMPLATE, getVariableCatalog } from "@dispatch/system-prompt";
import type {
  SetSystemPromptTemplateRequest,
  SystemPromptTemplateResponse,
  SystemPromptVariablesResponse,
  VisionSettingsResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── System prompt template ───────────────────────────────────────────────

  app.get("/system-prompt/variables", (c) => {
    // Static catalog — no service call needed. Always available.
    const variables = getVariableCatalog();
    const body: SystemPromptVariablesResponse = { variables };
    return c.json(body, 200);
  });

  app.get("/system-prompt", async (c) => {
    if (opts.systemPromptService === undefined) {
      // FE always gets something useful — the built-in default template.
      const body: SystemPromptTemplateResponse = { template: DEFAULT_TEMPLATE };
      return c.json(body, 200);
    }
    const template = await opts.systemPromptService.getTemplate();
    const body: SystemPromptTemplateResponse = { template };
    return c.json(body, 200);
  });

  app.put("/system-prompt", async (c) => {
    if (opts.systemPromptService === undefined) {
      return c.json({ error: "System prompt service not available" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("system-prompt: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    // `template` must be a string; empty string is valid ("no system prompt").
    if (typeof obj.template !== "string") {
      return c.json({ error: "Field 'template' is required and must be a string" }, 400);
    }

    const { template } = obj as unknown as SetSystemPromptTemplateRequest;
    await opts.systemPromptService.setTemplate(template);
    log.info("system-prompt: template set");
    const response: SystemPromptTemplateResponse = { template };
    return c.json(response, 200);
  });

  app.get("/settings/vision", async (c) => {
    const settings = await opts.conversationStore.getVisionSettings();
    const body: VisionSettingsResponse = settings;
    return c.json(body, 200);
  });

  app.put("/settings/vision", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const obj = body as { imageLimit?: unknown; compactionModel?: unknown };
    if (obj.imageLimit !== undefined) {
      if (
        typeof obj.imageLimit !== "number" ||
        !Number.isInteger(obj.imageLimit) ||
        obj.imageLimit < 0
      ) {
        return c.json({ error: "imageLimit must be a non-negative integer" }, 400);
      }
      await opts.conversationStore.setVisionImageLimit(obj.imageLimit);
      log.info("vision: image limit set", { imageLimit: obj.imageLimit });
    }
    if (obj.compactionModel !== undefined) {
      if (obj.compactionModel !== null && typeof obj.compactionModel !== "string") {
        return c.json({ error: "compactionModel must be a string or null" }, 400);
      }
      await opts.conversationStore.setVisionCompactionModel(obj.compactionModel);
      log.info("vision: compaction model set", { compactionModel: obj.compactionModel });
    }
    const settings = await opts.conversationStore.getVisionSettings();
    const response: VisionSettingsResponse = settings;
    return c.json(response, 200);
  });
}
