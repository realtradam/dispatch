import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { transformBody } from "./reasoning.js";
import { type EnvSource, resolveCoralbricksConfig, toCoralbricksCredentials } from "./resolver.js";

export const manifest: Manifest = {
  id: "provider-coralbricks",
  name: "CoralBricks",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["coralbricks"] },
};

/**
 * Activate the CoralBricks provider. Reads `CORAL_API_KEY` / `CORAL_BASE_URL`
 * / `CORAL_MODEL` from the environment (the imperative shell — at the edge)
 * and `provider.coralbricks.model` from host config, resolves the config via
 * the pure `resolveCoralbricksConfig`, then builds + registers the
 * `"coralbricks"` provider through `@dispatch/openai-stream`'s
 * `createOpenAICompatProvider`.
 *
 * CoralBricks is OpenAI-compatible (Chat Completions at
 * `https://inference.coralbricks.ai/v1`), authenticating with the standard
 * `Authorization: Bearer <key>` scheme. Two deltas from the generic adapter:
 * - `transformBody` maps Dispatch's reasoning-effort ladder onto CoralBricks'
 *   `low` / `high` / `max` values.
 * - `getUsage: false` — CoralBricks documents no `/usage`
 *   `concurrent_sessions` endpoint, so the concurrency limiter must not poll
 *   one; it falls back to cooldown/local accounting.
 *
 * Model listing uses the generic `/models` fetch. CoralBricks' response
 * reports `context_length` and `supports_image_input`, both understood by
 * `@dispatch/openai-stream`'s `parseModelList`.
 *
 * `env` defaults to `process.env` and is a parameter only so tests can inject a
 * fake environment (faking the outermost edge) without mutating the real one.
 * No `CORAL_API_KEY` is a config state, not an error — warn + skip registration.
 */
export async function activate(host: HostAPI, env: EnvSource = process.env): Promise<void> {
  const configModel = host.config.get<string>("provider.coralbricks.model");
  const cfg = resolveCoralbricksConfig(env, configModel);
  if (!cfg) {
    host.logger.warn("provider-coralbricks: no CORAL_API_KEY. Provider not registered.");
    return;
  }

  const credentials = toCoralbricksCredentials(cfg);

  const provider = createOpenAICompatProvider({
    credentials,
    model: cfg.model,
    id: "coralbricks",
    transformBody,
    getUsage: false,
  });
  host.defineProvider(provider);
  host.logger.info(`provider-coralbricks: registered (model=${cfg.model})`);
}

export const extension: Extension = {
  manifest,
  activate,
};
