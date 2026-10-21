import type {
  CompactPercentResponse,
  CompactResponse,
  SetCompactPercentRequest,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Compaction ──────────────────────────────────────────────────────────

  app.post("/conversations/:id/compact", async (c) => {
    if (opts.compactionService === undefined) {
      return c.json({ error: "Compaction service not available" }, 503);
    }
    const conversationId = c.req.param("id");
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine — use defaults.
    }
    const obj = body as Record<string, unknown>;
    const keepLastN =
      typeof obj.keepLastN === "number" && Number.isFinite(obj.keepLastN) && obj.keepLastN > 0
        ? Math.floor(obj.keepLastN)
        : undefined;
    const modelName = typeof obj.modelName === "string" ? obj.modelName : undefined;

    log.info("conversations: compact request", { conversationId });

    const result = await opts.compactionService.compact(conversationId, {
      ...(keepLastN !== undefined ? { keepLastN } : {}),
      ...(modelName !== undefined ? { modelName } : {}),
    });

    if ("error" in result) {
      log.warn("conversations: compact returned error", {
        conversationId,
        error: result.error,
      });
      return c.json({ error: result.error }, 409);
    }

    const response: CompactResponse = {
      conversationId,
      newConversationId: result.newConversationId,
      messagesSummarized: result.messagesSummarized,
      messagesKept: result.messagesKept,
    };
    return c.json(response, 200);
  });

  app.get("/conversations/:id/compact-percent", async (c) => {
    const conversationId = c.req.param("id");
    const threshold = (await opts.conversationStore.getCompactPercent(conversationId)) ?? 0;
    const response: CompactPercentResponse = { conversationId, threshold };
    return c.json(response, 200);
  });

  app.put("/conversations/:id/compact-percent", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = body as SetCompactPercentRequest;
    if (
      typeof parsed.threshold !== "number" ||
      !Number.isFinite(parsed.threshold) ||
      parsed.threshold < 0
    ) {
      return c.json({ error: "threshold must be a non-negative number" }, 400);
    }
    const threshold = Math.floor(parsed.threshold);
    await opts.conversationStore.setCompactPercent(conversationId, threshold);
    log.info("conversations: compact-percent set", { conversationId, threshold });
    const response: CompactPercentResponse = { conversationId, threshold };
    return c.json(response, 200);
  });
}
