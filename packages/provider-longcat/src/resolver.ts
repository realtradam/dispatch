import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://api.longcat.chat/openai";
const DEFAULT_MODEL = "LongCat-2.0";

/**
 * Resolved LongCat provider config — the API key plus the overridable base URL
 * and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface LongcatConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Environment source for `resolveLongcatConfig` — `process.env` (or a fake for
 * tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve LongCat provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-openai-compat` / `provider-umans`):
 * - `apiKey`: `LONGCAT_API_KEY` — unset/empty → `null` (caller warns + skips).
 * - `baseURL`: `LONGCAT_BASE_URL` → `https://api.longcat.chat/openai`.
 * - `model`: `provider.longcat.model` (host config) → `LONGCAT_MODEL` → `LongCat-2.0`.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveLongcatConfig(
  env: EnvSource,
  configModel: string | undefined,
): LongcatConfig | null {
  const apiKey = env.LONGCAT_API_KEY;
  if (!apiKey) return null;
  const baseURL = env.LONGCAT_BASE_URL ?? DEFAULT_BASE_URL;
  const model = configModel ?? env.LONGCAT_MODEL ?? DEFAULT_MODEL;
  return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toLongcatCredentials(cfg: LongcatConfig): ApiKeyCredentials {
  return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}
