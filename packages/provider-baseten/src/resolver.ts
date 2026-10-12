import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://inference.baseten.co/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-Fast";

/**
 * Resolved Baseten provider config — the API key plus the overridable base URL
 * and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface BasetenConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Environment source for `resolveBasetenConfig` — `process.env` (or a fake for
 * tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve Baseten provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-longcat` / `provider-hyper`):
 * - `apiKey`: `BASETEN_API_KEY` — unset/empty → `null` (caller warns + skips).
 * - `baseURL`: `BASETEN_BASE_URL` → `https://inference.baseten.co/v1`.
 * - `model`: `provider.baseten.model` (host config) → `BASETEN_MODEL` → `deepseek-ai/DeepSeek-V4.1-Flash-Fast`.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveBasetenConfig(
  env: EnvSource,
  configModel: string | undefined,
): BasetenConfig | null {
  const apiKey = env.BASETEN_API_KEY;
  if (!apiKey) return null;
  const baseURL = env.BASETEN_BASE_URL ?? DEFAULT_BASE_URL;
  const model = configModel ?? env.BASETEN_MODEL ?? DEFAULT_MODEL;
  return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toBasetenCredentials(cfg: BasetenConfig): ApiKeyCredentials {
  return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}

/**
 * Baseten's authorization scheme: it expects `Authorization: Api-Key <key>`,
 * NOT the standard `Bearer` scheme (a Bearer header is rejected with 401).
 * Threaded into `createOpenAICompatProvider({ authScheme })`.
 */
export const BASETEN_AUTH_SCHEME = "Api-Key";
