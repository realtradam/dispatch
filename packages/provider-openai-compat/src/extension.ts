import type { ApiKeyCredentials, Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "@dispatch/openai-stream";
import type { OpenCodeNumberedCredential } from "./opencode-config.js";

export const manifest: Manifest = {
  id: "provider-openai-compat",
  name: "OpenAI-Compatible Provider",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { providers: ["opencode"] },
};

/**
 * Configuration key under which host-bin exposes the parsed numbered OpenCode
 * credentials to this extension. The value is an array of
 * {@link OpenCodeNumberedCredential} sorted numerically ascending, each with
 * its OWN apiKey/baseURL/model. Absent/empty → no OpenCode providers register
 * (OpenCode simply unavailable).
 */
export const OPENCODE_CREDENTIALS_CONFIG_KEY = "opencode.credentials";

export async function activate(host: HostAPI): Promise<void> {
  const creds = host.config.get<OpenCodeNumberedCredential[] | undefined>(
    OPENCODE_CREDENTIALS_CONFIG_KEY,
  );

  if (creds === undefined || creds.length === 0) {
    host.logger.info(
      "provider-openai-compat: no numbered OpenCode credentials configured. OpenCode provider not registered.",
    );
    return;
  }

  let registered = 0;
  for (const entry of creds) {
    const id = `opencode-${entry.number}`;
    const credentials: ApiKeyCredentials = {
      type: "api-key",
      apiKey: entry.apiKey,
      baseURL: entry.baseURL,
    };
    const provider = createOpenAICompatProvider({
      credentials,
      model: entry.model,
      id,
    });
    host.defineProvider(provider);
    registered++;
    // Log only the NUMBER + model — never the secret key.
    host.logger.info(
      `provider-openai-compat: registered numbered OpenCode provider "${id}" (model=${entry.model})`,
    );
  }

  host.logger.info(
    `provider-openai-compat: registered ${registered} numbered OpenCode provider(s)`,
  );
}

export const extension: Extension = {
  manifest,
  activate,
};
