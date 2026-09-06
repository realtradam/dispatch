import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { type EnvSource, resolveHyperConfig, toHyperCredentials } from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-hyper",
  name: "Hyper",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["hyper"] },
};

/**
 * Activate the Hyper provider. Reads `HYPER_API_KEY` / `HYPER_BASE_URL` /
 * `HYPER_MODEL` from the environment (the imperative shell — at the edge) and
 * `provider.hyper.model` from host config, resolves the config via the pure
 * `resolveHyperConfig`, then builds + registers the `"hyper"` provider through
 * `@dispatch/openai-stream`'s `createOpenAICompatProvider`.
 *
 * Hyper is OpenAI-compatible (Chat Completions), so no `transformBody` is
 * needed — the default chat-completions body is sent as-is and Hyper applies
 * the selected model's default reasoning behavior (see the plan §4.4). The
 * provider passes `getUsage: false` because Hyper documents `/v1/credits`, not
 * the `/usage` `concurrent_sessions` shape the generic adapter polls — omitting
 * the method keeps the concurrency limiter's fallback (cooldown/local) honest.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No `HYPER_API_KEY` is a config state, not an error — warn + skip registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.hyper.model");
  const cfg = resolveHyperConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-hyper: no HYPER_API_KEY. Provider not registered.");
    return;
  }

  const credentials = toHyperCredentials(cfg);

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "hyper",
    getUsage: false,
  });
  host.defineProvider(provider);
  host.logger.info(`provider-hyper: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
