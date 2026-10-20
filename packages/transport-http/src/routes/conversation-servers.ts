import type {
  LspServerInfo,
  LspStatusResponse,
  McpServerInfo,
  McpStatusResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";
import type { LspServerStatus, McpServerStatus } from "../seam.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  app.get("/conversations/:id/lsp", async (c) => {
    const conversationId = c.req.param("id");
    try {
      // Gate on the PERSISTED cwd first: when no cwd has been set for the
      // conversation, the LSP does NOT connect (return null + empty servers)
      // rather than falling through to the server default (process.cwd()).
      const persistedCwd = await opts.conversationStore.getCwd(conversationId);
      if (persistedCwd === null) {
        log.info("conversations: lsp status read (no cwd)", { conversationId });
        const body: LspStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      // A persisted cwd exists → resolve the EFFECTIVE cwd (relative cwd
      // resolved against the workspace defaultCwd; absolute → as-is).
      const effectiveCwd = await opts.conversationStore.getEffectiveCwd(conversationId);
      if (effectiveCwd === null) {
        // Edge case: persisted cwd exists but resolution returned null.
        log.info("conversations: lsp status read (no effective cwd)", { conversationId });
        const body: LspStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      if (opts.lspService === undefined) {
        log.warn("conversations: lsp service not available", { conversationId });
        return c.json({ error: "LSP service not available" }, 503);
      }

      const statuses = await opts.lspService.status(effectiveCwd);
      const servers: LspServerInfo[] = statuses.map((s: LspServerStatus) => {
        const info: LspServerInfo = {
          id: s.id,
          name: s.name,
          root: s.root,
          extensions: s.extensions,
          state: s.state,
          ...(s.error !== undefined ? { error: s.error } : {}),
          ...(s.configSource !== undefined ? { configSource: s.configSource } : {}),
        };
        return info;
      });
      log.info("conversations: lsp status read", {
        conversationId,
        cwd: effectiveCwd,
        serverCount: servers.length,
      });
      const body: LspStatusResponse = { conversationId, cwd: effectiveCwd, servers };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: lsp status failure", { err });
      return c.json({ error: "Failed to read LSP status" }, 500);
    }
  });

  // Mirrors GET /conversations/:id/lsp: gate on persisted then effective cwd,
  // 503 when no MCP service, map McpServerStatus → McpServerInfo.
  app.get("/conversations/:id/mcp", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const persistedCwd = await opts.conversationStore.getCwd(conversationId);
      if (persistedCwd === null) {
        log.info("conversations: mcp status read (no cwd)", { conversationId });
        const body: McpStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      const effectiveCwd = await opts.conversationStore.getEffectiveCwd(conversationId);
      if (effectiveCwd === null) {
        log.info("conversations: mcp status read (no effective cwd)", { conversationId });
        const body: McpStatusResponse = { conversationId, cwd: null, servers: [] };
        return c.json(body, 200);
      }

      if (opts.mcpService === undefined) {
        log.warn("conversations: mcp service not available", { conversationId });
        return c.json({ error: "MCP service not available" }, 503);
      }

      const statuses = await opts.mcpService.status(effectiveCwd);
      const servers: McpServerInfo[] = statuses.map((s: McpServerStatus) => {
        const info: McpServerInfo = {
          id: s.id,
          state: s.state,
          toolCount: s.toolCount,
          ...(s.error !== undefined ? { error: s.error } : {}),
        };
        return info;
      });
      log.info("conversations: mcp status read", {
        conversationId,
        cwd: effectiveCwd,
        serverCount: servers.length,
      });
      const body: McpStatusResponse = { conversationId, cwd: effectiveCwd, servers };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: mcp status failure", { err });
      return c.json({ error: "Failed to read MCP status" }, 500);
    }
  });
}
