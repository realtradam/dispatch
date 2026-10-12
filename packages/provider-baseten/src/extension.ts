import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import {
  BASETEN_AUTH_SCHEME,
  type EnvSource,
  resolveBasetenConfig,
  toBasetenCredentials,
} from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-baseten",
  name: "Baseten",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["baseten"] },
};

/**
 * Activate the Baseten provider. Reads `BASETEN_API_KEY` / `BASETEN_BASE_URL` /
 * `BASETEN_MODEL` from the environment (the imperative shell — at the edge) and
 * `provider.baseten.model` from host config, resolves the config via the pure
 * `resolveBasetenConfig`, then builds + registers the `"baseten"` provider
 * through `@dispatch/openai-stream`'s `createOpenAICompatProvider`.
 *
 * Baseten's Model APIs are OpenAI-compatible (Chat Completions), so no
 * `transformBody` is needed — the default chat-completions body is sent as-is.
 * Two deltas from the generic adapter:
 * - `authScheme: "Api-Key"` — Baseten authenticates with `Authorization:
 *   Api-Key <key>`, not `Bearer` (a Bearer header 401s).
 * - `getUsage: false` — Baseten documents no `/usage` `concurrent_sessions`
 *   endpoint, so the concurrency limiter must not poll one.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No `BASETEN_API_KEY` is a config state, not an error — warn + skip registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.baseten.model");
  const cfg = resolveBasetenConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-baseten: no BASETEN_API_KEY. Provider not registered.");
    return;
  }

  const credentials = toBasetenCredentials(cfg);

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "baseten",
    authScheme: BASETEN_AUTH_SCHEME,
    getUsage: false,
  });
  host.defineProvider(provider);
  host.logger.info(`provider-baseten: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
