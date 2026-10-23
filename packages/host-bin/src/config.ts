import { dirname, resolve } from "node:path";
import type { ConfigAccess } from "@dispatch/kernel";
import {
  formatOpenCodeEnvDiagnostics,
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
  // DISPATCH_API_KEY path, and no silent-ignore of malformed/obsolete numbered
  // variables: ANY validation diagnostic ABORTS config assembly with a
  // secret-free fatal error so the process cannot boot with a partial or
  // invalid credential set.
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
  if (opencode.diagnostics.length > 0) {
    const detail =
      formatOpenCodeEnvDiagnostics(opencode.diagnostics) ?? "invalid OpenCode environment";
    throw new Error(`OpenCode configuration is invalid and will not be booted: ${detail}`);
  }
  if (opencode.credentials.length > 0) {
    map[OPENCODE_CREDENTIALS_CONFIG_KEY] = opencode.credentials;
  }

  // Expose both the canonical provider settings and the environment aliases
  // through host.config; API keys remain exclusively in host.secrets.
  for (const [alias, key] of [
    ["INCO_BASE_URL", "provider.inco.baseURL"],
    ["INCO_MODEL", "provider.inco.model"],
  ] as const) {
    const value = env[alias];
    if (value !== undefined) {
      map[key] = value;
      map[alias] = value;
    }
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

  // Plugin discovery root override (plan 04). The boot path resolves the
  // effective root via resolvePluginsDir (DISPATCH_PLUGINS_DIR → XDG_DATA_HOME
  // → ~/.local/share/dispatch/plugins); this key merely SURFACES the override
  // to extensions' ConfigAccess for parity with the other env-based config.
  if (env.DISPATCH_PLUGINS_DIR !== undefined) {
    map["plugins.dir"] = env.DISPATCH_PLUGINS_DIR;
  }

  map["vision.imageDir"] =
    env.DISPATCH_IMAGE_DIR !== undefined
      ? resolve(env.DISPATCH_IMAGE_DIR)
      : resolve(dirname(env.DISPATCH_DB ?? "./.dispatch-data/dispatch.db"), "images");
  const retention = env.DISPATCH_IMAGE_RETENTION_DAYS;
  if (retention !== undefined) {
    const days = Number(retention);
    if (retention.trim() === "" || !Number.isFinite(days) || days < 0)
      throw new Error("DISPATCH_IMAGE_RETENTION_DAYS must be a finite non-negative number");
    map["vision.imageRetentionDays"] = days;
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
