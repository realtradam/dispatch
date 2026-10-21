import type {
  CloseConversationResponse,
  QueueCancelResponse,
  QueueResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import { isParseError, parseQueueBody } from "../logic.js";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  app.post("/conversations/:id/close", (c) => {
    const conversationId = c.req.param("id");
    const { abortedTurn } = opts.orchestrator.closeConversation(conversationId);
    log.info("conversations: closed", { conversationId, abortedTurn });
    const body: CloseConversationResponse = { conversationId, abortedTurn };
    return c.json(body, 200);
  });

  app.post("/conversations/:id/stop", (c) => {
    const conversationId = c.req.param("id");
    const { abortedTurn } = opts.orchestrator.stopTurn(conversationId);
    log.info("conversations: stop", { conversationId, abortedTurn });
    return c.json({ conversationId, abortedTurn }, 200);
  });

  app.post("/conversations/:id/queue", async (c) => {
    const conversationId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/queue: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseQueueBody(body);
    if (isParseError(parsed)) {
      log.warn("conversations/queue: validation failed", { reason: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }

    const result = await opts.orchestrator.enqueue({ conversationId, ...parsed }).catch(() => {
      log.warn("conversations/queue: image storage failed", { conversationId });
      return undefined;
    });
    if (result === undefined) return c.json({ error: "Failed to enqueue message" }, 500);
    const { startedTurn, queue } = result;
    log.info("conversations: enqueued", {
      conversationId,
      startedTurn,
      queueLength: queue.length,
    });
    const response: QueueResponse = { conversationId, startedTurn, queue };
    return c.json(response, 200);
  });

  app.delete("/conversations/:id/queue/:messageId", (c) => {
    const conversationId = c.req.param("id");
    const messageId = c.req.param("messageId");

    // `cancelQueuedMessage` is synchronous and owns the lookup + removal (no
    // separate race — the pure `cancel` is idempotent). It does not throw for an
    // unknown/idle conversation, which instead returns cancelled:false. Mirrors
    // the direct sync call used by `POST /conversations/:id/queue`.
    const { cancelled, queue } = opts.orchestrator.cancelQueuedMessage({
      conversationId,
      messageId,
    });
    log.info("conversations: cancelled queued message", {
      conversationId,
      messageId,
      cancelled,
      queueLength: queue.length,
    });
    const response: QueueCancelResponse = { conversationId, cancelled, queue };
    return c.json(response, 200);
  });
}
