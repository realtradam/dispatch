/**
 * McpManager — one McpClient per (server id, cwd); lazy-spawn on first
 * tool access; status(servers, cwd); getClient(serverId, cwd); shutdownAll().
 *
 * Injected connection factory + logger + clock; the manager owns lifecycle
 * timers. Config resolution stays in the extension layer.
 */

import { McpClient } from "./client.js";
import { MCP_CONNECT_TIMEOUT_MS, withTimeout } from "./timeout.js";
import type { Connection, SpawnProcess } from "./transport.js";
import type { McpCallResult, McpServerState, McpServerStatus, ResolvedMcpServer } from "./types.js";

export interface Logger {
  readonly info: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
  readonly warn: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
  readonly error: (msg: string, attrs?: Record<string, unknown>) => void;
}

export interface McpManagerDeps {
  readonly spawn: SpawnProcess;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export type ConnectionFactory = (
  server: ResolvedMcpServer,
  cwd: string,
) => { connection: Connection; promise: Promise<void> };

type ClientEntry = {
  readonly client: McpClient;
  readonly controller: AbortController;
  lastUsedAt: number;
  activeCalls: number;
};

type BrokenEntry = {
  readonly brokenAt: number;
  readonly error: string;
};

const BACKOFF_MS = 30_000;
const IDLE_MS = 30 * 60_000;

// Config files resolve from cwd, not workspaceId. JSON avoids delimiter collisions.
const clientKey = (serverId: string, cwd: string): string => JSON.stringify([serverId, cwd]);

export class McpManager {
  private clients = new Map<string, ClientEntry>();
  private broken = new Map<string, BrokenEntry>();
  private spawning = new Map<string, Promise<void>>();
  private readonly deps: McpManagerDeps;
  private readonly connectionFactory: ConnectionFactory;
  private readonly now: () => number;
  private readonly reaper: ReturnType<typeof setInterval>;

  constructor(deps: McpManagerDeps, connectionFactory: ConnectionFactory) {
    this.deps = deps;
    this.connectionFactory = connectionFactory;
    this.now = deps.now ?? Date.now;
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  getClient(serverId: string, cwd: string): McpClient | undefined {
    return this.clients.get(clientKey(serverId, cwd))?.client;
  }

  getServerState(serverId: string, cwd: string): McpServerState {
    const key = clientKey(serverId, cwd);
    const brokenEntry = this.broken.get(key);
    if (brokenEntry) {
      const backoffElapsed = this.now() - brokenEntry.brokenAt >= BACKOFF_MS;
      if (backoffElapsed) {
        this.broken.delete(key);
      } else {
        return "error";
      }
    }

    const entry = this.clients.get(key);
    if (!entry) return "disconnected";

    const state = entry.client.getState();
    if (state === "error") return "error";
    if (state === "connecting") return "connecting";
    if (state === "connected") return "connected";
    return "disconnected";
  }

  status(servers: readonly ResolvedMcpServer[], cwd: string): McpServerStatus[] {
    const results: McpServerStatus[] = [];

    for (const server of servers) {
      const key = clientKey(server.id, cwd);
      const state = this.getServerState(server.id, cwd);
      const entry = this.clients.get(key);
      const brokenEntry = this.broken.get(key);

      const status: McpServerStatus = {
        id: server.id,
        state,
        toolCount: entry?.client.getTools().length ?? 0,
      };
      if (state === "error" && brokenEntry) {
        (status as { error?: string }).error = brokenEntry.error;
      } else if (state === "error" && entry?.client.getState() === "error") {
        (status as { error?: string }).error = brokenEntry?.error ?? `${server.id}: client error`;
      }
      results.push(status);
    }

    return results;
  }

  /**
   * Ensure a client for `server` is connected, lazily spawning + handshaking on
   * first access. The handshake owns its timeout; each turn races only its own
   * wait, so cancellation never poisons other callers or the shared client.
   */
  async ensureConnected(
    server: ResolvedMcpServer,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<McpClient> {
    if (signal?.aborted) throw new Error("Aborted");
    const key = clientKey(server.id, cwd);
    const existing = this.clients.get(key);
    if (!this.spawning.has(key) && existing?.client.getState() === "connected") {
      existing.lastUsedAt = this.now();
      return existing.client;
    }

    const brokenEntry = this.broken.get(key);
    if (brokenEntry) {
      if (this.now() - brokenEntry.brokenAt < BACKOFF_MS) throw new Error(brokenEntry.error);
      this.broken.delete(key);
    }

    await withTimeout(this.spawnClient(server, cwd), "connect", 0, signal);
    const entry = this.clients.get(key);
    if (entry?.client.getState() !== "connected") {
      throw new Error(
        this.broken.get(key)?.error ?? `Failed to connect MCP client for ${server.id}`,
      );
    }
    entry.lastUsedAt = this.now();
    return entry.client;
  }

  async callTool(
    server: ResolvedMcpServer,
    cwd: string,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const client = await this.ensureConnected(server, cwd, signal);
    const entry = this.clients.get(clientKey(server.id, cwd));
    if (!entry) throw new Error("MCP client disconnected");
    entry.activeCalls++;
    try {
      return await client.callTool(name, args, signal);
    } finally {
      entry.activeCalls--;
      entry.lastUsedAt = this.now();
    }
  }

  private async spawnClient(server: ResolvedMcpServer, cwd: string): Promise<void> {
    const key = clientKey(server.id, cwd);
    const existingSpawn = this.spawning.get(key);
    if (existingSpawn) return existingSpawn;

    const spawnPromise = this.doSpawn(server, cwd);
    this.spawning.set(key, spawnPromise);

    try {
      await spawnPromise;
    } finally {
      if (this.spawning.get(key) === spawnPromise) this.spawning.delete(key);
    }
  }

  private async doSpawn(server: ResolvedMcpServer, cwd: string): Promise<void> {
    const key = clientKey(server.id, cwd);
    this.clients.get(key)?.client.close();
    this.clients.delete(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_CONNECT_TIMEOUT_MS);
    let entry: ClientEntry | undefined;
    try {
      const { connection, promise } = this.connectionFactory(server, cwd);
      const client = new McpClient({ connection });
      entry = { client, controller, lastUsedAt: this.now(), activeCalls: 0 };
      this.clients.set(key, entry);
      // Transport EOF/error is a disconnect even if the last RPC succeeded.
      const disconnect = (): void => {
        if (this.clients.get(key) === entry) {
          controller.abort();
          client.close();
        }
      };
      void promise.then(disconnect, disconnect);
      await client.initialize(controller.signal);
      await client.listTools(controller.signal);
      this.deps.logger?.info("MCP server connected", {
        serverId: server.id,
        toolCount: String(client.getTools().length),
      });
    } catch (err: unknown) {
      // Shutdown/late completions must not repopulate cleared manager state.
      if (entry && this.clients.get(key) !== entry) return;
      entry?.client.close();
      this.clients.delete(key);
      const message = err instanceof Error ? err.message : String(err);
      this.broken.set(key, { brokenAt: this.now(), error: `${server.id}: ${message}` });
      this.deps.logger?.warn("MCP server failed to connect", {
        serverId: server.id,
        error: message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private reapIdle(): void {
    for (const [key, entry] of this.clients) {
      if (this.spawning.has(key) || entry.activeCalls || this.now() - entry.lastUsedAt < IDLE_MS)
        continue;
      entry.client.close();
      this.clients.delete(key);
    }
    for (const [key, entry] of this.broken) {
      if (this.now() - entry.brokenAt >= BACKOFF_MS) this.broken.delete(key);
    }
  }

  shutdownAll(): void {
    clearInterval(this.reaper);
    for (const [, entry] of this.clients) {
      entry.controller.abort();
      entry.client.close();
    }
    this.clients.clear();
    this.broken.clear();
    this.spawning.clear();
    this.deps.logger?.info("All MCP servers shut down");
  }
}
