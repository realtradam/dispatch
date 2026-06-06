import type { AgentEvent, Logger } from "@dispatch/kernel";
import type { ConversationHistoryResponse, ModelsResponse } from "@dispatch/transport-contract";
import { Hono } from "hono";
import {
	isParseError,
	isSinceSeqError,
	parseChatBody,
	parseSinceSeq,
	serializeEventLine,
} from "./logic.js";
import type { ConversationStore, CredentialStore, SessionOrchestrator } from "./seam.js";

export interface CreateServerOptions {
	readonly conversationStore: ConversationStore;
	readonly orchestrator: SessionOrchestrator;
	readonly credentialStore: CredentialStore;
	readonly logger?: Logger;
	readonly generateId?: () => string;
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

export function createApp(opts: CreateServerOptions): Hono {
	const app = new Hono();
	const log = opts.logger ?? noopLogger;
	const generateId = opts.generateId ?? (() => crypto.randomUUID());

	app.get("/health", (c) => c.json({ ok: true }));

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

		const ndjson = events.map(serializeEventLine).join("");

		return c.text(ndjson, 200, {
			"Content-Type": "application/x-ndjson",
			"X-Conversation-Id": conversationId,
		});
	});

	return app;
}
