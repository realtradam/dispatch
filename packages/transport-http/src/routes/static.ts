import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";

/**
 * `Cache-Control` for a static frontend response. `index.html` names the current
 * content-hashed bundle, so it must be revalidated on every load — otherwise a
 * browser keeps running an old frontend after an upgrade. Files under `/assets/`
 * are content-hashed and never change. Everything else is revalidated.
 */
export function staticCacheControl(urlPath: string, servedIndex: boolean): string {
  if (servedIndex || urlPath.endsWith(".html")) return "no-cache";
  return urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

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
          headers: {
            "Content-Type": contentType,
            "Cache-Control": staticCacheControl(urlPath, false),
          },
        });
      }
      // SPA fallback: serve index.html for client-side routing
      const indexFile = Bun.file(`${webDir}/index.html`);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": staticCacheControl(urlPath, true),
          },
        });
      }
      return c.json({ error: "Not found" }, 404);
    });
  }
}
