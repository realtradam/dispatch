import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { type EnvSource, resolveSystalyzeConfig, toSystalyzeCredentials } from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-systalyze",
  name: "Systalyze",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["systalyze"] },
};

/**
 * Activate the Systalyze provider. Reads `SYSTALYZE_API_KEY` (fallback
 * `STLZ_API_KEY`) / `SYSTALYZE_BASE_URL` / `SYSTALYZE_MODEL` from the
 * environment (the imperative shell — at the edge) and `provider.systalyze.model`
 * from host config, resolves the config via the pure `resolveSystalyzeConfig`,
 * then builds + registers the `"systalyze"` provider through
 * `@dispatch/openai-stream`'s `createOpenAICompatProvider`.
 *
 * Systalyze is OpenAI-compatible (Chat Completions), so no `transformBody` is
 * needed — the default chat-completions body is sent as-is. Reasoning deltas
 * arriving under the non-standard `delta.reasoning` field are handled
 * generically by the shared SSE parser (alias fallback for
 * `reasoning_content`), not here. The provider passes `getUsage: false`
 * because Systalyze's `/v1/usage` route returns 404 (unknown route) — the
 * generic adapter must not poll it; omitting the method keeps the concurrency
 * limiter's fallback (cooldown/local) honest.
 *
 * Note: Systalyze's streaming endpoint ignores `stream_options.include_usage`
 * (verified live — no final usage chunk is emitted; only the non-streaming
 * route returns `usage`). Token counts may therefore be absent for this
 * provider's turns; the kernel handles a missing `usage` event normally.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No key is a config state, not an error — warn + skip registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.systalyze.model");
  const cfg = resolveSystalyzeConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-systalyze: no SYSTALYZE_API_KEY. Provider not registered.");
    return;
  }

  const credentials = toSystalyzeCredentials(cfg);

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "systalyze",
    getUsage: false,
  });
  host.defineProvider(provider);
  host.logger.info(`provider-systalyze: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
