// Static file server for the built frontend (packages/frontend/dist).
// Uses Bun's built-in HTTP server — no extra runtime dependencies.
//
// Environment variables:
//   PORT     — port to listen on (default: 18391)
//   HOST     — interface to bind to (default: 0.0.0.0)
//   DIST_DIR — absolute path to the static assets directory
//              (default: <this-file's-dir>/dist)
//
// SPA fallback: requests that don't match a file on disk fall back to
// index.html so client-side routing works.

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = (() => {
	try {
		// @ts-expect-error — Bun provides import.meta.dir
		return import.meta.dir as string;
	} catch {
		return resolve(fileURLToPath(import.meta.url), "..");
	}
})();

const port = Number(process.env.PORT) || 18391;
const host = process.env.HOST || "0.0.0.0";
const distDir = resolve(process.env.DIST_DIR || join(moduleDir, "dist"));

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
	console.error(`[dispatch-frontend] dist directory not found: ${distDir}`);
	console.error(
		"[dispatch-frontend] Build the frontend first (bun run --cwd packages/frontend build)",
	);
	process.exit(1);
}

const indexPath = join(distDir, "index.html");

function safeResolve(urlPath: string): string | null {
	// Normalize and prevent path-traversal outside distDir.
	const decoded = decodeURIComponent(urlPath);
	const candidate = resolve(distDir, `.${normalize(decoded)}`);
	if (!candidate.startsWith(distDir)) return null;
	return candidate;
}

Bun.serve({
	port,
	hostname: host,
	async fetch(req) {
		const url = new URL(req.url);
		let pathname = url.pathname;
		if (pathname === "/" || pathname === "") pathname = "/index.html";

		const resolved = safeResolve(pathname);
		if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
			return new Response(Bun.file(resolved));
		}

		// SPA fallback — serve index.html for unknown routes
		return new Response(Bun.file(indexPath), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

console.log(`[dispatch-frontend] serving ${distDir} on http://${host}:${port}`);
