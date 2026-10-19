import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://inference.coralbricks.ai/v1";
const DEFAULT_MODEL = "deepseek-v4.1-flash-fast";

/**
 * Resolved CoralBricks provider config — the API key plus the overridable base
 * URL and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface CoralbricksConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

/**
 * Environment source for `resolveCoralbricksConfig` — `process.env` (or a fake
 * for tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve CoralBricks provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-umans` / `provider-hyper`):
 * - `apiKey`: `CORAL_API_KEY` — unset/empty → `null` (caller warns + skips).
 *   CoralBricks documents this name in its own OpenCode integration. Require
 *   only a NON-EMPTY value: the documented `cb_...` prefix is not enforced so
 *   future key formats and test keys remain valid.
 * - `baseURL`: `CORAL_BASE_URL` → `https://inference.coralbricks.ai/v1`.
 * - `model`: `provider.coralbricks.model` (host config) → `CORAL_MODEL` →
 *   `deepseek-v4.1-flash-fast`.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveCoralbricksConfig(
  env: EnvSource,
  configModel: string | undefined,
): CoralbricksConfig | null {
  const apiKey = env.CORAL_API_KEY;
  if (!apiKey) return null;
  const baseURL = env.CORAL_BASE_URL ?? DEFAULT_BASE_URL;
  const model = configModel ?? env.CORAL_MODEL ?? DEFAULT_MODEL;
  return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toCoralbricksCredentials(cfg: CoralbricksConfig): ApiKeyCredentials {
  return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}
