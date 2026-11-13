/**
 * The `firecrawl` search backend — a thin SearchBackend adapter over the
 * existing self-hosted Firecrawl client's `search`. Always configured
 * (keyless), so this is the zero-migration default backend.
 */

import type {
  SearchBackend,
  SearchParams,
  SearchResponse,
} from "@dispatch/search-backend-contract";
import type { FirecrawlClient } from "../client.js";

export const FIRECRAWL_BACKEND_ID = "firecrawl";
export const FIRECRAWL_BACKEND_LABEL = "Firecrawl (self-hosted)";

export function createFirecrawlSearchBackend(client: FirecrawlClient): SearchBackend {
  return {
    id: FIRECRAWL_BACKEND_ID,
    label: FIRECRAWL_BACKEND_LABEL,
    async search(params: SearchParams, signal: AbortSignal): Promise<SearchResponse> {
      return { hits: await client.search(params, signal) };
    },
  };
}
