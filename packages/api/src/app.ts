import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentManager } from "./agent-manager.js";
import { PermissionManager } from "./permission-manager.js";
import { configRoutes } from "./routes/config.js";
import { skillsRoutes } from "./routes/skills.js";
import { modelsRoutes, startWakeScheduler } from "./routes/models.js";

export const permissionManager = new PermissionManager();
export const agentManager = new AgentManager(permissionManager);

export const app = new Hono();

app.use(
	"*",
	cors({
		origin: "http://localhost:5173",
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);

app.get("/health", (c) => {
	return c.json({ ok: true });
});

app.get("/status", (c) => {
	return c.json({
		status: agentManager.getStatus(),
		messageCount: agentManager.getMessageCount(),
	});
});

app.post("/chat", async (c) => {
	const body = await c.req.json<{ message?: unknown; keyId?: unknown; modelId?: unknown; reasoningEffort?: unknown }>();
	const message = body.message;

	if (typeof message !== "string" || message.trim() === "") {
		return c.json({ error: "message must be a non-empty string" }, 400);
	}

	if (agentManager.getStatus() === "running") {
		return c.json({ error: "agent is already running" }, 409);
	}

	const keyId = typeof body.keyId === "string" ? body.keyId : undefined;
	const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
	const validEfforts = ["none", "low", "medium", "high", "max"];
	const reasoningEffort = typeof body.reasoningEffort === "string" && validEfforts.includes(body.reasoningEffort)
		? (body.reasoningEffort as "none" | "low" | "medium" | "high" | "max")
		: undefined;

	// Non-blocking — let the agent run in the background
	agentManager.processMessage(message, keyId, modelId, reasoningEffort).catch(console.error);

	return c.json({ status: "ok" });
});

app.route("/config", configRoutes);
app.route("/skills", skillsRoutes);
app.route("/models", modelsRoutes);

// Start the wake scheduler on boot (restores persisted schedule)
startWakeScheduler();
