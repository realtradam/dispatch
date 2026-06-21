import type { AgentEvent, HostAPI, Logger } from "@dispatch/kernel";
import type {
	CloseConversationResponse,
	ConversationHistoryResponse,
	ConversationListResponse,
	ConversationMetricsResponse,
	CwdResponse,
	LastMessageResponse,
	LspServerInfo,
	LspStatusResponse,
	ModelsResponse,
	OpenConversationResponse,
	QueueResponse,
	ReasoningEffortResponse,
	ThroughputResponse,
	TitleResponse,
	WarmResponse,
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
	parseWarmBody,
	parseWindowParam,
	serializeEventLine,
} from "./logic.js";
import {
	type ConversationStore,
	type CredentialStore,
	conversationOpened,
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
			allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
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
			const body: ModelsResponse = { models };
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

		const { conversationId, message, model, cwd, reasoningEffort } = result;
		log.info("chat: request accepted", {
			conversationId,
			hasModel: model !== undefined,
			hasCwd: cwd !== undefined,
			hasReasoningEffort: reasoningEffort !== undefined,
		});

		const events: AgentEvent[] = [];
		let resolveStream: () => void;
		const streamReady = new Promise<void>((resolve) => {
			resolveStream = resolve;
		});

		const orchestratorInput: Parameters<SessionOrchestrator["handleMessage"]>[0] = {
			conversationId,
			text: message,
			onEvent: (event) => {
				events.push(event);
			},
			...(model !== undefined ? { modelName: model } : {}),
			...(cwd !== undefined ? { cwd } : {}),
			...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
		};

		const orchestratorPromise = opts.orchestrator
			.handleMessage(orchestratorInput)
			.then(() => {
				resolveStream();
			})
			.catch((err) => {
				log.error("chat: turn failed", { err });
				events.push({
					type: "error",
					conversationId,
					turnId: "",
					message: err instanceof Error ? err.message : String(err),
				});
				resolveStream();
			});

		await streamReady;
		await orchestratorPromise.catch(() => {});

		// Record a per-model throughput sample for this turn. Generation time is
		// the PURE decode time — the sum of per-step genTotalMs (excludes tool
		// waits) — and tokens are the turn's aggregate output tokens.
		await recordThroughput(events, model);

		const ndjson = events.map(serializeEventLine).join("");

		return c.text(ndjson, 200, {
			"Content-Type": "application/x-ndjson",
			"X-Conversation-Id": conversationId,
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
			const cwd = await opts.conversationStore.getCwd(conversationId);
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
			const all = await opts.conversationStore.listConversations();
			// Optional `?q=` filters by id prefix (short-id resolution). A
			// missing/empty/whitespace-only `q` is ignored → return all.
			const rawQ = c.req.query("q");
			const q = rawQ?.trim() ?? "";
			const conversations = q.length > 0 ? all.filter((m) => m.id.startsWith(q)) : all;
			log.info("conversations: list", {
				count: conversations.length,
				...(q.length > 0 ? { q } : {}),
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

	// ─── Static frontend serving (catch-all, API routes take precedence) ──────
	if (opts.webDir !== undefined) {
		const webDir = opts.webDir;
		app.get("*", async (c) => {
			const urlPath = new URL(c.req.url).pathname;
			const filePath = `${webDir}${urlPath}`;
			const file = Bun.file(filePath);
			if (await file.exists()) {
				return new Response(file);
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
