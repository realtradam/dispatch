/**
 * tool-web-search extension — registers the `web_search` tool backed by a
 * self-hosted Firecrawl instance on activation.
 *
 * The base URL comes from `FIRECRAWL_BASE_URL` (env) with a Tailscale default.
 * Effects (`globalThis.fetch`) come from the ambient edge here, in the shell —
 * never in the pure core. Logging is left to the host via `host.logger`/`ctx.log`
 * (no `console.*`, no hand-rolled logger).
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createFirecrawlClient, DEFAULT_BASE_URL } from "./client.js";
import { createWebSearchTool } from "./tool.js";

export const manifest: Manifest = {
	id: "tool-web-search",
	name: "Web Search Tool",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	capabilities: { network: true },
	contributes: { tools: ["web_search"] },
};

export function activate(host: HostAPI): void {
	const baseUrl = process.env.FIRECRAWL_BASE_URL ?? DEFAULT_BASE_URL;
	const client = createFirecrawlClient({ baseUrl, fetchFn: globalThis.fetch });
	host.defineTool(createWebSearchTool({ client }));
}

export const extension: Extension = { manifest, activate };
