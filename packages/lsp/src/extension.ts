/**
 * LSP extension — manifest + activate(host).
 *
 * Builds the manager with real adapters, registers the lsp tool and
 * lspServiceHandle, and wires deactivate to manager.shutdownAll().
 */

import { extname, join } from "node:path";
import type { Extension, HostAPI, ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import { conversationClosed, sessionOrchestratorHandle } from "@dispatch/session-orchestrator";
import { type AggregateResult, aggregateDiagnostics } from "./aggregate.js";
import {
  type CheckOutcome,
  type CheckQueueLogger,
  type CheckRunner,
  DiagnosticsCheckQueue,
  type NoticeDelivery,
} from "./check-queue.js";
import type { SpawnedProcess } from "./client.js";
import { LspManager } from "./manager.js";
import { createLspTool } from "./tool.js";
import type {
  DiagnosticsResult,
  GetDiagnosticsOpts,
  LspServerStatus,
  LspService,
  QueueCheckOpts,
} from "./types.js";

export const lspServiceHandle: ServiceHandle<LspService> = defineService<LspService>("lsp");

/** 10s hard ceiling per server for both background checks and reports. */
const PER_SERVER_CAP_MS = 10_000;

/**
 * Aggregate diagnostics for one file across the connected servers that claim
 * its extension. Shared by the synchronous `getDiagnostics` service method and
 * the background check queue, so both use identical cap/skip semantics.
 */
async function aggregateFile(
  manager: LspManager,
  opts: {
    readonly filePath: string;
    readonly text?: string | undefined;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly minSeverity?: number | undefined;
  },
): Promise<AggregateResult> {
  const fileExt = extname(opts.filePath).toLowerCase();
  const absolutePath = opts.filePath.startsWith("/")
    ? opts.filePath
    : join(opts.cwd, opts.filePath);

  // A dead/corrupted server has state:"error" and is excluded — no per-edit
  // hang on a corpse.
  const statuses = await manager.status(opts.cwd);
  const matching = statuses.filter(
    (s) => s.state === "connected" && s.extensions.some((ext) => ext === fileExt),
  );
  if (matching.length === 0) return { formatted: "", timedOut: false, issues: [] };

  return aggregateDiagnostics(
    (id, root) => manager.getClient(id, root),
    matching,
    absolutePath,
    opts.timeoutMs,
    {
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.minSeverity !== undefined ? { minSeverity: opts.minSeverity } : {}),
    },
  );
}

/** The background queue's check: errors + warnings only (the notice contract). */
function createCheckRunner(manager: LspManager): CheckRunner {
  return async ({ filePath, text, cwd }): Promise<CheckOutcome> => {
    const agg = await aggregateFile(manager, {
      filePath,
      text,
      cwd,
      timeoutMs: PER_SERVER_CAP_MS,
      minSeverity: 2,
    });
    return { formatted: agg.formatted, timedOut: agg.timedOut, issues: agg.issues };
  };
}

/**
 * Delivery seam over the session-orchestrator, resolved LAZILY on every call
 * (standard→core, optional): activation order does not matter and the notice
 * feature degrades off when the orchestrator isn't loaded.
 */
function createNoticeDelivery(host: HostAPI): NoticeDelivery {
  const orchestrator = () => host.tryGetService(sessionOrchestratorHandle);
  return {
    isActive: (conversationId) => orchestrator()?.isActive(conversationId) ?? false,
    enqueue: ({ conversationId, text }) => {
      const service = orchestrator();
      if (service === undefined) return { startedTurn: false, messageId: undefined };
      const result = service.enqueue({ conversationId, text });
      if (result.startedTurn) return { startedTurn: true, messageId: undefined };
      // The message-queue appends, so our notice is the last snapshot entry.
      const queued = result.queue[result.queue.length - 1];
      return { startedTurn: false, messageId: queued?.id };
    },
    cancel: ({ conversationId, messageId }) => {
      const service = orchestrator();
      if (service === undefined) return false;
      return service.cancelQueuedMessage({ conversationId, messageId }).cancelled;
    },
    subscribe: (conversationId, listener) =>
      orchestrator()?.subscribe(conversationId, listener) ?? undefined,
  };
}

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
    tier: "standard",
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

    // Background, non-blocking diagnostics: edit/write tools enqueue a check
    // instead of awaiting one. Delivered through the session-orchestrator
    // (resolved lazily), purged when a conversation closes.
    const checks = new DiagnosticsCheckQueue({
      check: createCheckRunner(manager),
      delivery: createNoticeDelivery(host),
      logger: createQueueLogger(logger),
    });
    const stopOnClose = host.on(conversationClosed, (payload) => {
      checks.purgeConversation(payload.conversationId);
    });

    const lspTool = createLspTool(manager, { checks });
    host.defineTool(lspTool);

    const service: LspService = {
      async status(cwd: string): Promise<readonly LspServerStatus[]> {
        return manager.status(cwd);
      },
      async getDiagnostics(opts: GetDiagnosticsOpts): Promise<DiagnosticsResult> {
        // 10s hard ceiling per server, regardless of what the caller passes.
        // A server that doesn't respond in 10s is skipped with a notice
        // instead of waited out.
        const timeoutMs = Math.min(opts.timeoutMs ?? PER_SERVER_CAP_MS, PER_SERVER_CAP_MS);
        const agg = await aggregateFile(manager, {
          filePath: opts.filePath,
          text: opts.text,
          cwd: opts.cwd,
          timeoutMs,
          minSeverity: opts.minSeverity,
        });
        return { formatted: agg.formatted, slow: false, timedOut: agg.timedOut };
      },
      queueCheck(opts: QueueCheckOpts): void {
        // Fire-and-forget by contract: never throws, never blocks the edit.
        try {
          checks.queueCheck(opts);
        } catch (err: unknown) {
          logger.warn("failed to queue LSP diagnostics check", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };
    const unprovide = host.provideService(lspServiceHandle, service);
    // NOTE: `provideService` returns the un-provide disposer — the disposal
    // contract (HostAPI doc, plan 01) requires deactivate() to call it. It is
    // captured in the store below (previously dropped, which made every
    // unload force-clean the service registration and report it as dangling —
    // surfaced by the plan-08 lsp pilot / verify-plugin machinery).

    host.logger.info("LSP extension activated");

    // Store manager + service disposer + queue for deactivate
    lspManagerStore.manager = manager;
    lspManagerStore.unprovide = unprovide;
    lspManagerStore.checks = checks;
    lspManagerStore.stopOnClose = stopOnClose;
  },
  deactivate() {
    lspManagerStore.checks?.dispose();
    lspManagerStore.stopOnClose?.();
    lspManagerStore.manager?.shutdownAll();
    lspManagerStore.unprovide?.();
    lspManagerStore.manager = null;
    lspManagerStore.unprovide = null;
    lspManagerStore.checks = null;
    lspManagerStore.stopOnClose = null;
  },
};

// Module-scoped store for deactivate
const lspManagerStore: {
  manager: LspManager | null;
  unprovide: (() => void) | null;
  checks: DiagnosticsCheckQueue | null;
  stopOnClose: (() => void) | null;
} = {
  manager: null,
  unprovide: null,
  checks: null,
  stopOnClose: null,
};

/** Adapt the host logger to the queue's narrow logger interface. */
function createQueueLogger(logger: HostAPI["logger"]): CheckQueueLogger {
  return {
    warn: (msg, attrs) =>
      logger.warn(msg, attrs as Record<string, string | number | boolean | null> | undefined),
  };
}

/**
 * Test-only re-export of the production `realFileWatcher` adapter, so the
 * fs.watch error-listener behavior (Bug 2) can be exercised with an injected
 * fake watcher without poking module internals. NOT part of the public
 * extension surface — the `__test__` prefix signals test-only use.
 */
export const __test__realFileWatcher = realFileWatcher;
