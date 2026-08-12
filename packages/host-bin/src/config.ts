import type { ConfigAccess } from "@dispatch/kernel";
import {
  OPENCODE_CREDENTIALS_CONFIG_KEY,
  parseNumberedOpenCodeEnv,
} from "@dispatch/provider-openai-compat";

export function envToConfigMap(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const map: Record<string, unknown> = {};

  // Numbered OpenCode credentials. DISPATCH_BASE_URL / DISPATCH_MODEL (if
  // present) are used as SHARED defaults for every numbered credential; the API
  // keys come exclusively from OPENCODE_API_KEY_<n>. There is NO legacy
  // DISPATCH_API_KEY path — it is entirely ignored.
  const baseURL = env.DISPATCH_BASE_URL;
  const model = env.DISPATCH_MODEL;
  const opencode = parseNumberedOpenCodeEnv(
    env,
    baseURL !== undefined || model !== undefined
      ? {
          ...(baseURL !== undefined ? { baseURL } : {}),
          ...(model !== undefined ? { model } : {}),
        }
      : {},
  );
  if (opencode.credentials.length > 0) {
    map[OPENCODE_CREDENTIALS_CONFIG_KEY] = opencode.credentials;
  }

  const anthropicModel = env.DISPATCH_ANTHROPIC_MODEL;
  if (anthropicModel !== undefined) {
    map["provider.anthropic.model"] = anthropicModel;
  }

  const claudeCredentialKey = env.DISPATCH_CLAUDE_CREDENTIAL_KEY;
  if (claudeCredentialKey !== undefined) {
    map["claude.credentialKey"] = claudeCredentialKey;
  }

  // Optional settings consumed by the external Codex (OpenAI subscription)
  // extension — mirrors the Claude/Anthropic pair above.
  const openaiModel = env.DISPATCH_OPENAI_MODEL;
  if (openaiModel !== undefined) {
    map["provider.openai.model"] = openaiModel;
  }

  const codexCredentialKey = env.DISPATCH_CODEX_CREDENTIAL_KEY;
  if (codexCredentialKey !== undefined) {
    map["codex.credentialKey"] = codexCredentialKey;
  }

  const httpPort = env.BACKEND_PORT ?? env.PORT;
  if (httpPort !== undefined) {
    const n = Number(httpPort);
    if (Number.isFinite(n) && n > 0) {
      map.httpPort = n;
    }
  }

  const surfaceWsPort = env.SURFACE_WS_PORT;
  if (surfaceWsPort !== undefined) {
    const n = Number(surfaceWsPort);
    if (Number.isFinite(n) && n > 0) {
      map.surfaceWsPort = n;
    }
  }

  return map;
}

export function configMapToAccess(map: Readonly<Record<string, unknown>>): ConfigAccess {
  return {
    get<T = unknown>(key: string): T | undefined {
      return map[key] as T | undefined;
    },
    getAll(): Readonly<Record<string, unknown>> {
      return map;
    },
  };
}
