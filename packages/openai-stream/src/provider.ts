import type {
  ApiKeyCredentials,
  ChatMessage,
  ModelInfo,
  ProviderContract,
  ProviderStreamOptions,
  ProviderUsage,
  ToolContract,
} from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";
import { getUsage as fetchUsage } from "./getUsage.js";
import { listModels as fetchModels } from "./listModels.js";
import { streamChat } from "./stream.js";

/**
 * Generic factory for an OpenAI-compatible provider. A provider extension
 * supplies its own `id` (stamped on the ProviderContract + used in listModels
 * error labels) and an optional `transformBody` hook to add provider-specific
 * body fields (e.g. `reasoning_effort`) before the request is sent. The library
 * names no concrete feature — those knobs belong to the extension layer.
 */

export interface CreateOpenAICompatProviderOpts {
  readonly credentials: ApiKeyCredentials;
  readonly model: string;
  /** Provider id (was hardcoded "openai-compat"). Stamped on the ProviderContract.id
   *  + used in listModels error labels. */
  readonly id: string;
  /**
   * Internal injectable fetch — used by tests and replay mode.
   * When absent, falls back to globalThis.fetch (production default).
   */
  readonly fetchFn?: FetchLike;
  /**
   * Optional hook a provider extension uses to add provider-specific body fields (e.g.
   * `reasoning_effort`) before the request is sent. Receives the body built so far +
   * the ProviderStreamOptions; returns ADDITIONAL fields to merge (or the full body).
   * Default (absent): no extra fields. Generic — the library names no feature.
   */
  readonly transformBody?: (
    body: Record<string, unknown>,
    opts: ProviderStreamOptions,
  ) => Record<string, unknown>;
  /**
   * Optional custom model-list implementation, overriding the default
   * OpenAI-compatible `/models` fetch. A provider extension supplies this to read
   * a richer model-capability endpoint (e.g. the Umans provider reads
   * `/models/info` for real `supports_vision`). When absent, the generic `/models`
   * fetch (with the name-based vision fallback) is used — so other providers
   * (openai-compat, longcat) keep their existing behavior unchanged.
   */
  readonly listModels?: () => Promise<readonly ModelInfo[]>;
  /**
   * Set `false` to OMIT the `getUsage` method entirely from the returned
   * `ProviderContract`. Providers that document no usable upstream concurrency
   * endpoint (e.g. Hyper documents `/v1/credits`, not the `/usage`
   * `concurrent_sessions` shape) pass `false` so the concurrency limiter never
   * polls a pointless authenticated endpoint. Default (absent / `true`):
   * include the generic `/usage` implementation for all existing providers,
   * preserving current behavior.
   */
  readonly getUsage?: boolean;
  /**
   * Authorization scheme prefix sent as `Authorization: <authScheme> <apiKey>`.
   * Default (absent): `"Bearer"`. Providers with a non-standard scheme (e.g.
   * Baseten's `Api-Key`) override it. Generic — the library names no feature.
   */
  readonly authScheme?: string;
}

export function createOpenAICompatProvider(opts: CreateOpenAICompatProviderOpts): ProviderContract {
  const baseURL = opts.credentials.baseURL ?? "https://opencode.ai/zen/go/v1";
  const apiKey = opts.credentials.apiKey;
  const fetchFn = opts.fetchFn;
  const transformBody = opts.transformBody;
  const authScheme = opts.authScheme;
  const authOpt = authScheme !== undefined ? { authScheme } : {};

  const streamConfig = {
    baseURL,
    apiKey,
    model: opts.model,
    ...(fetchFn !== undefined ? { fetchFn } : {}),
    ...(transformBody !== undefined ? { transformBody } : {}),
    ...authOpt,
  };

  return {
    id: opts.id,
    stream: (
      messages: readonly ChatMessage[],
      tools: readonly ToolContract[],
      streamOpts?: ProviderStreamOptions,
    ) => streamChat(streamConfig, messages, tools, streamOpts),
    listModels: (): Promise<readonly ModelInfo[]> =>
      opts.listModels !== undefined
        ? opts.listModels()
        : fetchModels({
            baseURL,
            apiKey,
            providerId: opts.id,
            ...(fetchFn !== undefined ? { fetchFn } : {}),
            ...authOpt,
          }),
    ...(opts.getUsage !== false
      ? {
          getUsage: (): Promise<ProviderUsage | undefined> =>
            fetchUsage({
              baseURL,
              apiKey,
              providerId: opts.id,
              ...(fetchFn !== undefined ? { fetchFn } : {}),
              ...authOpt,
            }),
        }
      : {}),
  };
}
