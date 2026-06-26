/**
 * PURE config resolution — resolve MCP server configurations.
 *
 * Sources, in precedence order:
 * 1. cwd/.dispatch/mcp.json servers
 * 2. fallback cwd/opencode.json mcp key
 *
 * No I/O — callers pass the file contents as strings.
 */

import type { McpServerConfig, ResolvedMcpServer, ResolveResult } from "./types.js";

export interface ResolveServersDeps {
  readonly dispatchMcpJson: string | null;
  readonly opencodeJson: string | null;
}

export interface DispatchMcpConfig {
  readonly servers?: Readonly<Record<string, McpServerConfig>>;
}

export interface OpencodeJsonConfig {
  readonly mcp?: Readonly<Record<string, McpServerConfig>>;
}

export function resolveServers(deps: ResolveServersDeps): ResolveResult {
  const result = new Map<string, ResolvedMcpServer>();

  // Parse opencode.json once — used both as the fallback source and to detect
  // whether a present `.dispatch/mcp.json` silently shadows its `mcp` key.
  let opencodeConfig: OpencodeJsonConfig | null = null;
  if (deps.opencodeJson) {
    try {
      opencodeConfig = JSON.parse(deps.opencodeJson) as OpencodeJsonConfig;
    } catch {
      // ignore parse errors
    }
  }
  const opencodeHasMcp = !!opencodeConfig?.mcp && Object.keys(opencodeConfig.mcp).length > 0;

  // 1. cwd/.dispatch/mcp.json (highest precedence)
  let dispatchHadServers = false;
  if (deps.dispatchMcpJson) {
    try {
      const config = JSON.parse(deps.dispatchMcpJson) as DispatchMcpConfig;
      if (config.servers) {
        for (const [key, server] of Object.entries(config.servers)) {
          const resolved = resolveServer(key, server, ".dispatch/mcp.json");
          result.set(resolved.id, resolved);
        }
        dispatchHadServers = result.size > 0;
      }
    } catch {
      // ignore parse errors
    }
  }

  // 2. fallback cwd/opencode.json mcp key (only when dispatch yielded nothing)
  if (result.size === 0 && opencodeConfig?.mcp) {
    for (const [key, server] of Object.entries(opencodeConfig.mcp)) {
      const resolved = resolveServer(key, server, "opencode.json");
      result.set(resolved.id, resolved);
    }
  }

  // No built-in servers — MCP has no built-in registry.

  // `.dispatch/mcp.json` silently shadows `opencode.json`'s mcp key when both
  // declare servers — the opencode entry is skipped with no warning otherwise.
  const shadowed = dispatchHadServers && opencodeHasMcp;
  return { servers: [...result.values()], shadowed };
}

function resolveServer(
  key: string,
  config: McpServerConfig,
  configSource: ".dispatch/mcp.json" | "opencode.json",
): ResolvedMcpServer {
  const command = [config.command, ...(config.args ?? [])];
  const result: ResolvedMcpServer = {
    id: key,
    command,
    configSource,
  };
  if (config.env) {
    (result as { env?: Readonly<Record<string, string>> }).env = config.env;
  }
  return result;
}
