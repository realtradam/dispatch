/**
 * tool-web-search extension — registers the `web_search` tool backed by a
 * self-hosted Firecrawl instance on activation.
 *
 * The base URL comes from `FIRECRAWL_BASE_URL` (env) with a Tailscale default.
 * Effects (`globalThis.fetch`) come from the ambient edge here, in the shell —
 * never in the pure core. Logging is left to the host via `host.logger`/`ctx.log`
 * (no `console.*`, no hand-rolled logger).
 *
 * The tool's SEARCH mode resolves its backend per call from the GLOBAL
 * search config (`GET/PUT /search/config`, heartbeat-style StorageNamespace
 * persistence, default `"firecrawl"`): the always-configured `firecrawl`
 * backend plus the `umans` backend (the `/v1/messages` relay with the
 * server-side Exa web-search tool; listed as not configured without
 * `UMANS_API_KEY`), plus `"none"` (search off). Scrape/crawl always route to
 * the Firecrawl client regardless of the selection. The config service is
 * provided over a registry slot (`searchConfigServiceHandle`) so the HTTP
 * routes consume it reactively.
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createFirecrawlSearchBackend } from "./backends/firecrawl-backend.js";
import { createUmansSearchBackend } from "./backends/umans-backend.js";
import { createFirecrawlClient, DEFAULT_BASE_URL } from "./client.js";
import {
  createSearchConfigService,
  type RegisteredSearchBackend,
  searchConfigServiceHandle,
} from "./config/index.js";
import { createWebSearchTool } from "./tool.js";

export const manifest: Manifest = {
  id: "tool-web-search",
  name: "Web Search Tool",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { tools: ["web_search"], services: ["search-config"] },
};

export function activate(host: HostAPI): void {
  const baseUrl = process.env.FIRECRAWL_BASE_URL ?? DEFAULT_BASE_URL;
  const client = createFirecrawlClient({ baseUrl, fetchFn: globalThis.fetch });

  // Registry: firecrawl is always configured (keyless, self-hosted); umans
  // is registered only when its key resolves — a missing key is a config
  // state, not an error (mirrors provider-umans).
  const registry: RegisteredSearchBackend[] = [
    { backend: createFirecrawlSearchBackend(client), configured: true },
  ];
  const umansApiKey = process.env.UMANS_API_KEY;
  if (umansApiKey) {
    const umansModel = host.config.get<string>("search.umans.model");
    const umansMaxUses = host.config.get<number>("search.umans.max_uses");
    registry.push({
      backend: createUmansSearchBackend({
        apiKey: umansApiKey,
        baseUrl: process.env.UMANS_BASE_URL ?? "https://api.code.umans.ai/v1",
        // Config surface (all optional, all defaulted):
        // `search.umans.model` — the relay model (default umans-flash);
        // `search.umans.max_uses` — the per-request search cap.
        ...(umansModel !== undefined ? { model: umansModel } : {}),
        ...(umansMaxUses !== undefined ? { maxUses: umansMaxUses } : {}),
        fetchFn: globalThis.fetch,
      }),
      configured: true,
    });
  }

  const service = createSearchConfigService({ storage: host.storage("search-config"), registry });
  host.provideService(searchConfigServiceHandle, service);

  host.defineTool(
    createWebSearchTool({
      client,
      resolveSearchBackend: () => service.resolveBackend(),
    }),
  );
}

export const extension: Extension = { manifest, activate };
