import type { AgentEvent } from "@dispatch/kernel";
import type { ModelsResponse } from "@dispatch/transport-contract";
import { Hono } from "hono";
import { isParseError, parseChatBody, serializeEventLine } from "./logic.js";
import type { CredentialStore, SessionOrchestrator } from "./seam.js";

export interface CreateServerOptions {
	readonly orchestrator: SessionOrchestrator;
	readonly credentialStore: CredentialStore;
	readonly generateId?: () => string;
}

export function createApp(opts: CreateServerOptions): Hono {
	const app = new Hono();
	const generateId = opts.generateId ?? (() => crypto.randomUUID());

	app.get("/health", (c) => c.json({ ok: true }));

	app.get("/models", async (c) => {
		try {
			const models = await opts.credentialStore.listCatalog();
			const body: ModelsResponse = { models };
			return c.json(body, 200);
		} catch {
			return c.json({ error: "Failed to retrieve model catalog" }, 502);
		}
	});

	app.post("/chat", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const result = parseChatBody(body, generateId);
		if (isParseError(result)) {
			return c.json({ error: result.error }, 400);
		}

		const { conversationId, message, model, cwd } = result;
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
