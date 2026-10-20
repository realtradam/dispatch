import type { AgentEvent } from "@dispatch/kernel";
import type { WarmResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import {
  computeCachePct,
  computeExpectedCacheRate,
  isParseError,
  parseChatBody,
  parseWarmBody,
  serializeEventLine,
} from "../logic.js";
import type { RouteOptions } from "../route-options.js";
import type { SessionOrchestrator } from "../seam.js";
import { currentThroughputStore } from "./throughput.js";

/** Only small metric packets are retained by /chat; all events still stream verbatim. */
type ThroughputEvent = Extract<AgentEvent, { type: "usage" | "step-complete" | "done" }>;

export function retainThroughputEvent(events: ThroughputEvent[], event: AgentEvent): void {
  if (event.type === "usage" || event.type === "step-complete" || event.type === "done") {
    events.push(event);
  }
}

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log, generateId, now } = options;
  async function recordThroughput(
    turnEvents: readonly AgentEvent[],
    model: string | undefined,
  ): Promise<void> {
    if (model === undefined) return; // no model selected → nothing to attribute
    let genMs = 0;
    let outputTokens = 0;
    for (const e of turnEvents) {
      if (e.type === "step-complete" && e.genTotalMs !== undefined) genMs += e.genTotalMs;
      if (e.type === "done" && e.usage !== undefined) outputTokens = e.usage.outputTokens;
    }
    if (genMs <= 0) return; // no generation time → can't compute tok/s
    try {
      await currentThroughputStore(opts).record({ model, ts: now(), outputTokens, genMs });
      log.info("throughput: turn recorded", {
        model,
        outputTokens,
        genMs,
        tokensPerSecond: Math.round((outputTokens / (genMs / 1000)) * 100) / 100,
      });
    } catch (err) {
      log.warn("throughput: failed to record sample", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  app.post("/chat", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("chat: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = parseChatBody(body, generateId);
    if (isParseError(result)) {
      log.warn("chat: validation failed", { reason: result.error });
      return c.json({ error: result.error }, 400);
    }

    const {
      conversationId,
      message,
      model,
      cwd,
      computerId,
      reasoningEffort,
      workspaceId,
      images,
      title,
      namedAgent,
    } = result;
    log.info("chat: request accepted", {
      conversationId,
      hasModel: model !== undefined,
      hasCwd: cwd !== undefined,
      hasComputerId: computerId !== undefined,
      hasReasoningEffort: reasoningEffort !== undefined,
      hasWorkspaceId: workspaceId !== undefined,
      imageCount: images?.length ?? 0,
      hasNamedAgent: namedAgent !== undefined,
    });

    // Persist the Named Agent selection snapshot alongside the model when the
    // client started this conversation via the synthetic Named Agents provider
    // (additive). Fail-open: a snapshot write error must NOT fail the chat
    // turn — log and continue. The model itself is forwarded to the
    // orchestrator below and persisted by it.
    if (namedAgent !== undefined) {
      try {
        await opts.conversationStore.setNamedAgentSelection(conversationId, namedAgent);
      } catch (err) {
        log.warn("chat: failed to persist Named Agent selection snapshot", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const events: ThroughputEvent[] = [];
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamClosed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
    });

    function safeEnqueue(data: Uint8Array): void {
      if (streamClosed) return;
      try {
        controllerRef?.enqueue(data);
      } catch (err) {
        streamClosed = true;
        log.warn("chat: stream enqueue failed", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    function safeClose(): void {
      if (streamClosed) return;
      streamClosed = true;
      try {
        controllerRef?.close();
      } catch (err) {
        log.warn("chat: stream close failed", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const orchestratorInput: Parameters<SessionOrchestrator["handleMessage"]>[0] = {
      conversationId,
      text: message,
      onEvent: (event) => {
        retainThroughputEvent(events, event);
        safeEnqueue(new TextEncoder().encode(serializeEventLine(event)));
      },
      ...(model !== undefined ? { modelName: model } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(computerId !== undefined ? { computerId } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(title !== undefined ? { title } : {}),
    };

    opts.orchestrator
      .handleMessage(orchestratorInput)
      .then(async () => {
        safeClose();
        await recordThroughput(events, model);
      })
      .catch((err) => {
        log.error("chat: turn failed", { err });
        const errorEvent: AgentEvent = {
          type: "error",
          conversationId,
          turnId: "",
          message: err instanceof Error ? err.message : String(err),
        };
        safeEnqueue(new TextEncoder().encode(serializeEventLine(errorEvent)));
        safeClose();
      });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-Conversation-Id": conversationId,
        "Transfer-Encoding": "chunked",
      },
    });
  });

  app.post("/chat/warm", async (c) => {
    if (opts.warmService === undefined) {
      return c.json({ error: "Warm service not available" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("chat/warm: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseWarmBody(body);
    if ("error" in parsed) {
      log.warn("chat/warm: validation failed", { reason: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }

    const { conversationId, model, cwd } = parsed;
    log.info("chat/warm: request accepted", {
      conversationId,
      hasModel: model !== undefined,
      hasCwd: cwd !== undefined,
    });

    const warmOpts: { readonly cwd?: string; readonly modelName?: string } | undefined =
      model !== undefined || cwd !== undefined
        ? {
            ...(cwd !== undefined ? { cwd } : {}),
            ...(model !== undefined ? { modelName: model } : {}),
          }
        : undefined;

    const result = await opts.warmService.warm(conversationId, warmOpts);

    if ("error" in result) {
      log.warn("chat/warm: service returned error", { conversationId, error: result.error });
      return c.json({ error: result.error }, 409);
    }

    const response: WarmResponse = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      cachePct: computeCachePct(result.inputTokens, result.cacheReadTokens),
      expectedCacheRate: computeExpectedCacheRate(result.cacheReadTokens, result.cacheWriteTokens),
    };
    return c.json(response, 200);
  });
}
