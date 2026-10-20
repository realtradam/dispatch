import type {
  DeleteWorkspaceResponse,
  SetWorkspaceDefaultComputerRequest,
  WorkspaceListResponse,
  WorkspaceResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";
import { isValidWorkspaceSlug } from "../seam.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Workspaces ──────────────────────────────────────────────────────────

  app.get("/workspaces", async (c) => {
    try {
      // Optional `?archived=` filter: "true" → archived only, "all" → every
      // workspace, anything else (or absent) → non-archived only (the home
      // grid's default view). Mirrors the `?status=` pattern on /conversations.
      const rawArchived = c.req.query("archived");
      const archivedFilter =
        rawArchived === "true" ? "true" : rawArchived === "all" ? "all" : "false";
      const all = await opts.conversationStore.listWorkspaces();
      const workspaces =
        archivedFilter === "all"
          ? all
          : all.filter((w) => (archivedFilter === "true") === w.archived);
      log.info("workspaces: list", { count: workspaces.length, archived: archivedFilter });
      const body: WorkspaceListResponse = { workspaces };
      return c.json(body, 200);
    } catch (err) {
      log.error("workspaces: list failure", { err });
      return c.json({ error: "Failed to list workspaces" }, 500);
    }
  });

  app.put("/workspaces/:id", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidWorkspaceSlug(workspaceId)) {
      return c.json(
        {
          error: "Workspace id must be a valid slug (lowercase alphanumeric + hyphens, 1–40 chars)",
        },
        400,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const obj = body as Record<string, unknown>;
    const opts_: { readonly title?: string; readonly defaultCwd?: string | null } = {};
    if (typeof obj.title === "string") {
      (opts_ as { title?: string }).title = obj.title;
    }
    if (typeof obj.defaultCwd === "string" || obj.defaultCwd === null) {
      (opts_ as { defaultCwd?: string | null }).defaultCwd = obj.defaultCwd;
    }

    try {
      const workspace = await opts.conversationStore.ensureWorkspace(workspaceId, opts_);
      log.info("workspaces: ensured", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: ensure failure", { err });
      return c.json({ error: "Failed to ensure workspace" }, 500);
    }
  });

  app.get("/workspaces/:id", async (c) => {
    const workspaceId = c.req.param("id");
    try {
      const workspace = await opts.conversationStore.getWorkspace(workspaceId);
      if (workspace === null) {
        return c.json({ error: "Workspace not found" }, 404);
      }
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: get failure", { err });
      return c.json({ error: "Failed to read workspace" }, 500);
    }
  });

  app.put("/workspaces/:id/title", async (c) => {
    const workspaceId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("workspaces/title: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.title !== "string" || obj.title.trim().length === 0) {
      return c.json({ error: "Field 'title' is required and must be a non-empty string" }, 400);
    }
    const title = obj.title.trim();

    try {
      const workspace = await opts.conversationStore.setWorkspaceTitle(workspaceId, title);
      log.info("workspaces: title set", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: title set failure", { err });
      return c.json({ error: "Failed to set workspace title" }, 500);
    }
  });

  app.put("/workspaces/:id/default-cwd", async (c) => {
    const workspaceId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const obj = body as Record<string, unknown>;
    const defaultCwd: string | null = typeof obj.defaultCwd === "string" ? obj.defaultCwd : null;

    try {
      const workspace = await opts.conversationStore.setWorkspaceDefaultCwd(
        workspaceId,
        defaultCwd,
      );
      log.info("workspaces: default-cwd set", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: default-cwd set failure", { err });
      return c.json({ error: "Failed to set workspace default cwd" }, 500);
    }
  });

  // Mirrors PUT /workspaces/:id/default-cwd exactly (the computer analog).
  app.put("/workspaces/:id/default-computer", async (c) => {
    const workspaceId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const obj = body as Record<string, unknown>;
    // Mirrors PUT /workspaces/:id/default-cwd: a string → the SSH alias;
    // anything else (null/absent/non-string) → clear (local).
    const defaultComputerId: SetWorkspaceDefaultComputerRequest["computerId"] =
      typeof obj.computerId === "string" ? obj.computerId : null;

    try {
      const workspace = await opts.conversationStore.setWorkspaceDefaultComputerId(
        workspaceId,
        defaultComputerId,
      );
      log.info("workspaces: default-computer set", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: default-computer set failure", { err });
      return c.json({ error: "Failed to set workspace default computer" }, 500);
    }
  });

  app.delete("/workspaces/:id", async (c) => {
    const workspaceId = c.req.param("id");
    if (workspaceId === "default") {
      return c.json({ error: 'The "default" workspace cannot be deleted' }, 409);
    }

    try {
      const { closedCount } = await opts.conversationStore.deleteWorkspace(workspaceId);
      // Clean up the in-memory starred cache so a deleted workspace's ID
      // doesn't linger (and so a future workspace re-created with the same
      // slug doesn't inherit the stale starred state).
      opts.concurrencyService?.notifyWorkspaceStarred(workspaceId, false);
      log.info("workspaces: deleted", { workspaceId, closedCount });
      const response: DeleteWorkspaceResponse = { workspaceId, closedCount };
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: delete failure", { err });
      return c.json({ error: "Failed to delete workspace" }, 500);
    }
  });

  // ─── Star/unstar workspace (concurrency priority) ───────────────────────────
  // Starred workspaces receive PRIORITY in the concurrency limiter queue —
  // their agents jump ahead of agents from non-starred workspaces. The
  // starred state is persisted in the conversation store AND the in-memory
  // cache in the concurrency service is notified so already-queued agents
  // are re-prioritized immediately.

  app.put("/workspaces/:id/star", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidWorkspaceSlug(workspaceId)) {
      return c.json(
        {
          error: "Workspace id must be a valid slug (lowercase alphanumeric + hyphens, 1–40 chars)",
        },
        400,
      );
    }
    try {
      const workspace = await opts.conversationStore.setWorkspaceStarred(workspaceId, true);
      // Notify the concurrency service's in-memory cache so queued agents
      // from this workspace jump ahead immediately. When the concurrency
      // service is absent (extension not loaded), the starred state is
      // persisted but the in-memory priority cache is NOT updated — log a
      // warning so the degraded behavior is visible (queued agents keep
      // their old priority until restart or the extension is loaded).
      if (opts.concurrencyService !== undefined) {
        opts.concurrencyService.notifyWorkspaceStarred(workspaceId, true);
      } else {
        log.warn(
          "workspaces: starred but concurrency service is not loaded — priority cache not updated",
          {
            workspaceId,
          },
        );
      }
      log.info("workspaces: starred", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: star failure", { err, workspaceId });
      return c.json({ error: "Failed to star workspace" }, 500);
    }
  });

  app.delete("/workspaces/:id/star", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidWorkspaceSlug(workspaceId)) {
      return c.json(
        {
          error: "Workspace id must be a valid slug (lowercase alphanumeric + hyphens, 1–40 chars)",
        },
        400,
      );
    }
    try {
      const workspace = await opts.conversationStore.setWorkspaceStarred(workspaceId, false);
      if (opts.concurrencyService !== undefined) {
        opts.concurrencyService.notifyWorkspaceStarred(workspaceId, false);
      } else {
        log.warn(
          "workspaces: unstarred but concurrency service is not loaded — priority cache not updated",
          {
            workspaceId,
          },
        );
      }
      log.info("workspaces: unstarred", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: unstar failure", { err, workspaceId });
      return c.json({ error: "Failed to unstar workspace" }, 500);
    }
  });

  // ─── Archive/unarchive workspace ─────────────────────────────────────────────
  // Archived workspaces are hidden from the home grid (`GET /workspaces`
  // excludes them by default) WITHOUT deleting their data — the workspace, its
  // conversations, and its settings are untouched, and it can be unarchived at
  // any time. Unlike delete, archive touches no conversations.

  app.put("/workspaces/:id/archive", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidWorkspaceSlug(workspaceId)) {
      return c.json(
        {
          error: "Workspace id must be a valid slug (lowercase alphanumeric + hyphens, 1–40 chars)",
        },
        400,
      );
    }
    if (workspaceId === "default") {
      return c.json({ error: 'The "default" workspace cannot be archived' }, 409);
    }
    try {
      const workspace = await opts.conversationStore.setWorkspaceArchived(workspaceId, true);
      log.info("workspaces: archived", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: archive failure", { err, workspaceId });
      return c.json({ error: "Failed to archive workspace" }, 500);
    }
  });

  app.delete("/workspaces/:id/archive", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidWorkspaceSlug(workspaceId)) {
      return c.json(
        {
          error: "Workspace id must be a valid slug (lowercase alphanumeric + hyphens, 1–40 chars)",
        },
        400,
      );
    }
    if (workspaceId === "default") {
      return c.json({ error: 'The "default" workspace cannot be archived' }, 409);
    }
    try {
      const workspace = await opts.conversationStore.setWorkspaceArchived(workspaceId, false);
      log.info("workspaces: unarchived", { workspaceId });
      const response: WorkspaceResponse = workspace;
      return c.json(response, 200);
    } catch (err) {
      log.error("workspaces: unarchive failure", { err, workspaceId });
      return c.json({ error: "Failed to unarchive workspace" }, 500);
    }
  });
}
