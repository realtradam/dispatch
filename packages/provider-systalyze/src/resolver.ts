import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://inference.systalyze.com/v1";
const DEFAULT_MODEL = "moonshotai/Kimi-K3";

/**
 * Resolved Systalyze provider config — the API key plus the overridable base
 * URL and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface SystalyzeConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Environment source for `resolveSystalyzeConfig` — `process.env` (or a fake
 * for tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve Systalyze provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-hyper` / `provider-coralbricks`):
 * - `apiKey`: `SYSTALYZE_API_KEY`, falling back to `STLZ_API_KEY` — the name
 *   the vendor's own docs/examples use. Both unset/empty → `null` (caller
 *   warns + skips). Require only a NON-EMPTY value: the documented `stlzi_...`
 *   prefix is not enforced so future key formats and test keys remain valid.
 *   Never trim, print, persist, or validate by prefix.
 * - `baseURL`: `SYSTALYZE_BASE_URL` → `https://inference.systalyze.com/v1`.
 * - `model`: `provider.systalyze.model` (host config) → `SYSTALYZE_MODEL` →
 *   `moonshotai/Kimi-K3`.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveSystalyzeConfig(
  env: EnvSource,
  configModel: string | undefined,
): SystalyzeConfig | null {
  const apiKey = env.SYSTALYZE_API_KEY || env.STLZ_API_KEY;
  if (!apiKey) return null;
  const baseURL = env.SYSTALYZE_BASE_URL ?? DEFAULT_BASE_URL;
  const model = configModel ?? env.SYSTALYZE_MODEL ?? DEFAULT_MODEL;
  return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toSystalyzeCredentials(cfg: SystalyzeConfig): ApiKeyCredentials {
  return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}
