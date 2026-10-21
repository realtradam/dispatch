import { resolve, sep } from "node:path";
import type { Hono } from "hono";
import {
  isLocalImageRequestError,
  matchesImageMagicBytes,
  parseLocalImageRequest,
} from "../logic.js";
import type { RouteOptions } from "../route-options.js";

export function mount(app: Hono, { config }: RouteOptions): void {
  // Snapshot at mount, not per request (also stabilizes embedded relative roots).
  const imageDir = config.imageDir === undefined ? undefined : resolve(config.imageDir);
  // ── Durable image serving (vision handoff) ──────────────────────────────────────
  app.get("/images/:conversationId/:imageId", async (c) => {
    const conversationId = c.req.param("conversationId");
    const imageId = c.req.param("imageId");
    if (!/^[A-Za-z0-9_-]{1,128}\.(png|jpe?g|webp|gif|bmp)$/.test(imageId)) {
      return c.json({ error: "Invalid image ID" }, 400);
    }
    if (imageDir === undefined) return c.json({ error: "Image not found" }, 404);
    // Local defense in depth: transport-http is core, vision-handoff is standard.
    // Keep this pure path policy local instead of adding a cross-tier dependency.
    const containedPath = (root: string, ...segments: string[]): string | null => {
      if (segments.some((segment) => segment.includes("%") || segment.includes("\0"))) return null;
      const base = resolve(root);
      const path = resolve(base, ...segments);
      const prefix = base.endsWith(sep) ? base : base + sep;
      return path === base || path.startsWith(prefix) ? path : null;
    };
    const filePath = containedPath(imageDir, conversationId, imageId);
    if (filePath === null) return c.json({ error: "Invalid image path" }, 400);
    const { readFile: fsReadFile } = await import("node:fs/promises");
    try {
      const buf = await fsReadFile(filePath);
      const ext = imageId.toLowerCase();
      const mime = ext.endsWith(".png")
        ? "image/png"
        : ext.endsWith(".jpg") || ext.endsWith(".jpeg")
          ? "image/jpeg"
          : ext.endsWith(".webp")
            ? "image/webp"
            : ext.endsWith(".gif")
              ? "image/gif"
              : ext.endsWith(".bmp")
                ? "image/bmp"
                : "application/octet-stream";
      return new Response(buf, { headers: { "Content-Type": mime, "Cache-Control": "no-cache" } });
    } catch {
      return c.json({ error: "Image not found" }, 404);
    }
  });

  // ── Local image serving (Markdown image embedding) ─────────────────────────
  // The chat UI rewrites local Markdown image srcs (`![alt](/abs/pic.png)`) to
  // this route. It intentionally serves ANY absolute image path (the agent
  // already has filesystem access to the same machine); the raster extension
  // whitelist + magic-byte sniff bound the response to actual image files.
  // SVG is excluded deliberately (script-bearing XML is an XSS vector).
  app.get("/local-image", async (c) => {
    const { homedir } = await import("node:os");
    const request = parseLocalImageRequest(c.req.query("path"), homedir());
    if (isLocalImageRequestError(request)) {
      return c.json({ error: request.error }, 400);
    }
    const { open, stat } = await import("node:fs/promises");
    const maxImageBytes = 25 * 1024 * 1024;
    let header: Uint8Array;
    try {
      const info = await stat(request.path);
      if (!info.isFile()) {
        return c.json({ error: "Image must be a regular file" }, 400);
      }
      if (info.size > maxImageBytes) {
        return c.json({ error: "Image exceeds the 25 MiB size limit" }, 413);
      }
      const file = await open(request.path, "r");
      try {
        const buffer = new Uint8Array(16);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        header = buffer.subarray(0, length);
      } finally {
        await file.close();
      }
    } catch {
      return c.json({ error: "Image not found" }, 404);
    }
    if (!matchesImageMagicBytes(header, request.extension)) {
      return c.json({ error: "File content does not match the image format" }, 400);
    }
    return new Response(Bun.file(request.path), {
      headers: {
        "Content-Type": request.mime,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
