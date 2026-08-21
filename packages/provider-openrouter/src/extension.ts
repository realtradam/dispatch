import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { type EnvSource, resolveOpenRouterConfig, toOpenRouterCredentials } from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-openrouter",
  name: "OpenRouter",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["openrouter"] },
};

/**
 * Activate the OpenRouter provider. Reads `OPENROUTER_API_KEY` /
 * `OPENROUTER_BASE_URL` / `OPENROUTER_MODEL` from the environment (the
 * imperative shell — at the edge) and `provider.openrouter.model` from host
 * config, resolves the config via the pure `resolveOpenRouterConfig`, then
 * builds + registers the `"openrouter"` provider through
 * `@dispatch/openai-stream`'s `createOpenAICompatProvider`.
 *
 * OpenRouter is OpenAI-compatible (Chat Completions at
 * https://openrouter.ai/api/v1), so no `transformBody` is needed — the default
 * chat-completions body is sent as-is. The provider passes `getUsage: false`
 * because OpenRouter is a model router and documents no usable `/usage`
 * `concurrent_sessions` concurrency endpoint — omitting the method keeps the
 * concurrency limiter's fallback (cooldown/local) honest.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No `OPENROUTER_API_KEY` is a config state, not an error — warn + skip
 * registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.openrouter.model");
  const cfg = resolveOpenRouterConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-openrouter: no OPENROUTER_API_KEY. Provider not registered.");
    return;
  }

  const credentials = toOpenRouterCredentials(cfg);

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "openrouter",
    getUsage: false,
  });
  host.defineProvider(provider);
  host.logger.info(`provider-openrouter: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
