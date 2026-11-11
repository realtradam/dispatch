import type { ApiKeyCredentials, Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import { OPENCODE_PROVIDER_ID, type OpenCodeCredential } from "./opencode-config.js";
import { buildOpenCodeRequestHeaders } from "./opencode-headers.js";

export const manifest: Manifest = {
  id: "provider-openai-compat",
  name: "OpenAI-Compatible Provider",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "providers",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: [OPENCODE_PROVIDER_ID] },
};

/**
 * Configuration key under which host-bin exposes the parsed OpenCode
 * credential to this extension. The value is a single
 * {@link OpenCodeCredential} (apiKey/baseURL/model). Absent → no OpenCode
 * provider registers (OpenCode simply unavailable).
 */
export const OPENCODE_CREDENTIAL_CONFIG_KEY = "opencode.credential";

export async function activate(host: HostAPI): Promise<void> {
  const entry = host.config.get<OpenCodeCredential | undefined>(OPENCODE_CREDENTIAL_CONFIG_KEY);

  if (entry === undefined) {
    host.logger.info(
      "provider-openai-compat: no OpenCode credential configured. OpenCode provider not registered.",
    );
    return;
  }

  const credentials: ApiKeyCredentials = {
    type: "api-key",
    apiKey: entry.apiKey,
    baseURL: entry.baseURL,
  };
  // OpenCode Go rejects inference requests without a session id. Each request
  // uses its conversation id; this per-activation id covers the rest (requests
  // made outside a conversation), so the header is never missing.
  const fallbackSessionId = crypto.randomUUID();
  const provider = createOpenAICompatProvider({
    credentials,
    model: entry.model,
    id: OPENCODE_PROVIDER_ID,
    requestHeaders: (opts) => buildOpenCodeRequestHeaders(opts.conversationId, fallbackSessionId),
  });
  host.defineProvider(provider);
  // Log only the provider id + model — never the secret key.
  host.logger.info(
    `provider-openai-compat: registered OpenCode provider "${OPENCODE_PROVIDER_ID}" (model=${entry.model})`,
  );
}

export const extension: Extension = {
  manifest,
  activate,
};
