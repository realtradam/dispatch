import type { ApiKeyCredentials, Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider, listUmansModels } from "@dispatch/openai-stream";
import { transformBody } from "./reasoning.js";
import { type EnvSource, resolveUmansConfig } from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-umans",
  name: "Umans AI Coding Plan",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["umans"] },
};

/**
 * Activate the Umans provider. Reads `UMANS_API_KEY` / `UMANS_BASE_URL` /
 * `UMANS_MODEL` from the environment (the imperative shell — at the edge) and
 * `provider.umans.model` from host config, resolves the config via the pure
 * `resolveUmansConfig`, then builds + registers the `"umans"` provider through
 * `@dispatch/openai-stream`'s `createOpenAICompatProvider`. Model listing reads
 * the real `/v1/models/info` endpoint (`listUmansModels`) so `ModelInfo.vision`
 * reflects each model's true `supports_vision` capability (true / false /
 * via-handoff) rather than a name guess.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No `UMANS_API_KEY` is a config state, not an error — warn + skip registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.umans.model");
  const cfg = resolveUmansConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-umans: no UMANS_API_KEY. Provider not registered.");
    return;
  }

  const credentials: ApiKeyCredentials = {
    type: "api-key",
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
  };

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "umans",
    transformBody,
    // Umans reads the REAL /v1/models/info endpoint for per-model capability
    // metadata (supports_vision + context_window), overriding the generic
    // /models fetch (whose name-based vision guess would miss e.g. umans-flash
    // and umans-coder). Kept as a custom value so other OpenAI-compat providers
    // are unaffected.
    listModels: () =>
      listUmansModels({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        providerId: "umans",
      }),
  });
  host.defineProvider(provider);
  host.logger.info(`provider-umans: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
