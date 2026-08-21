import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openrouter/meta-llama/llama-3.1-8b-instruct:free";

/**
 * Resolved OpenRouter provider config — the API key plus the overridable base
 * URL and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface OpenRouterConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Environment source for `resolveOpenRouterConfig` — `process.env` (or a fake
 * for tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve OpenRouter provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-longcat` / `provider-umans` / `provider-hyper`):
 * - `apiKey`: `OPENROUTER_API_KEY` — unset/empty → `null` (caller warns +
 *   skips). Require only a NON-EMPTY value: the documented `sk-or-v1-...`
 *   prefix is not enforced so future key formats and test keys remain valid.
 *   Never trim, print, persist, or validate by prefix.
 * - `baseURL`: `OPENROUTER_BASE_URL` → `https://openrouter.ai/api/v1`.
 * - `model`: `provider.openrouter.model` (host config) → `OPENROUTER_MODEL` →
 *   the default OpenRouter free model.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveOpenRouterConfig(
  env: EnvSource,
  configModel: string | undefined,
): OpenRouterConfig | null {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const baseURL = env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
  const model = configModel ?? env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toOpenRouterCredentials(cfg: OpenRouterConfig): ApiKeyCredentials {
  return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}
