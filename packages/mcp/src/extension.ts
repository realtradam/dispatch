/**
 * MCP extension — manifest + activate(host).
 *
 * Builds the manager with real adapters, registers MCP tools via host.defineTool
 * (on connect + on list_changed re-list), registers a toolsFilter that drops
 * tools from disconnected/errored servers, and provides the mcpServiceHandle.
 *
 * The production `extension` wires real Bun adapters. `makeMcpExtension(deps)`
 * accepts injectable spawn/readFile/getCwd so the lifecycle is testable against
 * in-memory backends (mirrors the LSP extension's injected adapters).
 */

import type { Extension, HostAPI, ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import { type ToolAssembly, toolsFilter } from "@dispatch/session-orchestrator";
import type { McpClient } from "./client.js";
import { resolveServers } from "./config.js";
import type { Logger } from "./manager.js";
import { McpManager } from "./manager.js";
import { adaptTool, namespace } from "./registry.js";
import type { SpawnedProcess, SpawnProcess } from "./transport.js";
import { createStdioTransport } from "./transport.js";
import type { McpServerStatus, McpService, ResolvedMcpServer } from "./types.js";

export const mcpServiceHandle: ServiceHandle<McpService> = defineService<McpService>("mcp");

/** Filesystem + process adapters injected into the extension for testability. */
export interface McpExtensionDeps {
  readonly spawn: SpawnProcess;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly getCwd: () => string;
}

/**
 * Pure tool-filter logic: remove MCP tools whose owning server is not
 * currently connected. Non-MCP tools (no entry in `toolToServer`) are kept.
 * Extracted from the filter handler so it is unit-testable without I/O.
 */
export function filterMcpTools(
  assembly: ToolAssembly,
  toolToServer: ReadonlyMap<string, string>,
  connectedServerIds: ReadonlySet<string>,
): ToolAssembly {
  const filtered = assembly.tools.filter((tool) => {
    const serverId = toolToServer.get(tool.name);
    if (serverId === undefined) return true;
    return connectedServerIds.has(serverId);
  });
  return {
    tools: filtered,
    ...(assembly.cwd !== undefined && { cwd: assembly.cwd }),
    ...(assembly.computerId !== undefined && { computerId: assembly.computerId }),
    conversationId: assembly.conversationId,
  };
}

/** Map a host Logger to the manager's narrower Logger surface. */
function wrapLogger(logger: HostAPI["logger"]): Logger {
  return {
    info: (msg, attrs) => logger.info(msg, attrs),
    warn: (msg, attrs) => logger.warn(msg, attrs),
    error: (msg, attrs) => logger.error(msg, attrs),
  };
}

export function makeMcpExtension(deps: McpExtensionDeps): Extension {
  // Module-scoped store so deactivate can reach the manager. Lives in the
  // factory closure so each built extension has its own.
  const store: { manager: McpManager | null } = { manager: null };

  return {
    manifest: {
      id: "mcp",
      name: "Model Context Protocol",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      trust: "bundled",
      activation: "eager",
      dependsOn: ["session-orchestrator"],
      capabilities: { spawn: true },
      contributes: { tools: [], services: ["mcp"] },
    },
    activate(host: HostAPI) {
      const logger = host.logger;

      const connectionFactory = (server: ResolvedMcpServer, cwd: string) => {
        return createStdioTransport(
          {
            spawn: deps.spawn,
            command: server.command,
            ...(server.env !== undefined && { env: server.env }),
          },
          cwd,
        );
      };

      const manager = new McpManager(
        { spawn: deps.spawn, logger: wrapLogger(logger) },
        connectionFactory,
      );

      // Track which tool names belong to which server for the filter.
      const toolToServer = new Map<string, string>();

      function registerToolsFromClient(serverId: string, client: McpClient): void {
        const tools = client.getTools();
        for (const mcpTool of tools) {
          const name = namespace(serverId, mcpTool.name);
          toolToServer.set(name, serverId);
          host.defineTool(adaptTool(serverId, mcpTool, client));
        }
      }

      async function connectAndRegister(server: ResolvedMcpServer, cwd: string): Promise<void> {
        const client = await manager.ensureConnected(server, cwd);
        registerToolsFromClient(server.id, client);

        // Wire list_changed → re-list → re-register. onToolsChanged replaces
        // the handler; ensureConnected returns the same cached client so this
        // is idempotent across turns.
        client.onToolsChanged(async () => {
          try {
            await client.listTools();
            registerToolsFromClient(server.id, client);
          } catch (err: unknown) {
            logger.error("MCP tools re-list failed", {
              serverId: server.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }

      // Resolve config + ensure servers connected, then drop tools whose
      // server is not connected. Lazy-spawn happens here (first turn).
      host.addFilter(toolsFilter, async (assembly: ToolAssembly): Promise<ToolAssembly> => {
        const cwd = assembly.cwd ?? deps.getCwd();
        const dispatchMcpJson = await deps.readFile(joinPath(cwd, ".dispatch", "mcp.json"));
        const opencodeJson = await deps.readFile(joinPath(cwd, "opencode.json"));
        const { servers } = resolveServers({ dispatchMcpJson, opencodeJson });

        for (const server of servers) {
          try {
            await connectAndRegister(server, cwd);
          } catch {
            // Connection failure — the manager tracks broken state.
          }
        }

        const statuses = manager.status(servers);
        const connectedIds = new Set(
          statuses.filter((s) => s.state === "connected").map((s) => s.id),
        );

        return filterMcpTools(assembly, toolToServer, connectedIds);
      });

      // Provide the MCP service (status introspection).
      const service: McpService = {
        async status(cwd: string): Promise<readonly McpServerStatus[]> {
          const dispatchMcpJson = await deps.readFile(joinPath(cwd, ".dispatch", "mcp.json"));
          const opencodeJson = await deps.readFile(joinPath(cwd, "opencode.json"));
          const { servers } = resolveServers({ dispatchMcpJson, opencodeJson });
          return manager.status(servers);
        },
      };
      host.provideService(mcpServiceHandle, service);

      store.manager = manager;
      logger.info("MCP extension activated");
    },
    deactivate() {
      store.manager?.shutdownAll();
      store.manager = null;
    },
  };
}

// --- real Bun-backed adapters (production wiring) ---

function realSpawn(
  command: readonly string[],
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
): SpawnedProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      env[key] = value;
    }
  }
  const proc = Bun.spawn(command as string[], {
    cwd: opts.cwd,
    env: env as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    pid: proc.pid,
    kill: () => proc.kill(),
  };
}

async function realReadFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      return file.text();
    }
    return null;
  } catch {
    return null;
  }
}

function joinPath(...parts: readonly string[]): string {
  return parts.join("/");
}

/** Production extension: real Bun spawn + filesystem reads. */
export const extension: Extension = makeMcpExtension({
  spawn: realSpawn,
  readFile: realReadFile,
  getCwd: () => process.cwd(),
});
