import {
	type AgentModelEntry,
	getTab,
	isReasoningEffort,
	NotificationDispatcher,
	type UserContentPart,
	validateUserContent,
} from "@dispatch/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentManager } from "./agent-manager.js";
import { PermissionManager } from "./permission-manager.js";
import { agentsRoutes } from "./routes/agents.js";
import { configRoutes } from "./routes/config.js";
import { modelsRoutes, startWakeScheduler } from "./routes/models.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { skillsRoutes } from "./routes/skills.js";
import { tabsRoutes } from "./routes/tabs.js";

/**
 * Validate and normalise the `agentModels` fallback chain coming from the
 * frontend. Each entry must carry string `key_id`/`model_id`; an `effort` is
 * kept only when it's a recognised level (otherwise dropped so the per-tab /
 * default effort applies). Returns `undefined` when the input isn't an array.
 */
function sanitizeAgentModels(raw: unknown): AgentModelEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: AgentModelEntry[] = [];
	for (const m of raw) {
		if (!m || typeof m !== "object") continue;
		const entry = m as Record<string, unknown>;
		if (typeof entry.key_id !== "string" || typeof entry.model_id !== "string") continue;
		out.push({
			key_id: entry.key_id,
			model_id: entry.model_id,
			...(isReasoningEffort(entry.effort) ? { effort: entry.effort } : {}),
		});
	}
	return out;
}

/**
 * Validate and normalise the optional multimodal `content` array from the
 * `/chat` body. Each entry is either a `{ type: "text", text }` part or a
 * `{ type: "attachment", mediaType, data, name? }` part (base64 payload).
 * Returns `undefined` when the input isn't a non-empty array or contains no
 * attachment (so the plain-string path is taken — byte-identical to before).
 * Shape only: SIZE/TYPE limits are enforced separately by `validateUserContent`.
 */
function sanitizeUserContent(raw: unknown): UserContentPart[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const out: UserContentPart[] = [];
	let hasAttachment = false;
	for (const p of raw) {
		if (!p || typeof p !== "object") continue;
		const part = p as Record<string, unknown>;
		if (part.type === "text") {
			if (typeof part.text === "string") out.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "attachment") {
			if (typeof part.mediaType !== "string" || typeof part.data !== "string") continue;
			hasAttachment = true;
			out.push({
				type: "attachment",
				mediaType: part.mediaType,
				data: part.data,
				...(typeof part.name === "string" ? { name: part.name } : {}),
			});
		}
	}
	// No attachment → let the plain-text path handle it (avoids needlessly
	// switching the model message to array content for a text-only turn).
	return hasAttachment ? out : undefined;
}

export const permissionManager = new PermissionManager();
export const agentManager = new AgentManager(permissionManager);

// ntfy.sh push notifications. The dispatcher reads its config from the
// `settings` table on every send, so config changes apply immediately —
// no restart, no re-attach needed.
export const notificationDispatcher = new NotificationDispatcher({
	getTabTitle: (tabId) => {
		try {
			return getTab(tabId)?.title ?? null;
		} catch {
			return null;
		}
	},
	getTabParentId: (tabId) => {
		try {
			// `undefined` when the lookup fails (tab not found / DB unavailable)
			// so the dispatcher falls back to "treat as top-level" rather than
			// silently dropping notifications.
			const row = getTab(tabId);
			return row ? row.parentTabId : undefined;
		} catch {
			return undefined;
		}
	},
});
notificationDispatcher.attachToAgentManager(agentManager);
notificationDispatcher.attachToPermissionManager(permissionManager);

export const app = new Hono();

app.use(
	"*",
	cors({
		origin: (origin) => origin || "*",
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
	}),
);

app.get("/health", (c) => {
	return c.json({ ok: true });
});

app.get("/status", (c) => {
	return c.json({
		status: agentManager.getStatus(),
		messageCount: agentManager.getMessageCount(),
		statuses: agentManager.getAllStatuses(),
	});
});

app.post("/chat", async (c) => {
	const body = await c.req.json<{
		tabId?: unknown;
		message?: unknown;
		content?: unknown;
		keyId?: unknown;
		modelId?: unknown;
		agentModels?: unknown;
		reasoningEffort?: unknown;
		workingDirectory?: unknown;
		queueId?: unknown;
	}>();
	const { tabId, message } = body;

	if (typeof tabId !== "string" || tabId.trim() === "") {
		return c.json({ error: "tabId must be a non-empty string" }, 400);
	}

	if (typeof message !== "string" || message.trim() === "") {
		return c.json({ error: "message must be a non-empty string" }, 400);
	}

	const keyId = typeof body.keyId === "string" ? body.keyId : undefined;
	const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
	const agentModels = sanitizeAgentModels(body.agentModels);
	const workingDirectory =
		typeof body.workingDirectory === "string" ? body.workingDirectory : undefined;
	const queueId = typeof body.queueId === "string" ? body.queueId : undefined;
	const reasoningEffort = isReasoningEffort(body.reasoningEffort)
		? body.reasoningEffort
		: undefined;

	// Optional multimodal content (image/pdf attachments). When present, the
	// attachments are EPHEMERAL — forwarded to the model for this turn only and
	// never persisted (the chunk log keeps just `message`, which the frontend
	// has already projected to text with `[image]`/`[pdf]` markers).
	const content = sanitizeUserContent(body.content);
	if (content) {
		// Enforce size/type/count ceilings server-side (defence in depth; the
		// frontend also enforces them at paste time). Reject the whole request
		// so no tokens are spent on an over-limit payload.
		const validation = validateUserContent(content);
		if (!validation.ok) {
			return c.json({ error: "invalid attachments", details: validation.errors }, 400);
		}
		// Attachments only attach to a FRESH turn. If the tab is mid-turn the
		// message would queue (text-only machinery), silently dropping the
		// images. Reject clearly instead so the user can retry once idle.
		if (agentManager.getTabStatus(tabId) === "running") {
			return c.json(
				{ error: "cannot attach images while the agent is generating; wait for it to finish" },
				409,
			);
		}
	}

	// Single routing decision (queue if busy, new turn if idle) shared with the
	// `send_to_tab` tool via `AgentManager.deliverMessage`. Non-blocking — a
	// started turn runs in the background.
	const outcome = agentManager.deliverMessage(tabId, message, {
		...(keyId ? { keyId } : {}),
		...(modelId ? { modelId } : {}),
		...(agentModels ? { agentModels } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		...(workingDirectory !== undefined ? { workingDirectory } : {}),
		...(queueId ? { queueId } : {}),
		...(content ? { content } : {}),
	});

	if (outcome.status === "queued") {
		return c.json({ status: "queued", messageId: outcome.messageId });
	}
	return c.json({ status: "ok" });
});

app.route("/config", configRoutes);

app.post("/chat/cancel", async (c) => {
	const body = await c.req.json();
	if (typeof body.tabId !== "string" || typeof body.messageId !== "string") {
		return c.json({ error: "tabId and messageId are required strings" }, 400);
	}
	const tabId = body.tabId;
	const messageId = body.messageId;
	const cancelled = agentManager.cancelQueuedMessage(tabId, messageId);
	return c.json({ success: cancelled });
});

app.post("/chat/stop", async (c) => {
	const body = await c.req.json();
	if (typeof body.tabId !== "string") {
		return c.json({ error: "tabId is required" }, 400);
	}
	agentManager.stopTab(body.tabId);
	return c.json({ success: true });
});

app.route("/skills", skillsRoutes);
app.route("/models", modelsRoutes);
app.route("/tabs", tabsRoutes);
app.route("/agents", agentsRoutes);
app.route("/notifications", notificationsRoutes);

// Start the wake scheduler on boot (restores persisted schedule)
startWakeScheduler();
