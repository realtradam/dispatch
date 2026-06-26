import type { ConfigAccess } from "@dispatch/kernel";

export function envToConfigMap(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const map: Record<string, unknown> = {};

  const apiKey = env.DISPATCH_API_KEY;
  if (apiKey !== undefined) {
    map["provider.openai-compat.apiKey"] = apiKey;
  }

  const baseURL = env.DISPATCH_BASE_URL;
  if (baseURL !== undefined) {
    map["provider.openai-compat.baseURL"] = baseURL;
  }

  const model = env.DISPATCH_MODEL;
  if (model !== undefined) {
    map["provider.openai-compat.model"] = model;
  }

  // Optional settings consumed by external extensions (e.g. the Claude provider).
  const anthropicModel = env.DISPATCH_ANTHROPIC_MODEL;
  if (anthropicModel !== undefined) {
    map["provider.anthropic.model"] = anthropicModel;
  }

  const claudeCredentialKey = env.DISPATCH_CLAUDE_CREDENTIAL_KEY;
  if (claudeCredentialKey !== undefined) {
    map["claude.credentialKey"] = claudeCredentialKey;
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
