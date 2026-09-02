import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { type EnvSource, resolveLongcatConfig, toLongcatCredentials } from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-longcat",
  name: "LongCat AI",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["longcat"] },
};

/**
 * Activate the LongCat provider. Reads `LONGCAT_API_KEY` / `LONGCAT_BASE_URL` /
 * `LONGCAT_MODEL` from the environment (the imperative shell — at the edge) and
 * `provider.longcat.model` from host config, resolves the config via the pure
 * `resolveLongcatConfig`, then builds + registers the `"longcat"` provider
 * through `@dispatch/openai-stream`'s `createOpenAICompatProvider`.
 *
 * LongCat-2.0 is text-only (no vision) and fully OpenAI-compatible, so no
 * `transformBody` is needed — the default chat-completions body is sent as-is.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No `LONGCAT_API_KEY` is a config state, not an error — warn + skip registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.longcat.model");
  const cfg = resolveLongcatConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-longcat: no LONGCAT_API_KEY. Provider not registered.");
    return;
  }

  const credentials = toLongcatCredentials(cfg);

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "longcat",
  });
  host.defineProvider(provider);
  host.logger.info(`provider-longcat: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
