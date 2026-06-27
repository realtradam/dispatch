/**
 * LSP extension — manifest + activate(host).
 *
 * Builds the manager with real adapters, registers the lsp tool and
 * lspServiceHandle, and wires deactivate to manager.shutdownAll().
 */

import { extname, join } from "node:path";
import type { Extension, HostAPI, ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import { aggregateDiagnostics } from "./aggregate.js";
import type { SpawnedProcess } from "./client.js";
import { LspManager } from "./manager.js";
import { createLspTool } from "./tool.js";
import type {
  DiagnosticsResult,
  GetDiagnosticsOpts,
  LspServerStatus,
  LspService,
} from "./types.js";

export const lspServiceHandle: ServiceHandle<LspService> = defineService<LspService>("lsp");

function realSpawn(
  command: string[],
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
): SpawnedProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      env[key] = value;
    }
  }
  const proc = Bun.spawn(command, {
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
    // Surface process exit so the client can stop querying a dead server
    // and self-heal (respawn). Bun's Subprocess.exited resolves with the
    // exit code (or rejects if killed by signal — treat as code:null).
    onExit: (handler) => {
      (proc as { exited: Promise<number | null> }).exited
        .then((code) => handler({ code }))
        .catch(() => handler({ code: null }));
    },
  };
}

/**
 * The minimal slice of `node:fs.watch`'s return we depend on — narrow enough
 * that a test can supply an EventEmitter stand-in. `on('error', …)` is the
 * crucial bit: without a listener, Node/Bun escalates a watcher 'error'
 * event (e.g. from `bun install` deleting transient `.old_modules-*` dirs)
 * into an uncaught exception that kills the process.
 */
export interface FsWatcherHandle {
  readonly on: (event: string, cb: (err: Error) => void) => FsWatcherHandle;
  readonly close: () => void;
}

export type WatchFn = (
  root: string,
  opts: { readonly recursive: boolean },
  cb: (eventType: string, filename: string | null) => void,
) => FsWatcherHandle;

function defaultWatch(): WatchFn {
  // Loaded lazily so the kernel-style import graph never statically pulls
  // `node:fs` (the extension imports it at call time, matching the prior
  // `require` form).
  const { watch } = require("node:fs") as {
    watch: WatchFn;
  };
  return watch;
}

function realFileWatcher(
  root: string,
  onEvent: (e: { readonly type: "create" | "change" | "delete"; readonly path: string }) => void,
  watch: WatchFn = defaultWatch(),
): { readonly close: () => void } {
  const watcher = watch(root, { recursive: true }, (eventType: string, filename: string | null) => {
    if (!filename) return;
    const fullPath = root.endsWith("/") ? `${root}${filename}` : `${root}/${filename}`;
    const type = eventType === "rename" ? "create" : "change";
    onEvent({ type, path: fullPath });
  });
  // Attach a no-op 'error' listener so a transient FS error (e.g. a watched
  // directory vanishing mid-`bun install`) is swallowed instead of being
  // escalated to an uncaught exception that crashes the server.
  watcher.on("error", () => {
    // Gracefully ignore transient FS errors — the watcher is best-effort.
  });
  return { close: () => watcher.close() };
}

function realFs() {
  return {
    readText: async (path: string) => {
      const file = Bun.file(path);
      return file.text();
    },
    exists: async (path: string) => {
      const file = Bun.file(path);
      return file.exists();
    },
  };
}

export const extension: Extension = {
  manifest: {
    id: "lsp",
    name: "Language Server Protocol",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    trust: "bundled",
    activation: "eager",
    capabilities: { spawn: true, fs: true },
    contributes: { tools: ["lsp"], services: ["lsp"] },
  },
  activate(host: HostAPI) {
    const logger = host.logger;

    const manager = new LspManager({
      spawn: realSpawn,
      fileWatcher: realFileWatcher,
      fs: realFs(),
      logger: {
        info: (msg, attrs) =>
          logger.info(msg, attrs as Record<string, string | number | boolean | null> | undefined),
        warn: (msg, attrs) =>
          logger.warn(msg, attrs as Record<string, string | number | boolean | null> | undefined),
        error: (msg, attrs) => logger.error(msg, attrs as Record<string, unknown> | undefined),
      },
    });

    const lspTool = createLspTool(manager);
    host.defineTool(lspTool);

    const service: LspService = {
      async status(cwd: string): Promise<readonly LspServerStatus[]> {
        return manager.status(cwd);
      },
      async getDiagnostics(opts: GetDiagnosticsOpts): Promise<DiagnosticsResult> {
        // 10s hard ceiling per server, regardless of what the caller
        // passes (the edit hook still passes 60_000 — clamped here, so
        // no other-unit edit is needed). A server that doesn't respond
        // in 10s is skipped with a notice instead of waited out.
        const PER_SERVER_CAP_MS = 10_000;
        const timeoutMs = Math.min(opts.timeoutMs ?? PER_SERVER_CAP_MS, PER_SERVER_CAP_MS);
        const fileExt = extname(opts.filePath).toLowerCase();
        const absolutePath = opts.filePath.startsWith("/")
          ? opts.filePath
          : join(opts.cwd, opts.filePath);

        // Get all connected servers matching this file's extension.
        // A dead/corrupted server has state:"error" and is excluded —
        // no per-edit hang on a corpse.
        const statuses = await manager.status(opts.cwd);
        const matching = statuses.filter(
          (s) => s.state === "connected" && s.extensions.some((ext) => ext === fileExt),
        );

        if (matching.length === 0) {
          return { formatted: "", slow: false, timedOut: false };
        }

        const agg = await aggregateDiagnostics(
          (id, root) => manager.getClient(id, root),
          matching,
          absolutePath,
          timeoutMs,
          { text: opts.text, minSeverity: opts.minSeverity },
        );

        return { formatted: agg.formatted, slow: false, timedOut: agg.timedOut };
      },
    };
    host.provideService(lspServiceHandle, service);

    host.logger.info("LSP extension activated");

    // Store manager for deactivate
    (lspManagerStore as { manager: LspManager | null }).manager = manager;
  },
  deactivate() {
    const store = lspManagerStore as { manager: LspManager | null };
    store.manager?.shutdownAll();
    store.manager = null;
  },
};

// Module-scoped store for deactivate
const lspManagerStore: { manager: LspManager | null } = { manager: null };

/**
 * Test-only re-export of the production `realFileWatcher` adapter, so the
 * fs.watch error-listener behavior (Bug 2) can be exercised with an injected
 * fake watcher without poking module internals. NOT part of the public
 * extension surface — the `__test__` prefix signals test-only use.
 */
export const __test__realFileWatcher = realFileWatcher;
