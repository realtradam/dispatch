import { DEFAULT_HEARTBEAT_CONFIG } from "@dispatch/heartbeat";
import type { AgentEvent, HostAPI, Logger } from "@dispatch/kernel";
import { DEFAULT_TEMPLATE, getVariableCatalog } from "@dispatch/system-prompt";
import type {
  CloseConversationResponse,
  CompactPercentResponse,
  CompactResponse,
  ComputerListResponse,
  ComputerResponse,
  ComputerStatusResponse,
  ConcurrencyLimitResponse,
  ConcurrencyLimitsResponse,
  ConcurrencyStatusResponse,
  ConversationComputerResponse,
  ConversationHistoryResponse,
  ConversationListResponse,
  ConversationMetricsResponse,
  ConversationStatusResponse,
  CwdResponse,
  DeleteWorkspaceResponse,
  HeartbeatConfig,
  HeartbeatRunsResponse,
  LastMessageResponse,
  LspServerInfo,
  LspStatusResponse,
  McpServerInfo,
  McpStatusResponse,
  ModelResponse,
  ModelsResponse,
  OpenConversationResponse,
  QueueResponse,
  ReasoningEffortResponse,
  SetCompactPercentRequest,
  SetConcurrencyLimitRequest,
  SetConversationComputerRequest,
  SetSystemPromptTemplateRequest,
  SetWorkspaceDefaultComputerRequest,
  StopHeartbeatRunResponse,
  SystemPromptTemplateResponse,
  SystemPromptVariablesResponse,
  TestComputerResponse,
  ThroughputResponse,
  TitleResponse,
  UpdateHeartbeatRequest,
  WarmResponse,
  WorkspaceListResponse,
  WorkspaceResponse,
} from "@dispatch/transport-contract";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  computeCachePct,
  computeExpectedCacheRate,
  extractLastAssistantText,
  isModelParseError,
  isParseError,
  isReasoningEffortParseError,
  isSinceSeqError,
  isValidReasoningEffort,
  isWindowParamError,
  parseChatBody,
  parseModelBody,
  parseQueueBody,
  parseReasoningEffortBody,
  parseSinceSeq,
  parseStatusFilter,
  parseWarmBody,
  parseWindowParam,
  serializeEventLine,
} from "./logic.js";
import {
  type CompactionService,
  type ComputerService,
  type ConcurrencyService,
  type ConversationStore,
  type CredentialStore,
  conversationOpened,
  type HeartbeatService,
  isValidWorkspaceSlug,
  type LspServerStatus,
  type LspService,
  type McpServerStatus,
  type McpService,
  type SessionOrchestrator,
  type SystemPromptService,
  ThroughputQueryError,
  type ThroughputStore,
  type WarmService,
} from "./seam.js";

export interface CreateServerOptions {
  readonly conversationStore: ConversationStore;
  readonly orchestrator: SessionOrchestrator;
  readonly credentialStore: CredentialStore;
  readonly warmService?: WarmService;
  readonly compactionService?: CompactionService;
  readonly lspService?: LspService;
  readonly mcpService?: McpService;
  /** Optional — system prompt builder service (GET/PUT template). */
  readonly systemPromptService?: SystemPromptService;
  /**
   * Optional — per-workspace heartbeat loop service (provided by the
   * `heartbeat` extension). When absent (heartbeat not loaded), the
   * `/workspaces/:id/heartbeat*` routes degrade: GET returns defaults,
   * PUT/POST return 503.
   */
  readonly heartbeatService?: HeartbeatService;
  /**
   * Optional — computer discovery + live connection service (provided by the
   * `ssh` extension). When absent (ssh not loaded), the `/computers*` routes
   * degrade: list returns `[]`, status returns "disconnected", test returns
   * a not-configured result. The per-conversation / workspace-default computer
   * endpoints work regardless (they only touch the conversation store).
   */
  readonly computerService?: ComputerService;
  /** Optional — defaults to a no-op store (recording disabled, empty reports). */
  readonly throughputStore?: ThroughputStore;
  /**
   * Optional — provider concurrency limiter service (provided by the
   * `provider-concurrency` extension). When absent (extension not loaded),
   * the `/concurrency/*` routes degrade: limits returns empty, status returns
   * empty, PUT returns 503.
   */
  readonly concurrencyService?: ConcurrencyService;
  readonly logger?: Logger;
  readonly generateId?: () => string;
  /** Injectable clock for sample timestamps (default Date.now). */
  readonly now?: () => number;
  /**
   * Fire-and-forget event-bus emit (bound `host.emit`). Required by
   * `POST /conversations/:id/open` to signal the frontend. When absent,
   * that endpoint responds `500 { error: "not available" }`.
   */
  readonly emit?: HostAPI["emit"];
  /**
   * Directory containing built frontend static files. When set, unmatched GET
   * requests fall through to static file serving (SPA fallback to index.html).
   * When absent, no static serving (API-only — backward compatible).
   */
  readonly webDir?: string;
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  span() {
    return {
      id: "noop-span",
      log: noopLogger,
      setAttributes() {},
      addLink() {},
      child() {
        return this;
      },
      end() {},
    };
  },
};

const noopThroughputStore: ThroughputStore = {
  record: async () => {},
  aggregate: async (q) => ({ period: q.period, date: q.date, start: 0, end: 0, models: [] }),
};

export function createApp(opts: CreateServerOptions): Hono {
  const app = new Hono();
  const log = opts.logger ?? noopLogger;
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => Date.now());
  const throughputStore = opts.throughputStore ?? noopThroughputStore;

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
      await throughputStore.record({ model, ts: now(), outputTokens, genMs });
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

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

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
      const chunks =
        window !== undefined
          ? await opts.conversationStore.loadSince(conversationId, sinceSeqResult, window)
          : await opts.conversationStore.loadSince(conversationId, sinceSeqResult);
      const latestSeq =
        chunks.length > 0 ? (chunks[chunks.length - 1]?.seq ?? sinceSeqResult) : sinceSeqResult;
      log.info("conversations: read", {
        conversationId,
        sinceSeq: sinceSeqResult,
        count: chunks.length,
      });
      const body: ConversationHistoryResponse = { chunks, latestSeq };
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

  app.get("/models", async (c) => {
    try {
      const models = await opts.credentialStore.listCatalog();
      const modelInfo: Record<string, { contextWindow?: number }> = {};
      for (const modelName of models) {
        const info = await opts.credentialStore.getModelInfo(modelName);
        if (info?.contextWindow !== undefined) {
          modelInfo[modelName] = { contextWindow: info.contextWindow };
        }
      }
      const body: ModelsResponse = {
        models,
        ...(Object.keys(modelInfo).length > 0 ? { modelInfo } : {}),
      };
      return c.json(body, 200);
    } catch (err) {
      log.error("models: failed to retrieve catalog", { err });
      return c.json({ error: "Failed to retrieve model catalog" }, 502);
    }
  });

  // ─── Computers (discovery + live state) ───────────────────────────────────
  // Read-only discovery + connection state is delegated to the ComputerService
  // (provided by the `ssh` extension). When ssh is NOT loaded the routes
  // degrade: list → empty, status → "disconnected", test → not-configured.

  app.get("/computers", async (c) => {
    if (opts.computerService === undefined) {
      // Graceful: no ssh configured → no computers discovered.
      const body: ComputerListResponse = { computers: [] };
      return c.json(body, 200);
    }
    try {
      const computers = await opts.computerService.listComputers();
      log.info("computers: list", { count: computers.length });
      const body: ComputerListResponse = { computers };
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: list failure", { err });
      return c.json({ error: "Failed to list computers" }, 500);
    }
  });

  app.get("/computers/:alias", async (c) => {
    const alias = c.req.param("alias");
    if (opts.computerService === undefined) {
      // No ssh configured → no computer resolves this alias.
      return c.json({ error: "Computer not found" }, 404);
    }
    try {
      const computer = await opts.computerService.getComputer(alias);
      if (computer === null) {
        return c.json({ error: "Computer not found" }, 404);
      }
      const body: ComputerResponse = computer;
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: get failure", { err, alias });
      return c.json({ error: "Failed to read computer" }, 500);
    }
  });

  app.get("/computers/:alias/status", async (c) => {
    const alias = c.req.param("alias");
    if (opts.computerService === undefined) {
      const body: ComputerStatusResponse = { alias, state: "disconnected", knownHost: false };
      return c.json(body, 200);
    }
    try {
      const body = await opts.computerService.getStatus(alias);
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: status failure", { err, alias });
      return c.json({ error: "Failed to read computer status" }, 500);
    }
  });

  app.post("/computers/:alias/test", async (c) => {
    const alias = c.req.param("alias");
    if (opts.computerService === undefined) {
      const body: TestComputerResponse = { alias, ok: false, error: "SSH not configured" };
      return c.json(body, 200);
    }
    try {
      const body = await opts.computerService.test(alias);
      return c.json(body, 200);
    } catch (err) {
      log.error("computers: test failure", { err, alias });
      return c.json({ error: "Failed to test computer" }, 500);
    }
  });

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

    const { conversationId, message, model, cwd, computerId, reasoningEffort, workspaceId } =
      result;
    log.info("chat: request accepted", {
      conversationId,
      hasModel: model !== undefined,
      hasCwd: cwd !== undefined,
      hasComputerId: computerId !== undefined,
      hasReasoningEffort: reasoningEffort !== undefined,
      hasWorkspaceId: workspaceId !== undefined,
    });

    const events: AgentEvent[] = [];
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
        events.push(event);
        safeEnqueue(new TextEncoder().encode(serializeEventLine(event)));
      },
      ...(model !== undefined ? { modelName: model } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(computerId !== undefined ? { computerId } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
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
      const body: ThroughputResponse = await throughputStore.aggregate({ period, date });
      return c.json(body);
    } catch (err) {
      if (err instanceof ThroughputQueryError) {
        return c.json({ error: err.message }, 400);
      }
      log.error("throughput: aggregate failed", { err });
      return c.json({ error: "Failed to aggregate throughput" }, 502);
    }
  });

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

  app.get("/concurrency/status", (c) => {
    if (opts.concurrencyService === undefined) {
      const body: ConcurrencyStatusResponse = { providers: [] };
      return c.json(body, 200);
    }
    const statuses = opts.concurrencyService.getStatusAll();
    const body: ConcurrencyStatusResponse = { providers: statuses };
    return c.json(body, 200);
  });

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

    // `enqueue` is synchronous and owns the idle→startTurn vs active→queue
    // decision (no separate `isActive` race) — it does not throw for an
    // unknown/idle conversation, which instead starts a turn. Mirrors the
    // direct sync call used by `POST /conversations/:id/close`.
    const { startedTurn, queue } = opts.orchestrator.enqueue({
      conversationId,
      text: parsed.text,
      ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}),
    });
    log.info("conversations: enqueued", {
      conversationId,
      startedTurn,
      queueLength: queue.length,
    });
    const response: QueueResponse = { conversationId, startedTurn, queue };
    return c.json(response, 200);
  });

  app.get("/conversations/:id/cwd", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const cwd = await opts.conversationStore.getCwd(conversationId);
      log.info("conversations: cwd read", { conversationId, hasCwd: cwd !== null });
      const body: CwdResponse = { conversationId, cwd };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: cwd read failure", { err });
      return c.json({ error: "Failed to read conversation cwd" }, 500);
    }
  });

  app.put("/conversations/:id/cwd", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/cwd: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.cwd !== "string" || obj.cwd.length === 0) {
      return c.json({ error: "Field 'cwd' is required and must be a non-empty string" }, 400);
    }

    // When a workspaceId is provided, assign the conversation to that
    // workspace BEFORE persisting the cwd — so a subsequent
    // GET /conversations/:id/lsp resolves a relative cwd against the
    // workspace's defaultCwd (not the server default). Omit for unchanged
    // workspace assignment (backward compatible).
    if (obj.workspaceId !== undefined) {
      if (typeof obj.workspaceId !== "string" || !isValidWorkspaceSlug(obj.workspaceId)) {
        return c.json({ error: "Invalid workspaceId" }, 400);
      }
    }

    try {
      if (typeof obj.workspaceId === "string") {
        await opts.conversationStore.ensureWorkspace(obj.workspaceId);
        await opts.conversationStore.setWorkspaceId(conversationId, obj.workspaceId);
      }
      await opts.conversationStore.setCwd(conversationId, obj.cwd);
      log.info("conversations: cwd set", { conversationId });
      const response: CwdResponse = { conversationId, cwd: obj.cwd };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: cwd set failure", { err });
      return c.json({ error: "Failed to set conversation cwd" }, 500);
    }
  });

  app.delete("/conversations/:id/cwd", async (c) => {
    const conversationId = c.req.param("id");
    try {
      await opts.conversationStore.clearCwd(conversationId);
      log.info("conversations: cwd cleared", { conversationId });
      const response: CwdResponse = { conversationId, cwd: null };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: cwd clear failure", { err });
      return c.json({ error: "Failed to clear conversation cwd" }, 500);
    }
  });

  // ─── Per-conversation computer (mirrors /conversations/:id/cwd) ──────────

  app.get("/conversations/:id/computer", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const computerId = await opts.conversationStore.getComputerId(conversationId);
      log.info("conversations: computer read", {
        conversationId,
        hasComputerId: computerId !== null,
      });
      const body: ConversationComputerResponse = { conversationId, computerId };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: computer read failure", { err });
      return c.json({ error: "Failed to read conversation computer" }, 500);
    }
  });

  app.put("/conversations/:id/computer", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/computer: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    // `computerId` must be a string (the SSH alias) or null (clear → inherit
    // the workspace defaultComputerId → local). An empty string is rejected
    // (unlike cwd, an alias is never "empty"); null is the explicit clear.
    if (
      obj.computerId !== null &&
      (typeof obj.computerId !== "string" || obj.computerId.length === 0)
    ) {
      return c.json(
        { error: "Field 'computerId' is required and must be a non-empty string or null" },
        400,
      );
    }
    const { computerId } = obj as unknown as SetConversationComputerRequest;

    // Mirror PUT /conversations/:id/cwd: when a workspaceId is provided,
    // assign the conversation to that workspace BEFORE persisting the
    // computer, so a subsequent effective-computer resolution reads the
    // workspace's defaultComputerId. Omit for unchanged workspace assignment.
    if (obj.workspaceId !== undefined) {
      if (typeof obj.workspaceId !== "string" || !isValidWorkspaceSlug(obj.workspaceId)) {
        return c.json({ error: "Invalid workspaceId" }, 400);
      }
    }

    try {
      if (typeof obj.workspaceId === "string") {
        await opts.conversationStore.ensureWorkspace(obj.workspaceId);
        await opts.conversationStore.setWorkspaceId(conversationId, obj.workspaceId);
      }
      // null → clear (inherit/local); string → persist the alias.
      await opts.conversationStore.setComputerId(conversationId, computerId);
      log.info("conversations: computer set", { conversationId });
      const response: ConversationComputerResponse = { conversationId, computerId };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: computer set failure", { err });
      return c.json({ error: "Failed to set conversation computer" }, 500);
    }
  });

  app.delete("/conversations/:id/computer", async (c) => {
    const conversationId = c.req.param("id");
    try {
      await opts.conversationStore.clearComputerId(conversationId);
      log.info("conversations: computer cleared", { conversationId });
      const response: ConversationComputerResponse = { conversationId, computerId: null };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: computer clear failure", { err });
      return c.json({ error: "Failed to clear conversation computer" }, 500);
    }
  });

  app.get("/conversations/:id/reasoning-effort", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const reasoningEffort = await opts.conversationStore.getReasoningEffort(conversationId);
      log.info("conversations: reasoning-effort read", {
        conversationId,
        hasEffort: reasoningEffort !== null,
      });
      const body: ReasoningEffortResponse = { conversationId, reasoningEffort };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: reasoning-effort read failure", { err });
      return c.json({ error: "Failed to read conversation reasoning effort" }, 500);
    }
  });

  app.put("/conversations/:id/reasoning-effort", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/reasoning-effort: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseReasoningEffortBody(body);
    if (isReasoningEffortParseError(parsed)) {
      log.warn("conversations/reasoning-effort: validation failed", { reason: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }

    try {
      await opts.conversationStore.setReasoningEffort(conversationId, parsed);
      log.info("conversations: reasoning-effort set", { conversationId });
      const response: ReasoningEffortResponse = { conversationId, reasoningEffort: parsed };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: reasoning-effort set failure", { err });
      return c.json({ error: "Failed to set conversation reasoning effort" }, 500);
    }
  });

  app.get("/conversations/:id/model", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const model = await opts.conversationStore.getModel(conversationId);
      log.info("conversations: model read", {
        conversationId,
        hasModel: model !== null,
      });
      const body: ModelResponse = { conversationId, model };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: model read failure", { err });
      return c.json({ error: "Failed to read conversation model" }, 500);
    }
  });

  app.put("/conversations/:id/model", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/model: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseModelBody(body);
    if (isModelParseError(parsed)) {
      log.warn("conversations/model: validation failed", { reason: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }

    // A non-null non-empty model persists the selection; `null` or an empty
    // string clears the key (the store treats an empty string as "delete").
    // The response carries the resulting value: the model name, or null when
    // cleared (mirroring how `getModel` returns null after a clear).
    const resultModel = parsed !== null && parsed.length > 0 ? parsed : null;
    const persistedValue = resultModel !== null ? resultModel : "";

    try {
      await opts.conversationStore.setModel(conversationId, persistedValue);
      log.debug("conversations: model set", { conversationId, model: resultModel });
      const response: ModelResponse = { conversationId, model: resultModel };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: model set failure", { err });
      return c.json({ error: "Failed to set conversation model" }, 500);
    }
  });

  app.get("/conversations/:id/lsp", async (c) => {
    const conversationId = c.req.param("id");
    try {
      // Gate on the PERSISTED cwd first: when no cwd has been set for the
      // conversation, the LSP does NOT connect (return null + empty servers)
      // rather than falling through to the server default (process.cwd()).
      const persistedCwd = await opts.conversationStore.getCwd(conversationId);
      if (persistedCwd === null) {
        log.info("conversations: lsp status read (no cwd)", { conversationId });
        const body: LspStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      // A persisted cwd exists → resolve the EFFECTIVE cwd (relative cwd
      // resolved against the workspace defaultCwd; absolute → as-is).
      const effectiveCwd = await opts.conversationStore.getEffectiveCwd(conversationId);
      if (effectiveCwd === null) {
        // Edge case: persisted cwd exists but resolution returned null.
        log.info("conversations: lsp status read (no effective cwd)", { conversationId });
        const body: LspStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      if (opts.lspService === undefined) {
        log.warn("conversations: lsp service not available", { conversationId });
        return c.json({ error: "LSP service not available" }, 503);
      }

      const statuses = await opts.lspService.status(effectiveCwd);
      const servers: LspServerInfo[] = statuses.map((s: LspServerStatus) => {
        const info: LspServerInfo = {
          id: s.id,
          name: s.name,
          root: s.root,
          extensions: s.extensions,
          state: s.state,
          ...(s.error !== undefined ? { error: s.error } : {}),
          ...(s.configSource !== undefined ? { configSource: s.configSource } : {}),
        };
        return info;
      });
      log.info("conversations: lsp status read", {
        conversationId,
        cwd: effectiveCwd,
        serverCount: servers.length,
      });
      const body: LspStatusResponse = { conversationId, cwd: effectiveCwd, servers };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: lsp status failure", { err });
      return c.json({ error: "Failed to read LSP status" }, 500);
    }
  });

  // Mirrors GET /conversations/:id/lsp: gate on persisted then effective cwd,
  // 503 when no MCP service, map McpServerStatus → McpServerInfo.
  app.get("/conversations/:id/mcp", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const persistedCwd = await opts.conversationStore.getCwd(conversationId);
      if (persistedCwd === null) {
        log.info("conversations: mcp status read (no cwd)", { conversationId });
        const body: McpStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      const effectiveCwd = await opts.conversationStore.getEffectiveCwd(conversationId);
      if (effectiveCwd === null) {
        log.info("conversations: mcp status read (no effective cwd)", { conversationId });
        const body: McpStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      if (opts.mcpService === undefined) {
        log.warn("conversations: mcp service not available", { conversationId });
        return c.json({ error: "MCP service not available" }, 503);
      }

      const statuses = await opts.mcpService.status(effectiveCwd);
      const servers: McpServerInfo[] = statuses.map((s: McpServerStatus) => {
        const info: McpServerInfo = {
          id: s.id,
          state: s.state,
          toolCount: s.toolCount,
          ...(s.error !== undefined ? { error: s.error } : {}),
        };
        return info;
      });
      log.info("conversations: mcp status read", {
        conversationId,
        cwd: effectiveCwd,
        serverCount: servers.length,
      });
      const body: McpStatusResponse = { conversationId, cwd: effectiveCwd, servers };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: mcp status failure", { err });
      return c.json({ error: "Failed to read MCP status" }, 500);
    }
  });

  app.get("/conversations", async (c) => {
    try {
      // Optional `?status=` comma-separated filter (e.g. "active,idle").
      // Default: all statuses. Invalid values are silently ignored.
      const rawStatus = c.req.query("status");
      const statusFilter = parseStatusFilter(rawStatus);
      // Optional `?workspaceId=` filter. A missing/empty/whitespace-only
      // value is ignored → return all workspaces. Composable with `?status=`
      // and `?q=`.
      const rawWorkspaceId = c.req.query("workspaceId");
      const workspaceId =
        rawWorkspaceId !== undefined && rawWorkspaceId.trim().length > 0
          ? rawWorkspaceId.trim()
          : undefined;
      const filter: Parameters<ConversationStore["listConversations"]>[0] =
        statusFilter !== undefined || workspaceId !== undefined
          ? {
              ...(statusFilter !== undefined ? { status: statusFilter } : {}),
              ...(workspaceId !== undefined ? { workspaceId } : {}),
            }
          : undefined;
      const all = await opts.conversationStore.listConversations(filter);
      // Optional `?q=` filters by id prefix (short-id resolution). A
      // missing/empty/whitespace-only `q` is ignored → return all.
      const rawQ = c.req.query("q");
      const q = rawQ?.trim() ?? "";
      const conversations = q.length > 0 ? all.filter((m) => m.id.startsWith(q)) : all;
      log.info("conversations: list", {
        count: conversations.length,
        ...(q.length > 0 ? { q } : {}),
        ...(statusFilter !== undefined ? { status: statusFilter.join(",") } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      const body: ConversationListResponse = { conversations };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: list failure", { err });
      return c.json({ error: "Failed to list conversations" }, 500);
    }
  });

  app.get("/conversations/:id/last", async (c) => {
    const conversationId = c.req.param("id");

    // Subscribe BEFORE checking isActive — closes the race where a seal
    // fires between the check and the subscribe (we'd miss it). If idle,
    // unsubscribe immediately; if active, wait for a `turn-sealed` event
    // (or a 60s timeout, then proceed regardless of what's available).
    let turnId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        unsubscribe = opts.orchestrator.subscribe(conversationId, (event) => {
          if (event.type === "turn-sealed") {
            turnId = event.turnId;
            finish();
          }
        });
        if (!opts.orchestrator.isActive(conversationId)) {
          finish();
          return;
        }
        // A seal may have fired synchronously during subscribe (the
        // real orchestrator never does this, but a fake might) — don't
        // arm a 60s timer for an already-settled promise.
        if (settled) return;
        timer = setTimeout(finish, 60_000);
      });
    } finally {
      unsubscribe?.();
    }

    let content = "";
    try {
      const messages = await opts.conversationStore.load(conversationId);
      content = extractLastAssistantText(messages);
    } catch (err) {
      log.error("conversations: last message load failure", { err });
      return c.json({ error: "Failed to load conversation" }, 500);
    }

    log.info("conversations: last read", {
      conversationId,
      hasContent: content.length > 0,
    });
    const body: LastMessageResponse = {
      conversationId,
      content,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    return c.json(body, 200);
  });

  app.post("/conversations/:id/open", async (c) => {
    const conversationId = c.req.param("id");
    if (opts.emit === undefined) {
      log.warn("conversations: open requested but emit is not available", {
        conversationId,
      });
      return c.json({ error: "not available" }, 500);
    }
    // Resolve the conversation's persisted workspace id so the frontend can
    // open/focus the tab in the correct workspace. The store falls back to
    // `"default"` when no workspaceId is persisted (or the conversation is
    // unknown), so this never throws for a missing conversation.
    const workspaceId = await opts.conversationStore.getWorkspaceId(conversationId);
    opts.emit(conversationOpened, { conversationId, workspaceId });
    log.info("conversations: opened", { conversationId, workspaceId });
    const body: OpenConversationResponse = { conversationId };
    return c.json(body, 200);
  });

  app.put("/conversations/:id/title", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/title: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.title !== "string" || obj.title.trim().length === 0) {
      return c.json({ error: "Field 'title' is required and must be a non-empty string" }, 400);
    }
    // Trim before persisting (mirrors how `parseQueueBody` / `parseChatBody`
    // forward trimmed text), so a title never carries surrounding whitespace.
    const title = obj.title.trim();

    try {
      await opts.conversationStore.setConversationTitle(conversationId, title);
      log.info("conversations: title set", { conversationId });
      const response: TitleResponse = { conversationId, title };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: title set failure", { err });
      return c.json({ error: "Failed to set conversation title" }, 500);
    }
  });

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

  // ─── Workspaces ──────────────────────────────────────────────────────────

  app.get("/workspaces", async (c) => {
    try {
      const workspaces = await opts.conversationStore.listWorkspaces();
      log.info("workspaces: list", { count: workspaces.length });
      const body: WorkspaceListResponse = { workspaces };
      return c.json(body, 200);
    } catch (err) {
      log.error("workspaces: list failure", { err });
      return c.json({ error: "Failed to list workspaces" }, 500);
    }
  });

  app.put("/workspaces/:id", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidWorkspaceSlug(workspaceId)) {
      return c.json(
        {
          error: "Workspace id must be a valid slug (lowercase alphanumeric + hyphens, 1–40 chars)",
        },
        400,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const obj = body as Record<string, unknown>;
    const opts_: { readonly title?: string; readonly defaultCwd?: string | null } = {};
    if (typeof obj.title === "string") {
      (opts_ as { title?: string }).title = obj.title;
    }
    if (typeof obj.defaultCwd === "string" || obj.defaultCwd === null) {
      (opts_ as { defaultCwd?: string | null }).defaultCwd = obj.defaultCwd;
    }

    try {
      const workspace = await opts.conversationStore.ensureWorkspace(workspaceId, opts_);
      log.info("workspaces: ensured", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: ensure failure", { err });
      return c.json({ error: "Failed to ensure workspace" }, 500);
    }
  });

  app.get("/workspaces/:id", async (c) => {
    const workspaceId = c.req.param("id");
    try {
      const workspace = await opts.conversationStore.getWorkspace(workspaceId);
      if (workspace === null) {
        return c.json({ error: "Workspace not found" }, 404);
      }
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: get failure", { err });
      return c.json({ error: "Failed to read workspace" }, 500);
    }
  });

  app.put("/workspaces/:id/title", async (c) => {
    const workspaceId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("workspaces/title: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.title !== "string" || obj.title.trim().length === 0) {
      return c.json({ error: "Field 'title' is required and must be a non-empty string" }, 400);
    }
    const title = obj.title.trim();

    try {
      const workspace = await opts.conversationStore.setWorkspaceTitle(workspaceId, title);
      log.info("workspaces: title set", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: title set failure", { err });
      return c.json({ error: "Failed to set workspace title" }, 500);
    }
  });

  app.put("/workspaces/:id/default-cwd", async (c) => {
    const workspaceId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const obj = body as Record<string, unknown>;
    const defaultCwd: string | null = typeof obj.defaultCwd === "string" ? obj.defaultCwd : null;

    try {
      const workspace = await opts.conversationStore.setWorkspaceDefaultCwd(
        workspaceId,
        defaultCwd,
      );
      log.info("workspaces: default-cwd set", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: default-cwd set failure", { err });
      return c.json({ error: "Failed to set workspace default cwd" }, 500);
    }
  });

  // Mirrors PUT /workspaces/:id/default-cwd exactly (the computer analog).
  app.put("/workspaces/:id/default-computer", async (c) => {
    const workspaceId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const obj = body as Record<string, unknown>;
    // Mirrors PUT /workspaces/:id/default-cwd: a string → the SSH alias;
    // anything else (null/absent/non-string) → clear (local).
    const defaultComputerId: SetWorkspaceDefaultComputerRequest["computerId"] =
      typeof obj.computerId === "string" ? obj.computerId : null;

    try {
      const workspace = await opts.conversationStore.setWorkspaceDefaultComputerId(
        workspaceId,
        defaultComputerId,
      );
      log.info("workspaces: default-computer set", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: default-computer set failure", { err });
      return c.json({ error: "Failed to set workspace default computer" }, 500);
    }
  });

  app.delete("/workspaces/:id", async (c) => {
    const workspaceId = c.req.param("id");
    if (workspaceId === "default") {
      return c.json({ error: 'The "default" workspace cannot be deleted' }, 409);
    }

    try {
      const { closedCount } = await opts.conversationStore.deleteWorkspace(workspaceId);
      log.info("workspaces: deleted", { workspaceId, closedCount });
      const response: DeleteWorkspaceResponse = { workspaceId, closedCount };
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: delete failure", { err });
      return c.json({ error: "Failed to delete workspace" }, 500);
    }
  });

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

  // ─── Static frontend serving (catch-all, API routes take precedence) ──────
  if (opts.webDir !== undefined) {
    const webDir = opts.webDir;
    const MIME: Record<string, string> = {
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".txt": "text/plain; charset=utf-8",
      ".wasm": "application/wasm",
    };
    app.get("*", async (c) => {
      const urlPath = new URL(c.req.url).pathname;
      const filePath = `${webDir}${urlPath}`;
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const ext = filePath.slice(filePath.lastIndexOf("."));
        const contentType = MIME[ext] ?? "application/octet-stream";
        return new Response(file, {
          headers: { "Content-Type": contentType },
        });
      }
      // SPA fallback: serve index.html for client-side routing
      const indexFile = Bun.file(`${webDir}/index.html`);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return c.json({ error: "Not found" }, 404);
    });
  }

  return app;
}
