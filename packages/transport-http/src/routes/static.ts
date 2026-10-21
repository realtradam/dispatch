import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts } = options;
  // ─── Static frontend serving (catch-all, API routes take precedence) ──────
  if (opts.webDir !== undefined) {
    const webDir = opts.webDir;
    const MIME: Record<string, string> = {
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".txt": "text/plain; charset=utf-8",
      ".wasm": "application/wasm",
    };
    app.get("*", async (c) => {
      const urlPath = new URL(c.req.url).pathname;
      const filePath = `${webDir}${urlPath}`;
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const ext = filePath.slice(filePath.lastIndexOf("."));
        const contentType = MIME[ext] ?? "application/octet-stream";
        return new Response(file, {
          headers: { "Content-Type": contentType },
        });
      }
      // SPA fallback: serve index.html for client-side routing
      const indexFile = Bun.file(`${webDir}/index.html`);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return c.json({ error: "Not found" }, 404);
    });
  }
}
