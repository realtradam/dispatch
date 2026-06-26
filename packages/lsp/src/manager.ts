/**
 * Manager — lazy-spawn one client per (serverID, root); dedup concurrent
 * spawns; track a broken set (no retry storm); status(cwd); shutdownAll().
 */

import { join } from "node:path";
import {
  type ClientDeps,
  type FileWatcher,
  type FsAccess,
  LanguageServerClient,
  type SpawnProcess,
} from "./client.js";
import { configFingerprint, type ResolvedServer, resolveServers } from "./config.js";
import { findRoot } from "./root.js";
import type { LspServerState, LspServerStatus } from "./types.js";

export type Logger = {
  readonly info: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
  readonly warn: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
  readonly error: (msg: string, attrs?: Record<string, unknown>) => void;
};

export interface ManagerDeps {
  readonly spawn: SpawnProcess;
  readonly fileWatcher: FileWatcher;
  readonly fs: FsAccess;
  readonly logger?: Logger | undefined;
  /**
   * Injected clock (epoch-ms) for bounded-backoff bookkeeping. Defaults to
   * `Date.now`; injected in tests so backoff is deterministic.
   */
  readonly now?: (() => number) | undefined;
}

type ClientEntry = {
  readonly client: LanguageServerClient;
  readonly server: ResolvedServer;
  readonly promise: Promise<void>;
};

/**
 * A failed server's recovery bookkeeping. `configFingerprint` is the resolved
 * config captured at failure time: a config edit produces a different
 * fingerprint (a discrete event → cannot storm) and the next `status()` clears
 * the entry and re-spawns. `brokenAt` seeds a bounded backoff so transient
 * failures (e.g. a not-yet-installed binary) also self-heal without a storm.
 * `error` is the enriched failure reason surfaced while the server stays
 * broken.
 */
type BrokenEntry = {
  readonly configFingerprint: string;
  readonly brokenAt: number;
  readonly error: string;
};

/** Bounded backoff before a transient (config-unchanged) failure is retried. */
const BACKOFF_MS = 30_000;

export class LspManager {
  private clients = new Map<string, ClientEntry>();
  private broken = new Map<string, BrokenEntry>();
  private spawning = new Map<string, Promise<void>>();
  private shadowWarned = new Set<string>();
  private readonly deps: ManagerDeps;
  private readonly now: () => number;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async status(cwd: string): Promise<readonly LspServerStatus[]> {
    // Config is resolved PER cwd: a different conversation cwd (e.g. a Roblox
    // project) gets its own .dispatch/lsp.json or opencode.json, not a global one.
    const dispatchLspJson = await this.readOrNull(join(cwd, ".dispatch", "lsp.json"));
    const opencodeJson = await this.readOrNull(join(cwd, "opencode.json"));
    const { servers, shadowed } = await resolveServers({
      cwd,
      dispatchLspJson,
      opencodeJson,
      exists: this.deps.fs.exists,
    });

    // A present `.dispatch/lsp.json` silently shadows `opencode.json`'s lsp
    // key — warn once per cwd so a broken shadow names itself (an agent
    // running inside dispatch can only see `status()`, not the journal).
    if (shadowed && !this.shadowWarned.has(cwd)) {
      this.shadowWarned.add(cwd);
      this.deps.logger?.warn(
        `.dispatch/lsp.json is shadowing the opencode.json "lsp" config — its servers take precedence and the opencode.json lsp entry is ignored`,
        { cwd },
      );
    }

    const results: LspServerStatus[] = [];

    for (const server of servers) {
      const root = await findRoot(cwd, cwd, server.rootMarkers, this.deps.fs.exists);
      const key = `${server.id}:${root}`;

      const brokenEntry = this.broken.get(key);
      if (brokenEntry) {
        // Recovery, storm-safe: a config change is a discrete event, so it
        // cannot loop. Transient failures (config unchanged) are retried
        // only after a bounded backoff — never in a tight loop.
        const configChanged = configFingerprint(server) !== brokenEntry.configFingerprint;
        const backoffElapsed = this.now() - brokenEntry.brokenAt >= BACKOFF_MS;
        if (configChanged || backoffElapsed) {
          this.broken.delete(key);
          // Discard the stale client entry (and any leaked process) from
          // the failed spawn so status() re-spawns fresh.
          const stale = this.clients.get(key);
          if (stale) {
            this.clients.delete(key);
            stale.client.shutdown();
          }
          // fall through to (re)spawn
        } else {
          results.push({
            id: server.id,
            name: server.name,
            root,
            extensions: server.extensions,
            state: "error",
            error: brokenEntry.error,
            configSource: server.configSource,
          });
          continue;
        }
      }

      const existing = this.clients.get(key);
      if (existing) {
        const state = existing.client.getState();
        const stateError = existing.client.getStateError();
        // A client that died or corrupted AFTER connecting flipped its
        // own state to "error" (client.ts handleExit/markBroken). Spawn
        // succeeded so there's no broken entry yet — seed one so the
        // bounded-backoff path above re-spawns it, instead of reporting
        // error forever (and so getDiagnostics' "connected" filter skips
        // it, avoiding a per-edit hang on the corpse).
        if (state === "error" && !this.broken.has(key)) {
          this.broken.set(key, {
            configFingerprint: configFingerprint(server),
            brokenAt: this.now(),
            error: enrichError(server, stateError ?? "server unavailable"),
          });
        }
        const status: LspServerStatus = {
          id: server.id,
          name: server.name,
          root,
          extensions: server.extensions,
          state: mapState(state),
          configSource: server.configSource,
        };
        if (stateError !== undefined) {
          (status as { error?: string }).error = enrichError(server, stateError);
        }
        results.push(status);
        continue;
      }

      try {
        await this.spawnClient(server, root, key);
        const entry = this.clients.get(key);
        if (entry) {
          const state = entry.client.getState();
          const stateError = entry.client.getStateError();
          const status: LspServerStatus = {
            id: server.id,
            name: server.name,
            root,
            extensions: server.extensions,
            state: mapState(state),
            configSource: server.configSource,
          };
          if (stateError !== undefined) {
            (status as { error?: string }).error = enrichError(server, stateError);
          }
          results.push(status);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.broken.set(key, {
          configFingerprint: configFingerprint(server),
          brokenAt: this.now(),
          error: enrichError(server, message),
        });
        results.push({
          id: server.id,
          name: server.name,
          root,
          extensions: server.extensions,
          state: "error",
          error: enrichError(server, message),
          configSource: server.configSource,
        });
      }
    }

    return results;
  }

  getClient(serverId: string, root: string): LanguageServerClient | undefined {
    const key = `${serverId}:${root}`;
    return this.clients.get(key)?.client;
  }

  /** Read a config file's contents, or null if it is absent/unreadable. */
  private async readOrNull(path: string): Promise<string | null> {
    if (!(await this.deps.fs.exists(path))) return null;
    try {
      return await this.deps.fs.readText(path);
    } catch {
      return null;
    }
  }

  private async spawnClient(server: ResolvedServer, root: string, key: string): Promise<void> {
    const existingSpawn = this.spawning.get(key);
    if (existingSpawn) return existingSpawn;

    const spawnPromise = this.doSpawn(server, root, key);
    this.spawning.set(key, spawnPromise);

    try {
      await spawnPromise;
    } finally {
      this.spawning.delete(key);
    }
  }

  private async doSpawn(server: ResolvedServer, root: string, key: string): Promise<void> {
    const clientDeps: ClientDeps = {
      spawn: this.deps.spawn,
      fileWatcher: this.deps.fileWatcher,
      fs: this.deps.fs,
      command: server.command,
      root,
      serverId: server.id,
    };
    if (server.env) {
      (clientDeps as { env?: Readonly<Record<string, string>> }).env = server.env;
    }
    if (server.initialization) {
      (clientDeps as { initialization?: Readonly<Record<string, unknown>> }).initialization =
        server.initialization;
    }

    const client = new LanguageServerClient(clientDeps);
    const entry: ClientEntry = {
      client,
      server,
      promise: client.start(),
    };

    this.clients.set(key, entry);
    await entry.promise;

    if (client.getState() === "error") {
      const message = client.getStateError() ?? "unknown";
      this.broken.set(key, {
        configFingerprint: configFingerprint(server),
        brokenAt: this.now(),
        error: enrichError(server, message),
      });
      this.deps.logger?.warn("LSP server failed to start", {
        serverId: server.id,
        root,
        configSource: server.configSource ?? "unknown",
        error: message,
      });
    } else {
      this.deps.logger?.info("LSP server connected", {
        serverId: server.id,
        root,
      });
    }
  }

  shutdownAll(): void {
    for (const [key, entry] of this.clients) {
      entry.client.shutdown();
      this.deps.logger?.info("LSP server shutdown", { key });
    }
    this.clients.clear();
    this.broken.clear();
    this.spawning.clear();
    this.shadowWarned.clear();
  }
}

function mapState(state: LspServerState): LspServerState {
  return state;
}

/**
 * Prefix a failure reason with the server id + its config source, so a broken
 * config file names itself in the `status()` response (e.g.
 * `ruby-lsp [from .dispatch/lsp.json]: spawn failed`).
 */
function enrichError(server: ResolvedServer, message: string): string {
  const source = server.configSource ?? "unknown";
  return `${server.id} [from ${source}]: ${message}`;
}
