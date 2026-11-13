/**
 * tool-web-search extension — registers the `web_search` tool backed by a
 * self-hosted Firecrawl instance on activation.
 *
 * Scrape and crawl ALWAYS route to the Firecrawl client (`FIRECRAWL_BASE_URL`,
 * loopback default). SEARCH mode resolves its backend per call from the GLOBAL
 * search config (`GET/PUT /search/config`): backends are contributed by
 * extensions into the `search/backend-registry` service this extension
 * provides, and this extension registers the always-available `firecrawl`
 * backend into it. With no explicit selection, automatic mode prefers
 * `claude`, then `codex`, then `firecrawl` (`DEFAULT_SEARCH_BACKEND_ORDER`).
 * `"none"` disables search (a clean `isError` result) while scrape/crawl keep
 * working.
 *
 * The config service (`searchConfigServiceHandle`) and the registry
 * (`searchBackendRegistryHandle`) are provided over reactive service slots so
 * the HTTP routes and provider extensions consume them. Effects
 * (`globalThis.fetch`) come from the ambient edge here, in the shell — never in
 * the pure core. Logging is left to the host (`host.logger`/`ctx.log`).
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { searchBackendRegistryHandle } from "@dispatch/search-backend-contract";
import { createFirecrawlSearchBackend } from "./backends/firecrawl-backend.js";
import { createSearchBackendRegistry } from "./backends/registry.js";
import { createFirecrawlClient, DEFAULT_BASE_URL } from "./client.js";
import { createSearchConfigService, searchConfigServiceHandle } from "./config/index.js";
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
  contributes: { tools: ["web_search"], services: ["search-config", "search/backend-registry"] },
};

let disposers: Array<() => void> = [];

export function activate(host: HostAPI): void {
  const baseUrl = process.env.FIRECRAWL_BASE_URL ?? DEFAULT_BASE_URL;
  const client = createFirecrawlClient({ baseUrl, fetchFn: globalThis.fetch });

  // The registry owns the backend list; firecrawl is always registered here
  // (keyless, self-hosted). Other extensions register claude/codex reactively
  // through the provided service handle.
  const instance = createSearchBackendRegistry();
  instance.registry.register(createFirecrawlSearchBackend(client));

  const service = createSearchConfigService({
    storage: host.storage("search-config"),
    listBackends: instance.list,
  });

  disposers = [
    host.provideService(searchConfigServiceHandle, service),
    host.provideService(searchBackendRegistryHandle, instance.registry),
  ];

  host.defineTool(
    createWebSearchTool({
      client,
      resolveSearchBackend: () => service.resolveBackend(),
    }),
  );
}

export function deactivate(): void {
  for (const dispose of disposers) {
    dispose();
  }
  disposers = [];
}

export const extension: Extension = { manifest, activate, deactivate };
