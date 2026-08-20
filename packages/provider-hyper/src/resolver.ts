import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://hyper.charm.land/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Resolved Hyper provider config — the API key plus the overridable base URL
 * and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface HyperConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Environment source for `resolveHyperConfig` — `process.env` (or a fake for
 * tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve Hyper provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-longcat` / `provider-umans`):
 * - `apiKey`: `HYPER_API_KEY` — unset/empty → `null` (caller warns + skips).
 *   Require only a NON-EMPTY value: the documented `sk-hyper-...` prefix is not
 *   enforced so future key formats and test keys remain valid. Never trim,
 *   print, persist, or validate by prefix.
 * - `baseURL`: `HYPER_BASE_URL` → `https://hyper.charm.land/v1`.
 * - `model`: `provider.hyper.model` (host config) → `HYPER_MODEL` →
 *   `deepseek-v4-flash`.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveHyperConfig(
  env: EnvSource,
  configModel: string | undefined,
): HyperConfig | null {
  const apiKey = env.HYPER_API_KEY;
  if (!apiKey) return null;
  const baseURL = env.HYPER_BASE_URL ?? DEFAULT_BASE_URL;
  const model = configModel ?? env.HYPER_MODEL ?? DEFAULT_MODEL;
  return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toHyperCredentials(cfg: HyperConfig): ApiKeyCredentials {
  return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}
