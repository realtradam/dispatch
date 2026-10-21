import type {
  ConversationHistoryResponse,
  ConversationMetricsResponse,
  ConversationStatusResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import {
  isSinceSeqError,
  isWindowParamError,
  parseSinceSeq,
  parseWindowParam,
  projectHistoryChunks,
} from "../logic.js";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  app.get("/conversations/:id/metrics", async (c) => {
    const conversationId = c.req.param("id");

    try {
      const turns = await opts.conversationStore.loadMetrics(conversationId);
      log.info("conversations: metrics read", {
        conversationId,
        count: turns.length,
      });
      const body: ConversationMetricsResponse = { turns };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: metrics store failure", { err });
      return c.json({ error: "Failed to load conversation metrics" }, 500);
    }
  });

  app.get("/conversations/:id", async (c) => {
    const conversationId = c.req.param("id");
    const sinceSeqResult = parseSinceSeq(c.req.query("sinceSeq"));
    if (isSinceSeqError(sinceSeqResult)) {
      log.warn("conversations: invalid sinceSeq", {
        conversationId,
        error: sinceSeqResult.error,
      });
      return c.json({ error: sinceSeqResult.error }, 400);
    }

    // `limit` / `beforeSeq` are optional positive-integer history-window
    // params. The store is deliberately forgiving (a 0/negative bound is
    // treated as ABSENT), so we MUST reject malformed values here and never
    // forward an invalid window.
    const beforeSeqResult = parseWindowParam(c.req.query("beforeSeq"), "beforeSeq");
    if (isWindowParamError(beforeSeqResult)) {
      log.warn("conversations: invalid beforeSeq", {
        conversationId,
        error: beforeSeqResult.error,
      });
      return c.json({ error: beforeSeqResult.error }, 400);
    }
    const limitResult = parseWindowParam(c.req.query("limit"), "limit");
    if (isWindowParamError(limitResult)) {
      log.warn("conversations: invalid limit", {
        conversationId,
        error: limitResult.error,
      });
      return c.json({ error: limitResult.error }, 400);
    }

    // Include only the fields actually provided (exactOptionalPropertyTypes),
    // and omit the window argument entirely when neither was given — keeping
    // the pre-windowing call shape byte-identical for existing callers.
    const window: { readonly beforeSeq?: number; readonly limit?: number } | undefined =
      beforeSeqResult !== undefined || limitResult !== undefined
        ? {
            ...(beforeSeqResult !== undefined ? { beforeSeq: beforeSeqResult } : {}),
            ...(limitResult !== undefined ? { limit: limitResult } : {}),
          }
        : undefined;

    try {
      const { chunks, historyEpoch } = await opts.conversationStore.runExclusive(
        conversationId,
        async () => {
          const chunks =
            window !== undefined
              ? await opts.conversationStore.loadSince(conversationId, sinceSeqResult, window)
              : await opts.conversationStore.loadSince(conversationId, sinceSeqResult);
          const historyEpoch = await opts.conversationStore.getHistoryEpoch(conversationId);
          return { chunks, historyEpoch };
        },
      );
      const latestSeq =
        chunks.length > 0 ? (chunks[chunks.length - 1]?.seq ?? sinceSeqResult) : sinceSeqResult;
      log.info("conversations: read", {
        conversationId,
        sinceSeq: sinceSeqResult,
        count: chunks.length,
      });
      const body: ConversationHistoryResponse = {
        chunks: projectHistoryChunks(chunks),
        latestSeq,
        historyEpoch,
      };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: store failure", { err });
      return c.json({ error: "Failed to load conversation" }, 500);
    }
  });

  app.get("/conversations/:id/status", async (c) => {
    const conversationId = c.req.param("id");
    const isActive = opts.orchestrator.isActive(conversationId);
    const status = await opts.conversationStore.getConversationStatus(conversationId);
    if (status === null) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const body: ConversationStatusResponse = { conversationId, isActive, status };
    return c.json(body, 200);
  });
}
