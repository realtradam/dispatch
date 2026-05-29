import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentManager } from "./agent-manager.js";
import { PermissionManager } from "./permission-manager.js";
import { agentsRoutes } from "./routes/agents.js";
import { configRoutes } from "./routes/config.js";
import { modelsRoutes, startWakeScheduler } from "./routes/models.js";
import { skillsRoutes } from "./routes/skills.js";
import { tabsRoutes } from "./routes/tabs.js";

export const permissionManager = new PermissionManager();
export const agentManager = new AgentManager(permissionManager);

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

	if (agentManager.getTabStatus(tabId) === "running") {
		const queueId = typeof body.queueId === "string" ? body.queueId : undefined;
		const { messageId } = agentManager.queueMessage(tabId, message, queueId);
		return c.json({ status: "queued", messageId });
	}

	const keyId = typeof body.keyId === "string" ? body.keyId : undefined;
	const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
	const agentModels = Array.isArray(body.agentModels) ? body.agentModels : undefined;
	const workingDirectory =
		typeof body.workingDirectory === "string" ? body.workingDirectory : undefined;
	const validEfforts = ["none", "low", "medium", "high", "max"];
	const reasoningEffort =
		typeof body.reasoningEffort === "string" && validEfforts.includes(body.reasoningEffort)
			? (body.reasoningEffort as "none" | "low" | "medium" | "high" | "max")
			: undefined;

	// Non-blocking — let the agent run in the background
	agentManager
		.processMessage(tabId, message, keyId, modelId, reasoningEffort, workingDirectory, agentModels)
		.catch(console.error);

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

// Start the wake scheduler on boot (restores persisted schedule)
startWakeScheduler();
