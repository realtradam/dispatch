import {
	archiveTab,
	createTab,
	deleteSetting,
	getMessagesForTab,
	getSetting,
	getTab,
	listOpenTabs,
	setSetting,
	updateTabModel,
	updateTabStatus,
	updateTabTitle,
} from "@dispatch/core";
import { Hono } from "hono";

export const tabsRoutes = new Hono();

let getAgentManager: () => { stopTab(id: string): void; deleteTab(id: string): void } | null = () =>
	null;

export function setTabsAgentManager(
	getter: () => { stopTab(id: string): void; deleteTab(id: string): void } | null,
): void {
	getAgentManager = getter;
}

tabsRoutes.get("/", (c) => {
	const tabs = listOpenTabs();
	return c.json({ tabs });
});

tabsRoutes.post("/", async (c) => {
	const body = await c.req.json<{ id?: string; title?: string }>();
	const id = body.id ?? crypto.randomUUID();
	const title = body.title ?? "New Tab";
	const tab = createTab(id, title);
	return c.json(tab);
});

// Settings routes (must be before /:id to avoid conflict)
tabsRoutes.get("/settings/title-model", (c) => {
	const keyId = getSetting("title_model_key_id");
	const modelId = getSetting("title_model_id");
	return c.json({ keyId, modelId });
});

tabsRoutes.put("/settings/title-model", async (c) => {
	const body = await c.req.json<{ keyId?: string | null; modelId?: string | null }>();
	if (body.keyId !== undefined) {
		if (body.keyId) setSetting("title_model_key_id", body.keyId);
		else deleteSetting("title_model_key_id");
	}
	if (body.modelId !== undefined) {
		if (body.modelId) setSetting("title_model_id", body.modelId);
		else deleteSetting("title_model_id");
	}
	return c.json({ success: true });
});

tabsRoutes.get("/:id", (c) => {
	const id = c.req.param("id");
	const tab = getTab(id);
	if (!tab) return c.json({ error: "tab not found" }, 404);
	return c.json(tab);
});

tabsRoutes.get("/:id/messages", (c) => {
	const id = c.req.param("id");
	const messages = getMessagesForTab(id);
	return c.json({ messages });
});

tabsRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<{
		title?: string;
		keyId?: string;
		modelId?: string;
		status?: string;
	}>();
	if (body.title !== undefined) updateTabTitle(id, body.title);
	if (body.keyId !== undefined || body.modelId !== undefined) {
		updateTabModel(id, body.keyId ?? null, body.modelId ?? null);
	}
	if (body.status !== undefined) updateTabStatus(id, body.status);
	const tab = getTab(id);
	return c.json(tab);
});

// ─── Settings ─────────────────────────────────────────────────

tabsRoutes.get("/settings/:key", (c) => {
	const key = c.req.param("key");
	const value = getSetting(key);
	return c.json({ value });
});

tabsRoutes.put("/settings/:key", async (c) => {
	const key = c.req.param("key");
	const body = await c.req.json<{ value?: string }>();
	if (typeof body.value !== "string") {
		return c.json({ error: "value is required" }, 400);
	}
	setSetting(key, body.value);
	return c.json({ success: true });
});

tabsRoutes.delete("/:id", (c) => {
	const id = c.req.param("id");
	const mgr = getAgentManager();
	if (mgr) mgr.deleteTab(id);
	archiveTab(id);
	return c.json({ success: true });
});
