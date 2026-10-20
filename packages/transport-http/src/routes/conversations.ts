import type {
  ConversationListResponse,
  LastMessageResponse,
  OpenConversationResponse,
  TabGroupResponse,
  TitleResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import {
  extractLastAssistantText,
  isParseError,
  parseStatusFilter,
  parseTabGroupBody,
} from "../logic.js";
import type { RouteOptions } from "../route-options.js";
import {
  type ConversationStore,
  conversationOpened,
  conversationTabGroupChanged,
} from "../seam.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // Visual graph writes must validate against the preceding committed write:
  // concurrent A→B / B→A requests must not both pass their cycle checks.
  let tabGroupWriteTail: Promise<void> = Promise.resolve();
  app.get("/conversations", async (c) => {
    try {
      // Optional `?status=` comma-separated filter (e.g. "active,idle").
      // Default: all statuses. Invalid values are silently ignored.
      const rawStatus = c.req.query("status");
      const statusFilter = parseStatusFilter(rawStatus);
      // Optional `?workspaceId=` filter. A missing/empty/whitespace-only
      // value is ignored → return all workspaces. Composable with `?status=`
      // and `?q=`.
      const rawWorkspaceId = c.req.query("workspaceId");
      const workspaceId =
        rawWorkspaceId !== undefined && rawWorkspaceId.trim().length > 0
          ? rawWorkspaceId.trim()
          : undefined;
      const filter: Parameters<ConversationStore["listConversations"]>[0] =
        statusFilter !== undefined || workspaceId !== undefined
          ? {
              ...(statusFilter !== undefined ? { status: statusFilter } : {}),
              ...(workspaceId !== undefined ? { workspaceId } : {}),
            }
          : undefined;
      const all = await opts.conversationStore.listConversations(filter);
      // Optional `?q=` filters by id prefix (short-id resolution). A
      // missing/empty/whitespace-only `q` is ignored → return all.
      const rawQ = c.req.query("q");
      const q = rawQ?.trim() ?? "";
      const conversations = q.length > 0 ? all.filter((m) => m.id.startsWith(q)) : all;
      log.info("conversations: list", {
        count: conversations.length,
        ...(q.length > 0 ? { q } : {}),
        ...(statusFilter !== undefined ? { status: statusFilter.join(",") } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      const body: ConversationListResponse = { conversations };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: list failure", { err });
      return c.json({ error: "Failed to list conversations" }, 500);
    }
  });

  app.get("/conversations/:id/last", async (c) => {
    const conversationId = c.req.param("id");

    // Subscribe BEFORE checking isActive — closes the race where a terminal event
    // fires between the check and the subscribe (we'd miss it). If idle,
    // unsubscribe immediately; if active, wait for a `turn-ended` event
    // (or a 60s timeout, then proceed regardless of what's available).
    let turnId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        unsubscribe = opts.orchestrator.subscribe(conversationId, (event) => {
          if (event.type === "turn-ended") {
            turnId = event.turnId;
            finish();
          }
        });
        if (!opts.orchestrator.isActive(conversationId)) {
          finish();
          return;
        }
        // A terminal event may have fired synchronously during subscribe (the
        // real orchestrator never does this, but a fake might) — don't
        // arm a 60s timer for an already-settled promise.
        if (settled) return;
        timer = setTimeout(finish, 60_000);
      });
    } finally {
      unsubscribe?.();
    }

    let content = "";
    try {
      const messages = await opts.conversationStore.load(conversationId);
      content = extractLastAssistantText(messages);
    } catch (err) {
      log.error("conversations: last message load failure", { err });
      return c.json({ error: "Failed to load conversation" }, 500);
    }

    log.info("conversations: last read", {
      conversationId,
      hasContent: content.length > 0,
    });
    const body: LastMessageResponse = {
      conversationId,
      content,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    return c.json(body, 200);
  });

  app.post("/conversations/:id/open", async (c) => {
    const conversationId = c.req.param("id");
    if (opts.emit === undefined) {
      log.warn("conversations: open requested but emit is not available", {
        conversationId,
      });
      return c.json({ error: "not available" }, 500);
    }
    // Resolve the conversation's persisted workspace id so the frontend can
    // open/focus the tab in the correct workspace. The store falls back to
    // `"default"` when no workspaceId is persisted (or the conversation is
    // unknown), so this never throws for a missing conversation.
    const workspaceId = await opts.conversationStore.getWorkspaceId(conversationId);
    // Surface the persisted per-conversation model so the frontend can stamp
    // the opened tab with the conversation's ACTUAL model (not the global
    // active model) — fix-toolcall-duplicate-keys plan Part 4.
    const model = await opts.conversationStore.getModel(conversationId);
    const tabGroupParentId = await opts.conversationStore.getTabGroupParentId(conversationId);
    opts.emit(conversationOpened, {
      conversationId,
      workspaceId,
      ...(model !== null ? { model } : {}),
      ...(tabGroupParentId !== null ? { tabGroupParentId } : {}),
    });
    log.info("conversations: opened", { conversationId, workspaceId });
    const body: OpenConversationResponse = { conversationId };
    return c.json(body, 200);
  });

  app.put("/conversations/:id/tab-group", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseTabGroupBody(body);
    if (isParseError(parsed)) return c.json(parsed, 400);
    const { parentId } = parsed;
    if (parentId === conversationId) {
      return c.json({ error: "A conversation cannot group under itself" }, 400);
    }

    const previousWrite = tabGroupWriteTail;
    let releaseWrite: () => void = () => {};
    tabGroupWriteTail = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    await previousWrite;
    try {
      const store = opts.conversationStore;
      const meta = await store.getConversationMeta(conversationId);
      if (meta === null) return c.json({ error: "Conversation not found" }, 404);
      if (parentId !== null) {
        const parent = await store.getConversationMeta(parentId);
        if (parent === null) return c.json({ error: "Parent conversation not found" }, 404);
        if (parent.workspaceId !== meta.workspaceId) {
          return c.json({ error: "Tab group parent must be in the same workspace" }, 400);
        }
        // Walk EFFECTIVE visual links, never lineage. A visited set also bounds
        // the walk when persisted data already contains an unrelated loop.
        let cursor: string | null = parentId;
        const visited = new Set<string>();
        while (cursor !== null) {
          if (cursor === conversationId) {
            return c.json({ error: "Tab group would form a cycle" }, 409);
          }
          if (visited.has(cursor)) break;
          visited.add(cursor);
          cursor = await store.getTabGroupParentId(cursor);
        }
      }
      if (opts.emit === undefined) return c.json({ error: "not available" }, 500);
      await store.setTabGroupParentId(conversationId, parentId);
      const tabGroupParentId = await store.getTabGroupParentId(conversationId);
      opts.emit(conversationTabGroupChanged, {
        conversationId,
        workspaceId: meta.workspaceId,
        tabGroupParentId,
      });
      const response: TabGroupResponse = { conversationId, tabGroupParentId };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: tab group set failure", { err });
      return c.json({ error: "Failed to set tab group" }, 500);
    } finally {
      releaseWrite();
    }
  });

  app.put("/conversations/:id/title", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/title: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.title !== "string" || obj.title.trim().length === 0) {
      return c.json({ error: "Field 'title' is required and must be a non-empty string" }, 400);
    }
    // Trim before persisting (mirrors how `parseQueueBody` / `parseChatBody`
    // forward trimmed text), so a title never carries surrounding whitespace.
    const title = obj.title.trim();

    try {
      await opts.conversationStore.setConversationTitle(conversationId, title);
      log.info("conversations: title set", { conversationId });
      const response: TitleResponse = { conversationId, title };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: title set failure", { err });
      return c.json({ error: "Failed to set conversation title" }, 500);
    }
  });
}
