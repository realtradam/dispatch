import type { PluginListResponse, PluginScanResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import { parsePluginForceBody, pluginOpStatus } from "../logic.js";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  // ─── Plugin manager (plan 05) ─────────────────────────────────────────────
  // Thin shells over the PluginManagerService (the core `plugin-manager`
  // extension's typed service): parse → delegate → map the structured result
  // to a status. All unload POLICY (core lock, last-provider lock, cascade
  // warning, forced agent stop) is enforced server-side in the manager —
  // these handlers never re-implement it.

  app.get("/plugins", async (c) => {
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    try {
      const list = await opts.pluginManagerService.list();
      log.info("plugins: list", {
        loaded: list.loaded.length,
        disabled: list.disabledWithReason.length,
        discovered: list.discovered.length,
        missing: list.missing.length,
      });
      const body: PluginListResponse = list;
      return c.json(body, 200);
    } catch (err) {
      log.error("plugins: list failure", { err });
      return c.json({ error: "Failed to list plugins" }, 500);
    }
  });

  // ─── Plugin frontend entry (plan 03 §3.1) ─────────────────────────────────
  // Serves a loaded plugin's declared `frontend.entry` file — the prebuilt
  // ESM the web client dynamically imports. ALL gating is the manager
  // service's decision (unknown / unloaded / frontend-less /
  // disabled-in-the-caller's-active-workspace / traversal) — every block is
  // 404, so the response never leaks WHICH case hit (a disabled plugin's
  // code must not be fetchable). `workspace` is the caller's ACTIVE
  // workspace (absent → the default workspace); `v` is the client's
  // cache-bust version (learned from the additive `GET /plugins` field — the
  // entry's mtimeMs, the same value the backend loader uses) — the route
  // always serves current content and lets `v` pick the HTTP cache policy:
  // versioned URLs are immutable, unversioned requests revalidate.
  app.get("/plugins/:id/frontend", async (c) => {
    const id = c.req.param("id");
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    try {
      const result = await opts.pluginManagerService.frontendEntry(id, c.req.query("workspace"));
      if (!result.ok) {
        log.warn("plugins: frontend entry blocked", { id, reason: result.reason });
        return c.json({ error: "No frontend module for this plugin" }, 404);
      }
      log.info("plugins: frontend entry served", { id, bust: result.bust });
      const headers: Record<string, string> = {
        "Content-Type": "text/javascript; charset=utf-8",
      };
      if (c.req.query("v") !== undefined) {
        // The URL is content-versioned (v = entry mtimeMs) — safe to cache
        // for as long as the URL exists.
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else {
        headers["Cache-Control"] = "no-cache";
      }
      return new Response(result.code, { status: 200, headers });
    } catch (err) {
      log.error("plugins: frontend entry failure", { err, id });
      return c.json({ error: "Failed to read plugin frontend entry" }, 500);
    }
  });

  app.post("/plugins/scan", async (c) => {
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    try {
      const scan = await opts.pluginManagerService.scan();
      log.info("plugins: scan", {
        newPlugins: scan.newPlugins.length,
        invalid: scan.invalid.length,
        incompatible: scan.incompatible.length,
      });
      const body: PluginScanResponse = scan;
      return c.json(body, 200);
    } catch (err) {
      log.error("plugins: scan failure", { err });
      return c.json({ error: "Failed to scan plugins" }, 500);
    }
  });

  app.post("/plugins/:id/load", async (c) => {
    const id = c.req.param("id");
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    try {
      const result = await opts.pluginManagerService.load(id);
      const status = pluginOpStatus(result);
      if (!result.ok) log.warn("plugins: load blocked", { id, reason: result.reason });
      else log.info("plugins: loaded", { id });
      return c.json(result, status);
    } catch (err) {
      log.error("plugins: load failure", { err, id });
      return c.json({ error: "Failed to load plugin" }, 500);
    }
  });

  app.post("/plugins/:id/unload", async (c) => {
    const id = c.req.param("id");
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    const raw = await c.req.text();
    const parsed = parsePluginForceBody(raw);
    if (!parsed.ok) {
      log.warn("plugins: unload invalid body", { id, error: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }
    try {
      const result = await opts.pluginManagerService.unload(id, { force: parsed.force });
      const status = pluginOpStatus(result);
      if (!result.ok) log.warn("plugins: unload blocked", { id, reason: result.reason });
      else log.info("plugins: unloaded", { id, force: parsed.force });
      return c.json(result, status);
    } catch (err) {
      log.error("plugins: unload failure", { err, id });
      return c.json({ error: "Failed to unload plugin" }, 500);
    }
  });

  app.post("/plugins/:id/reload", async (c) => {
    const id = c.req.param("id");
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    const raw = await c.req.text();
    const parsed = parsePluginForceBody(raw);
    if (!parsed.ok) {
      log.warn("plugins: reload invalid body", { id, error: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }
    try {
      const result = await opts.pluginManagerService.reload(id, { force: parsed.force });
      const status = pluginOpStatus(result);
      if (!result.ok) log.warn("plugins: reload blocked", { id, reason: result.reason });
      else log.info("plugins: reloaded", { id, force: parsed.force });
      return c.json(result, status);
    } catch (err) {
      log.error("plugins: reload failure", { err, id });
      return c.json({ error: "Failed to reload plugin" }, 500);
    }
  });

  app.post("/plugins/:id/forget", async (c) => {
    const id = c.req.param("id");
    if (opts.pluginManagerService === undefined) {
      return c.json({ error: "Plugin manager service not available" }, 503);
    }
    try {
      const result = await opts.pluginManagerService.forget(id);
      if (result.ok) {
        log.info("plugins: forgot", {
          id,
          ...(result.clearedOverride ? { clearedOverride: true } : {}),
        });
      }
      const status = pluginOpStatus(result);
      return c.json(result, status);
    } catch (err) {
      log.error("plugins: forget failure", { err, id });
      return c.json({ error: "Failed to forget plugin" }, 500);
    }
  });
}
