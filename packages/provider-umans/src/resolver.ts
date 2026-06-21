import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://api.code.umans.ai/v1";
const DEFAULT_MODEL = "umans-coder";

/**
 * Resolved Umans provider config — the API key plus the overridable base URL
 * and model that `activate` threads into `createOpenAICompatProvider`.
 */
export interface UmansConfig {
	readonly apiKey: string;
	readonly baseURL: string;
	readonly model: string;
}

/**
 * Environment source for `resolveUmansConfig` — `process.env` (or a fake for
 * tests). Matches the canonical `Readonly<Record<string, string | undefined>>`
 * env view used across the codebase.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve Umans provider config from the environment + the host config.
 *
 * Precedence (mirrors `provider-openai-compat`):
 * - `apiKey`: `UMANS_API_KEY` — unset/empty → `null` (caller warns + skips).
 * - `baseURL`: `UMANS_BASE_URL` → `https://api.code.umans.ai/v1`.
 * - `model`: `provider.umans.model` (host config) → `UMANS_MODEL` → `umans-coder`.
 *
 * Pure: the decision logic `activate` delegates to, factored out for direct
 * unit testing with zero mocks.
 */
export function resolveUmansConfig(
	env: EnvSource,
	configModel: string | undefined,
): UmansConfig | null {
	const apiKey = env.UMANS_API_KEY;
	if (!apiKey) return null;
	const baseURL = env.UMANS_BASE_URL ?? DEFAULT_BASE_URL;
	const model = configModel ?? env.UMANS_MODEL ?? DEFAULT_MODEL;
	return { apiKey, baseURL, model };
}

/**
 * Build the `ApiKeyCredentials` the `@dispatch/openai-stream` library expects
 * — `baseURL` on the credential so it is overridable per-credential.
 */
export function toUmansCredentials(cfg: UmansConfig): ApiKeyCredentials {
	return { type: "api-key", apiKey: cfg.apiKey, baseURL: cfg.baseURL };
}
