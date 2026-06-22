import type { AgentEvent, HostAPI, Logger } from "@dispatch/kernel";
import type {
	CloseConversationResponse,
	CompactPercentResponse,
	CompactResponse,
	ConversationHistoryResponse,
	ConversationListResponse,
	ConversationMetricsResponse,
	CwdResponse,
	DeleteWorkspaceResponse,
	LastMessageResponse,
	LspServerInfo,
	LspStatusResponse,
	ModelsResponse,
	OpenConversationResponse,
	QueueResponse,
	ReasoningEffortResponse,
	SetCompactPercentRequest,
	ThroughputResponse,
	TitleResponse,
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
	isParseError,
	isReasoningEffortParseError,
	isSinceSeqError,
	isWindowParamError,
	parseChatBody,
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
	type ConversationStore,
	type CredentialStore,
	conversationOpened,
	isValidWorkspaceSlug,
	type LspServerStatus,
	type LspService,
	type SessionOrchestrator,
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
	/** Optional — defaults to a no-op store (recording disabled, empty reports). */
	readonly throughputStore?: ThroughputStore;
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

		const { conversationId, message, model, cwd, reasoningEffort, workspaceId } = result;
		log.info("chat: request accepted", {
			conversationId,
			hasModel: model !== undefined,
			hasCwd: cwd !== undefined,
			hasReasoningEffort: reasoningEffort !== undefined,
			hasWorkspaceId: workspaceId !== undefined,
		});

		const events: AgentEvent[] = [];
		let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controllerRef = controller;
			},
		});

		const orchestratorInput: Parameters<SessionOrchestrator["handleMessage"]>[0] = {
			conversationId,
			text: message,
			onEvent: (event) => {
				events.push(event);
				controllerRef?.enqueue(new TextEncoder().encode(serializeEventLine(event)));
			},
			...(model !== undefined ? { modelName: model } : {}),
			...(cwd !== undefined ? { cwd } : {}),
			...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
			...(workspaceId !== undefined ? { workspaceId } : {}),
		};

		opts.orchestrator
			.handleMessage(orchestratorInput)
			.then(async () => {
				controllerRef?.close();
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
				controllerRef?.enqueue(new TextEncoder().encode(serializeEventLine(errorEvent)));
				controllerRef?.close();
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

		try {
			await opts.conversationStore.setCwd(conversationId, obj.cwd);
			log.info("conversations: cwd set", { conversationId });
			const response: CwdResponse = { conversationId, cwd: obj.cwd };
			return c.json(response, 200);
		} catch (err) {
			log.error("conversations: cwd set failure", { err });
			return c.json({ error: "Failed to set conversation cwd" }, 500);
		}
	});

	app.delete("/conversations/:id/cwd", (c) => {
		const conversationId = c.req.param("id");
		// CR: The ConversationStore interface currently has no `clearCwd` method.
		// `setCwd(id, "")` would persist an empty string (not the same as "no
		// cwd key"), and `getEffectiveCwd` treats any non-null explicit cwd as
		// set — so an empty string would shadow the workspace defaultCwd instead
		// of clearing. A `clearCwd` method (wrapping `storage.delete(cwdKey(id))`)
		// is needed on the store interface to truly clear the persisted key.
		// For now the route returns the contract shape (cwd: null); the actual
		// clearing is a no-op until the CR is implemented.
		log.info("conversations: cwd cleared", { conversationId });
		const response: CwdResponse = { conversationId, cwd: null };
		return c.json(response, 200);
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

	app.get("/conversations/:id/lsp", async (c) => {
		const conversationId = c.req.param("id");
		try {
			const cwd = await opts.conversationStore.getEffectiveCwd(conversationId);
			if (cwd === null) {
				log.info("conversations: lsp status read (no cwd)", { conversationId });
				const body: LspStatusResponse = { conversationId, cwd: null, servers: [] };
				return c.json(body, 200);
			}

			if (opts.lspService === undefined) {
				log.warn("conversations: lsp service not available", { conversationId });
				return c.json({ error: "LSP service not available" }, 503);
			}

			const statuses = await opts.lspService.status(cwd);
			const servers: LspServerInfo[] = statuses.map((s: LspServerStatus) => {
				const info: LspServerInfo = {
					id: s.id,
					name: s.name,
					root: s.root,
					extensions: s.extensions,
					state: s.state,
					...(s.error !== undefined ? { error: s.error } : {}),
				};
				return info;
			});
			log.info("conversations: lsp status read", {
				conversationId,
				cwd,
				serverCount: servers.length,
			});
			const body: LspStatusResponse = { conversationId, cwd, servers };
			return c.json(body, 200);
		} catch (err) {
			log.error("conversations: lsp status failure", { err });
			return c.json({ error: "Failed to read LSP status" }, 500);
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

	app.post("/conversations/:id/open", (c) => {
		const conversationId = c.req.param("id");
		if (opts.emit === undefined) {
			log.warn("conversations: open requested but emit is not available", {
				conversationId,
			});
			return c.json({ error: "not available" }, 500);
		}
		opts.emit(conversationOpened, { conversationId });
		log.info("conversations: opened", { conversationId });
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
