import { getTab, NotificationDispatcher } from "@dispatch/core";
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
	const agentModels = Array.isArray(body.agentModels) ? body.agentModels : undefined;
	const workingDirectory =
		typeof body.workingDirectory === "string" ? body.workingDirectory : undefined;
	const queueId = typeof body.queueId === "string" ? body.queueId : undefined;
	const validEfforts = ["none", "low", "medium", "high", "max"];
	const reasoningEffort =
		typeof body.reasoningEffort === "string" && validEfforts.includes(body.reasoningEffort)
			? (body.reasoningEffort as "none" | "low" | "medium" | "high" | "max")
			: undefined;

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
