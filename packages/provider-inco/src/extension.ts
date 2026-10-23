import type { Extension, Manifest, ProviderContract } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { type IncoModelInfo, parseIncoModels } from "./catalog.js";
import { mapIncoReasoningEffort, resolveIncoConfig } from "./config.js";
import { captureIncoFetch, type IncoFetch, redactIncoText } from "./logging.js";

export const manifest = {
  id: "provider-inco",
  name: "Inco",
  version: "0.1.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  contributes: { providers: ["inco"] },
  capabilities: { network: true, secrets: true },
} as const satisfies Manifest;

export interface IncoExtensionOptions {
  /** Only the outer network edge is injectable; defaults to real fetch at activation. */
  readonly fetchFn?: IncoFetch;
}

export function createIncoExtension(options: IncoExtensionOptions = {}): Extension {
  return {
    manifest,
    async activate(host) {
      const config = resolveIncoConfig({
        apiKey: await host.secrets.get("INCO_API_KEY"),
        baseURL: host.config.get<string>("provider.inco.baseURL") ?? null,
        model: host.config.get<string>("provider.inco.model") ?? null,
        envBaseURL: host.config.get<string>("INCO_BASE_URL") ?? null,
        envModel: host.config.get<string>("INCO_MODEL") ?? null,
      });
      if (!config) return;
      const fetchFn: IncoFetch =
        options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
      // Instance-local snapshot, replaced only after a successful catalog response.
      let models: readonly IncoModelInfo[] = [];
      const listModels = async () => {
        const response = await captureIncoFetch(
          fetchFn,
          host.logger,
          config.apiKey,
        )(`${config.baseURL}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
        if (!response.ok) {
          // Drain for the edge trace, but never embed possibly secret upstream bodies in errors.
          await response.text();
          throw new Error(`inco: models request failed (HTTP ${response.status})`);
        }
        const parsed = parseIncoModels(await response.json());
        models = parsed;
        return parsed;
      };
      const provider: ProviderContract = {
        id: "inco",
        listModels,
        async *stream(messages, tools, opts = {}) {
          const { logger = host.logger, ...streamOpts } = opts;
          const compat = createOpenAICompatProvider({
            id: "inco",
            credentials: { type: "api-key", apiKey: config.apiKey, baseURL: config.baseURL },
            model: config.model,
            fetchFn: captureIncoFetch(fetchFn, logger, config.apiKey),
            getUsage: false,
            transformBody(_body, request) {
              const model = request.model ?? config.model;
              const supported = models.find((entry) => entry.id === model)?.reasoningEffort;
              const effort = mapIncoReasoningEffort(model, request.reasoningEffort, supported);
              return effort === undefined ? {} : { reasoning_effort: effort };
            },
          });
          for await (const event of compat.stream(messages, tools, streamOpts)) {
            if (opts.signal?.aborted) return;
            yield event.type === "error"
              ? { ...event, message: redactIncoText(event.message, config.apiKey) }
              : event;
          }
        },
      };
      host.defineProvider(provider);
    },
    // Providers have no disposer; the host owns their removal on unload.
  };
}
