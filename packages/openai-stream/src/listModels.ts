import type { ModelInfo } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";

/**
 * Generic OpenAI-compatible model-list fetch + mapping. Lives in this library
 * (`@dispatch/openai-stream`) so any OpenAI-compatible provider extension can
 * reuse it without cross-extension code import (isolation-over-DRY: coupling
 * is via this typed library surface, not a sibling's internals).
 *
 * A provider extension supplies its own `id` (used in error labels) via
 * `createOpenAICompatProvider({ id })`.
 */

interface OpenAIModelEntry {
  readonly id: string;
  readonly context_length?: number;
  readonly context_window?: number;
  readonly max_context_length?: number;
  readonly max_tokens?: number;
}

interface OpenAIModelListResponse {
  readonly data: readonly OpenAIModelEntry[];
}

/**
 * Pure mapping: raw OpenAI-compatible model list → ModelInfo[].
 * Extracts `contextWindow` from common field names (providers vary).
 * Extracted for direct unit testing with no I/O.
 */
export function parseModelList(data: readonly OpenAIModelEntry[]): readonly ModelInfo[] {
  return data.map((entry) => {
    const contextWindow =
      entry.context_length ?? entry.context_window ?? entry.max_context_length ?? entry.max_tokens;
    return {
      id: entry.id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  });
}

export interface ListModelsConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly fetchFn?: FetchLike;
  readonly providerId: string;
}

export async function listModels(config: ListModelsConfig): Promise<readonly ModelInfo[]> {
  const effectiveFetch: FetchLike = config.fetchFn ?? fetch;
  const url = `${config.baseURL}/models`;

  let response: Response;
  try {
    response = await effectiveFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  } catch (err) {
    throw new Error(
      `listModels[${config.providerId}]: network error — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`listModels[${config.providerId}]: HTTP ${response.status} — ${text}`);
  }

  const body = (await response.json()) as OpenAIModelListResponse;
  if (!Array.isArray(body.data)) {
    throw new Error(
      `listModels[${config.providerId}]: unexpected response shape — missing "data" array`,
    );
  }

  return parseModelList(body.data);
}
