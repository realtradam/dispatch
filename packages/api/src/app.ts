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
		origin: "http://localhost:5173",
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
		reasoningEffort?: unknown;
		workingDirectory?: unknown;
	}>();
	const { tabId, message } = body;

	if (typeof tabId !== "string" || tabId.trim() === "") {
		return c.json({ error: "tabId must be a non-empty string" }, 400);
	}

	if (typeof message !== "string" || message.trim() === "") {
		return c.json({ error: "message must be a non-empty string" }, 400);
	}

	if (agentManager.getTabStatus(tabId) === "running") {
		return c.json({ error: "agent is already running for this tab" }, 409);
	}

	const keyId = typeof body.keyId === "string" ? body.keyId : undefined;
	const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
	const workingDirectory = typeof body.workingDirectory === "string" ? body.workingDirectory : undefined;
	const validEfforts = ["none", "low", "medium", "high", "max"];
	const reasoningEffort =
		typeof body.reasoningEffort === "string" && validEfforts.includes(body.reasoningEffort)
			? (body.reasoningEffort as "none" | "low" | "medium" | "high" | "max")
			: undefined;

	// Non-blocking — let the agent run in the background
	agentManager.processMessage(tabId, message, keyId, modelId, reasoningEffort, workingDirectory).catch(console.error);

	return c.json({ status: "ok" });
});

app.route("/config", configRoutes);
app.route("/skills", skillsRoutes);
app.route("/models", modelsRoutes);
app.route("/tabs", tabsRoutes);
app.route("/agents", agentsRoutes);

// Start the wake scheduler on boot (restores persisted schedule)
startWakeScheduler();
