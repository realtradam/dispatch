import type { AgentEvent, Logger } from "@dispatch/kernel";
import type {
	ConversationHistoryResponse,
	ConversationMetricsResponse,
	ModelsResponse,
	ThroughputResponse,
} from "@dispatch/transport-contract";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	isParseError,
	isSinceSeqError,
	parseChatBody,
	parseSinceSeq,
	serializeEventLine,
} from "./logic.js";
import {
	type ConversationStore,
	type CredentialStore,
	type SessionOrchestrator,
	ThroughputQueryError,
	type ThroughputStore,
} from "./seam.js";

export interface CreateServerOptions {
	readonly conversationStore: ConversationStore;
	readonly orchestrator: SessionOrchestrator;
	readonly credentialStore: CredentialStore;
	/** Optional — defaults to a no-op store (recording disabled, empty reports). */
	readonly throughputStore?: ThroughputStore;
	readonly logger?: Logger;
	readonly generateId?: () => string;
	/** Injectable clock for sample timestamps (default Date.now). */
	readonly now?: () => number;
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
			allowMethods: ["GET", "POST", "OPTIONS"],
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

		try {
			const chunks = await opts.conversationStore.loadSince(conversationId, sinceSeqResult);
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

		const { conversationId, message, model, cwd } = result;
		log.info("chat: request accepted", {
			conversationId,
			hasModel: model !== undefined,
			hasCwd: cwd !== undefined,
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

	return app;
}
