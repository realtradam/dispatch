import {
	archiveTab,
	createTab,
	deleteSetting,
	getChunksForTab,
	getSetting,
	getTab,
	getTotalChunkCount,
	getUsageStatsForTab,
	groupRowsToMessages,
	listOpenTabs,
	setSetting,
	updateTabModel,
	updateTabPositions,
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
	// Enrich each tab with its persisted usage aggregate so the frontend can
	// seed `cacheStats` on reload without an extra round-trip. N small indexed
	// queries — fine for tab counts.
	const tabs = listOpenTabs().map((t) => ({ ...t, usageStats: getUsageStatsForTab(t.id) }));
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

// Reorder open tabs. Body `{ ids }` is the new left-to-right order of tab ids;
// each tab's `position` is rewritten to its index. Must be declared before the
// `/:id` routes so "reorder" isn't captured as an id param.
tabsRoutes.patch("/reorder", async (c) => {
	const body = await c.req.json<{ ids?: string[] }>();
	if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
		return c.json({ error: "ids must be an array of strings" }, 400);
	}
	updateTabPositions(body.ids);
	return c.json({ success: true });
});

tabsRoutes.get("/:id", (c) => {
	const id = c.req.param("id");
	const tab = getTab(id);
	if (!tab) return c.json({ error: "tab not found" }, 404);
	return c.json(tab);
});

// Conversation history for a tab, paginated at CHUNK granularity. The flat
// chunk log is windowed by `limit`/`before` (both chunk-`seq` cursors) so a
// single huge turn never dumps in full, then grouped into render messages.
// `before` is the oldest chunk seq the client already holds. This is what
// powers per-chunk frontend pagination / memory control.
tabsRoutes.get("/:id/messages", (c) => {
	const id = c.req.param("id");
	const limitRaw = c.req.query("limit");
	const beforeRaw = c.req.query("before");
	const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
	const before = beforeRaw !== undefined ? Number(beforeRaw) : undefined;
	const options =
		limit !== undefined || before !== undefined
			? {
					...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
					...(before !== undefined && Number.isFinite(before) ? { before } : {}),
				}
			: undefined;
	const chunks = getChunksForTab(id, options);
	const messages = groupRowsToMessages(chunks);
	// `oldestSeq` is the chunk-seq cursor the client pages backward from; null
	// when the window is empty.
	const oldestSeq = chunks.length > 0 ? (chunks[0]?.seq ?? null) : null;
	const total = getTotalChunkCount(id);
	return c.json({ messages, total, oldestSeq });
});

// Raw chunk window for a tab — the chunk-native frontend's load/paginate
// source. Same `limit`/`before` chunk-`seq` windowing as `/messages`, but
// returns the flat `ChunkRow[]` WITHOUT server-side grouping (the frontend
// groups for render and evicts/paginates on the flat list). Dedupe on the
// client by `seq` when overlap-fetching.
tabsRoutes.get("/:id/chunks", (c) => {
	const id = c.req.param("id");
	const limitRaw = c.req.query("limit");
	const beforeRaw = c.req.query("before");
	const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
	const before = beforeRaw !== undefined ? Number(beforeRaw) : undefined;
	const options =
		limit !== undefined || before !== undefined
			? {
					...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
					...(before !== undefined && Number.isFinite(before) ? { before } : {}),
				}
			: undefined;
	const chunks = getChunksForTab(id, options);
	const oldestSeq = chunks.length > 0 ? (chunks[0]?.seq ?? null) : null;
	const total = getTotalChunkCount(id);
	return c.json({ chunks, total, oldestSeq });
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
