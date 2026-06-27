/**
 * Language-server client — wires codec + rpc + edges; runs the
 * initialize handshake, honors server→client requests, runs the
 * FileWatcher, and forwards matching disk changes.
 */

import { DiagnosticsStore, diagnosticKey, type PublishDiagnosticsParams } from "./diagnostics.js";
import { computeChangeRange } from "./diff.js";
import { FrameDecoder } from "./framing.js";
import { languageId as resolveLanguageId } from "./language.js";
import { JsonRpcConnection, type WriteFn } from "./rpc.js";
import { FileChangeType, WatchedFilesRegistry } from "./watched-files.js";

/** Info delivered to an `onExit` handler when the child process terminates. */
export interface ProcessExitInfo {
  readonly code: number | null;
  readonly signal?: string;
}

/** A handler registered to be called when the child process exits. */
export type ProcessExitHandler = (info: ProcessExitInfo) => void;

export interface SpawnedProcess {
  readonly stdin: { readonly write: (bytes: Uint8Array) => void };
  readonly stdout:
    | AsyncIterable<Uint8Array>
    | { readonly on: (event: string, cb: (data: Uint8Array) => void) => void };
  readonly stderr?:
    | AsyncIterable<Uint8Array>
    | { readonly on: (event: string, cb: (data: Uint8Array) => void) => void }
    | undefined;
  readonly pid: number | undefined;
  readonly kill: () => void;
  /**
   * Register a handler fired when the child process exits (code|signal).
   * Optional: when absent, death is detected via stdout-end instead. Wires
   * Bun's `proc.exited` in production; tests invoke it directly to simulate
   * a crash. Lets the client stop querying a dead server (no per-edit hang).
   */
  readonly onExit?: ((handler: ProcessExitHandler) => void) | undefined;
}

export type SpawnProcess = (
  command: string[],
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
) => SpawnedProcess;

export interface FileWatcherHandle {
  readonly close: () => void;
}

export type FileWatcher = (
  root: string,
  onEvent: (e: { readonly type: "create" | "change" | "delete"; readonly path: string }) => void,
) => FileWatcherHandle;

export interface FsAccess {
  readonly readText: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
}

export interface ClientCapabilities {
  readonly window: { readonly workDoneProgress: boolean };
  readonly workspace: {
    readonly configuration: boolean;
    readonly didChangeWatchedFiles: { readonly dynamicRegistration: boolean };
    readonly diagnostics: { readonly refreshSupport: boolean };
  };
  readonly textDocument: {
    readonly synchronization: { readonly didOpen: boolean; readonly didChange: boolean };
    readonly diagnostic: {
      readonly dynamicRegistration: boolean;
      readonly relatedDocumentSupport: boolean;
    };
    readonly publishDiagnostics: { readonly versionSupport: boolean };
  };
}

export const CLIENT_CAPABILITIES: ClientCapabilities = {
  window: { workDoneProgress: true },
  workspace: {
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
    diagnostics: { refreshSupport: false },
  },
  textDocument: {
    synchronization: { didOpen: true, didChange: true },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    publishDiagnostics: { versionSupport: false },
  },
};

export interface ClientDeps {
  readonly spawn: SpawnProcess;
  readonly fileWatcher: FileWatcher;
  readonly fs: FsAccess;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly root: string;
  readonly initialization?: Readonly<Record<string, unknown>> | undefined;
  readonly serverId: string;
  /**
   * Timeout for the initialize handshake, in ms (default 45_000). Passed
   * straight into `rpc.sendRequest` so a no-show server's pending entry is
   * cleared on expiry (no Promise.race leak). Exposed mainly so tests can
   * drive the timeout path quickly.
   */
  readonly initializeTimeoutMs?: number | undefined;
}

export type ClientState = "starting" | "connected" | "error" | "not-started";

export class LanguageServerClient {
  readonly serverId: string;
  readonly root: string;
  private process: SpawnedProcess | null = null;
  private rpc: JsonRpcConnection | null = null;
  private decoder = new FrameDecoder();
  private diagnostics = new DiagnosticsStore();
  private watchedFiles = new WatchedFilesRegistry();
  private fileWatcherHandle: FileWatcherHandle | null = null;
  private state: ClientState = "not-started";
  private stateError: string | undefined;
  private deps: ClientDeps;
  /**
   * Open documents keyed by filePath. Insertion order = LRU recency order:
   * the first entry is the least-recently-used (eviction candidate). Access
   * (`change`) re-inserts to move a key to the tail (most-recently-used);
   * `closeDocument` removes it. Capped at MAX_OPEN_DOCUMENTS — overflow
   * evicts the LRU entry via a textDocument/didClose + purge.
   */
  private openDocuments = new Map<string, { version: number; text: string }>();
  /** Sync mode captured from the server's initialize capabilities: 1=Full, 2=Incremental. */
  private textDocumentChange: 1 | 2 = 1;
  /**
   * Corruption detection: the last diagnostic-key set + synced text per URI.
   * A healthy server's diagnostics change when the file changes; a corrupted
   * one (e.g. Steep's ~3h phantom-SyntaxError drift) re-emits the identical
   * non-empty set across edits. `staleRepeat` counts consecutive such repeats
   * across URIs; at the threshold the client is marked broken (→ respawn).
   */
  private lastDiagSnapshot = new Map<string, { keys: Set<string>; text: string }>();
  private staleRepeat = 0;
  private static readonly STALE_REPEAT_THRESHOLD = 5;
  /** Default timeout for outbound requests (hover/definition/references). */
  private static readonly REQUEST_TIMEOUT_MS = 10_000;
  /**
   * Bounded open-document set: once more than this many files are open, the
   * least-recently-used is closed (textDocument/didClose) and evicted. The
   * maps were previously append-only — an agent scanning a large monorepo
   * held every file's text + diagnostics forever (9.5 GB over 12h).
   */
  private static readonly MAX_OPEN_DOCUMENTS = 50;

  constructor(deps: ClientDeps) {
    this.deps = deps;
    this.serverId = deps.serverId;
    this.root = deps.root;
  }

  getState(): ClientState {
    return this.state;
  }

  getStateError(): string | undefined {
    return this.stateError;
  }

  async start(): Promise<void> {
    this.state = "starting";
    try {
      const spawnOpts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> } = {
        cwd: this.root,
      };
      if (this.deps.env) {
        (spawnOpts as { env?: Readonly<Record<string, string>> }).env = this.deps.env;
      }
      const proc = this.deps.spawn(this.deps.command as string[], spawnOpts);
      this.process = proc;
      // Detect process death so we stop querying a corpse (fixes the
      // per-edit hang after a server is killed/crashes). onExit is the
      // primary signal; stdout-end is the defence-in-depth fallback.
      if (proc.onExit) {
        proc.onExit((info) => this.handleExit(info));
      }

      const writeFn: WriteFn = (bytes) => proc.stdin.write(bytes);
      const rpc = new JsonRpcConnection(writeFn);
      this.rpc = rpc;

      this.setupServerHandlers(rpc);

      const stdoutSource = proc.stdout;
      if (Symbol.asyncIterator in stdoutSource) {
        this.readFromAsyncIterable(stdoutSource as AsyncIterable<Uint8Array>);
      } else {
        this.readFromEventSource(
          stdoutSource as { readonly on: (event: string, cb: (data: Uint8Array) => void) => void },
        );
      }

      await this.initialize(rpc);
      this.state = "connected";
    } catch (err: unknown) {
      this.state = "error";
      this.stateError = err instanceof Error ? err.message : String(err);
    }
  }

  private readFromAsyncIterable(source: AsyncIterable<Uint8Array>): void {
    (async () => {
      try {
        for await (const chunk of source) {
          this.handleBytes(chunk);
        }
        // stdout closed — the process is gone (defence-in-depth alongside onExit,
        // which some edges never call). Idempotent via handleExit's guard.
        this.handleExit({ code: null });
      } catch {
        this.handleExit({ code: null });
      }
    })();
  }

  private readFromEventSource(source: {
    readonly on: (event: string, cb: (data: Uint8Array) => void) => void;
  }): void {
    source.on("data", (data: Uint8Array) => {
      this.handleBytes(data);
    });
  }

  /**
   * The server process exited (onExit or stdout-end). Transition to a broken
   * state so callers skip it and the manager re-spawns after backoff — instead
   * of polling a corpse for the full timeout on every edit. Idempotent.
   */
  private handleExit(info: ProcessExitInfo): void {
    if (this.state === "error" || this.state === "not-started") return;
    const detail = info.signal !== undefined ? `signal ${info.signal}` : `code ${info.code ?? "?"}`;
    this.markBroken(`language server process exited (${detail})`);
  }

  /**
   * Mark this client permanently broken: kill the process if still alive
   * (corruption case), dispose the rpc (rejects pending requests), and drop
   * edge handles. The manager's status() observes state:"error" and re-spawns
   * after the bounded backoff. Called on process death AND on corruption.
   */
  private markBroken(reason: string): void {
    if (this.state === "error") return;
    this.state = "error";
    this.stateError = reason;
    this.fileWatcherHandle?.close();
    this.fileWatcherHandle = null;
    this.process?.kill();
    this.process = null;
    this.rpc?.dispose();
    this.rpc = null;
    // Release cached document text + diagnostics — the server is dead, so
    // the contents are stale anyway. Keeps a repeatedly-crashed client from
    // accumulating memory across re-spawn cycles.
    this.openDocuments.clear();
    this.lastDiagSnapshot.clear();
  }

  /**
   * Detect a server stuck re-emitting identical non-empty diagnostics
   * despite the file content changing between calls — the signature of a
   * corrupted parse/type-check state (e.g. Steep's ~3h phantom-SyntaxError
   * drift, where a fresh CLI reports green on the same project). After
   * STALE_REPEAT_THRESHOLD consecutive such repeats, mark the client broken
   * so it is skipped + re-spawned. A clean file (empty diagnostics) or a
   * genuinely changing diagnostic set resets the counter. Note the
   * tradeoff: a real, unfixed error on an untouched line also "stays the
   * same across edits", so this can false-positive on a healthy server —
   * the threshold is set conservatively and the CLI type-check gate remains
   * authoritative either way.
   */
  private detectStaleDiagnostics(uri: string, text: string): void {
    const merged = this.diagnostics.getMerged(uri);
    const keys = new Set(merged.map((d) => diagnosticKey(d)));
    const prev = this.lastDiagSnapshot.get(uri);
    if (prev && keys.size > 0 && setsEqual(keys, prev.keys) && text !== prev.text) {
      this.staleRepeat++;
    } else {
      this.staleRepeat = 0;
    }
    this.lastDiagSnapshot.set(uri, { keys, text });
    if (this.staleRepeat >= LanguageServerClient.STALE_REPEAT_THRESHOLD) {
      this.markBroken(
        "language server emitting repeated stale diagnostics despite file changes — likely corrupted; restarting",
      );
    }
  }

  private handleBytes(chunk: Uint8Array): void {
    const messages = this.decoder.decode(chunk);
    for (const msg of messages) {
      // handleMessage is async — catch rejections so a malformed
      // message never becomes an unhandled rejection that crashes
      // the server. (handleMessage also has its own try/catch around
      // JSON.parse, but this is the defence-in-depth boundary.)
      // NOTE the second `?.` before `.catch`: when the server process
      // dies, `markBroken` sets `this.rpc = null`. If stdout then
      // flushes a final chunk, `this.rpc?.handleMessage(msg)` short-
      // circuits to `undefined`, and a plain `.catch()` on `undefined`
      // throws a synchronous TypeError that crashes the process. The
      // extra `?.` makes it `undefined?.catch()` → `undefined`.
      void this.rpc?.handleMessage(msg)?.catch(() => {});
    }
  }

  private setupServerHandlers(rpc: JsonRpcConnection): void {
    rpc.onNotification("textDocument/publishDiagnostics", (params) => {
      this.diagnostics.setPushDiagnostics(params as PublishDiagnosticsParams);
    });

    rpc.onRequest("workspace/configuration", (params) => {
      const { items } = params as { readonly items: readonly { readonly section?: string }[] };
      const init = this.deps.initialization ?? {};
      return items.map((item) => {
        if (item.section) {
          const keys = item.section.split(".");
          let value: unknown = init;
          for (const key of keys) {
            if (value && typeof value === "object" && key in value) {
              value = (value as Record<string, unknown>)[key];
            } else {
              return undefined;
            }
          }
          return value;
        }
        return init;
      });
    });

    rpc.onRequest("workspace/workspaceFolders", () => {
      return [{ uri: `file://${this.root}`, name: this.root }];
    });

    rpc.onRequest("window/workDoneProgress/create", () => null);
    rpc.onRequest("workspace/diagnostic/refresh", () => null);

    rpc.onRequest("client/registerCapability", (params) => {
      const { registrations } = params as {
        readonly registrations: readonly {
          readonly id: string;
          readonly method: string;
          readonly registerOptions?: unknown;
        }[];
      };
      for (const reg of registrations) {
        if (reg.method === "textDocument/diagnostic") {
          // Store diagnostic registration (future use)
        } else if (reg.method === "workspace/didChangeWatchedFiles") {
          const opts = reg.registerOptions as
            | import("./watched-files.js").DidChangeWatchedFilesRegistrationOptions
            | undefined;
          if (opts) {
            this.watchedFiles.applyRegister({
              id: reg.id,
              method: reg.method,
              registerOptions: opts,
            });
          }
        }
      }
      return null;
    });

    rpc.onRequest("client/unregisterCapability", (params) => {
      const { unregistrations } = params as {
        readonly unregistrations: readonly {
          readonly id: string;
          readonly method: string;
        }[];
      };
      for (const unreg of unregistrations) {
        this.watchedFiles.applyUnregister(unreg);
      }
      return null;
    });
  }

  private async initialize(rpc: JsonRpcConnection): Promise<void> {
    const timeout = this.deps.initializeTimeoutMs ?? 45_000;

    // Pass the timeout straight into sendRequest (rather than wrapping in a
    // Promise.race) so that, on expiry, rpc.ts's own timeout handler deletes
    // the pending entry from its `pending` Map. The old Promise.race path
    // rejected the caller but left the original promise (and its closure)
    // lodged in `pending` forever — a slow leak across re-spawns.
    const result = (await rpc.sendRequest(
      "initialize",
      {
        processId: this.process?.pid ?? null,
        rootUri: `file://${this.root}`,
        workspaceFolders: [{ uri: `file://${this.root}`, name: this.root }],
        capabilities: CLIENT_CAPABILITIES,
      },
      timeout,
    )) as {
      readonly capabilities?: {
        readonly textDocumentSync?:
          | number
          | { readonly openClose?: boolean; readonly change?: number }
          | undefined;
      };
    };

    // Capture the server's text document sync mode for didChange.
    const sync = result.capabilities?.textDocumentSync;
    if (typeof sync === "number") {
      this.textDocumentChange = sync as 1 | 2;
    } else if (sync && typeof sync === "object" && sync.change !== undefined) {
      this.textDocumentChange = sync.change as 1 | 2;
    }

    rpc.sendNotification("initialized", {});

    if (this.deps.initialization) {
      rpc.sendNotification("workspace/didChangeConfiguration", {
        settings: this.deps.initialization,
      });
    }

    this.startFileWatcher();
  }

  private startFileWatcher(): void {
    const rootPrefix = this.root.endsWith("/") ? this.root : `${this.root}/`;
    this.fileWatcherHandle = this.deps.fileWatcher(this.root, (event) => {
      const changeType =
        event.type === "create"
          ? FileChangeType.Created
          : event.type === "delete"
            ? FileChangeType.Deleted
            : FileChangeType.Changed;

      const relativePath = event.path.startsWith(rootPrefix)
        ? event.path.slice(rootPrefix.length)
        : event.path.replace(/^\/+/, "");

      if (this.watchedFiles.matches(relativePath)) {
        this.rpc?.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [{ uri: `file://${event.path}`, type: changeType }],
        });
      }
    });
  }

  async open(filePath: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.state !== "connected") return;

    try {
      const text = await this.deps.fs.readText(filePath);
      await this.openWithText(filePath, text);
    } catch {
      // file may not exist
    }
  }

  async openWithText(filePath: string, text: string, langId?: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.state !== "connected") return;

    // If already open, use didChange instead of re-opening.
    if (this.openDocuments.has(filePath)) {
      await this.change(filePath, text);
      return;
    }

    const version = 1;
    this.openDocuments.set(filePath, { version, text });

    rpc.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: `file://${filePath}`,
        languageId: langId ?? resolveLanguageId(filePath),
        version,
        text,
      },
    });

    // Bound the open-document set: evict the least-recently-used (the head
    // of the insertion-ordered Map) when the cap is exceeded. Eviction
    // closes the document on the server and purges its cached text +
    // diagnostics so the maps can't grow without bound.
    this.evictIfOverCap();
  }

  /**
   * If the open-document set exceeds MAX_OPEN_DOCUMENTS, close + purge the
   * least-recently-used entry (the first key in insertion order). No-op
   * while at or below the cap.
   */
  private evictIfOverCap(): void {
    while (this.openDocuments.size > LanguageServerClient.MAX_OPEN_DOCUMENTS) {
      const oldest = this.openDocuments.keys().next().value;
      if (oldest === undefined) break;
      this.closeDocument(oldest);
    }
  }

  /**
   * Close an open document: send textDocument/didClose to the server and
   * release every cached reference to it (openDocuments, lastDiagSnapshot,
   * and the diagnostics store). Idempotent — a no-op for a path that isn't
   * open. This is the lifecycle hook that keeps memory bounded: without it
   * the maps retained every file an agent ever touched (9.5 GB over 12h).
   * Safe to call on a broken/disconnected client (sends nothing, still frees
   * local state).
   */
  closeDocument(filePath: string): void {
    const wasOpen = this.openDocuments.has(filePath);
    this.openDocuments.delete(filePath);
    this.lastDiagSnapshot.delete(filePath);
    const uri = `file://${filePath}`;
    this.diagnostics.purge(uri);

    if (!wasOpen) return;
    const rpc = this.rpc;
    if (rpc && this.state === "connected") {
      rpc.sendNotification("textDocument/didClose", {
        textDocument: { uri },
      });
    }
  }

  async change(filePath: string, newText: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.state !== "connected") return;

    const existing = this.openDocuments.get(filePath);
    if (!existing) {
      // Not open yet — didOpen instead.
      await this.openWithText(filePath, newText);
      return;
    }

    const version = existing.version + 1;
    // Re-insert (delete + set) to move this key to the tail of the insertion-
    // ordered Map = most-recently-used. A plain `set` on an existing key
    // updates the value but leaves its LRU position unchanged, so a hot file
    // opened early could still be evicted first. Deleting first reorders it.
    this.openDocuments.delete(filePath);
    this.openDocuments.set(filePath, { version, text: newText });

    if (this.textDocumentChange === 2) {
      // Incremental sync — compute the minimal change range.
      const changeEvent = computeChangeRange(existing.text, newText);
      rpc.sendNotification("textDocument/didChange", {
        textDocument: { uri: `file://${filePath}`, version },
        contentChanges: [changeEvent],
      });
    } else {
      // Full sync — send the entire content.
      rpc.sendNotification("textDocument/didChange", {
        textDocument: { uri: `file://${filePath}`, version },
        contentChanges: [{ text: newText }],
      });
    }
  }

  async waitForDiagnostics(
    filePath: string,
    opts?: { readonly text?: string; readonly timeoutMs?: number; readonly minSeverity?: number },
  ): Promise<{ readonly formatted: string; readonly slow: boolean; readonly timedOut: boolean }> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const uri = `file://${filePath}`;

    // Clear the "received" flag so we detect fresh publishDiagnostics after our sync.
    this.diagnostics.clearReceived(uri);

    // Sync the document: use didChange with the provided text (post-edit buffer)
    // or fall back to didOpen reading from disk.
    if (opts?.text !== undefined) {
      await this.change(filePath, opts.text);
    } else {
      await this.open(filePath);
    }

    const start = Date.now();

    // Poll until the server pushes diagnostics (even empty = done) or the
    // per-server cap elapses (then we skip it — see aggregateDiagnostics).
    const received = await new Promise<boolean>((resolve) => {
      const check = () => {
        const elapsed = Date.now() - start;
        const got = this.diagnostics.hasReceivedPush(uri);
        if (got || elapsed >= timeoutMs) {
          resolve(got);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    // Only a server that actually pushed can be corruption-checked.
    if (received) {
      this.detectStaleDiagnostics(uri, opts?.text ?? "");
    }

    // `slow` is structurally false now: the per-server cap is 10s, so
    // elapsed can never exceed the old "unusually long" threshold. That
    // warning is superseded by the timeout→skip notice produced in
    // aggregateDiagnostics. The field is kept for contract compatibility.
    return {
      formatted: this.diagnostics.formatFiltered(uri, opts?.minSeverity),
      slow: false,
      timedOut: !received,
    };
  }

  getWatchedFilesRegistry(): WatchedFilesRegistry {
    return this.watchedFiles;
  }

  getDiagnosticsStore(): DiagnosticsStore {
    return this.diagnostics;
  }

  /**
   * Send a request (hover/definition/references/documentSymbol). Capped at
   * REQUEST_TIMEOUT_MS so a dead/slow server can't hang the turn — the
   * initialize handshake bypasses this (it calls rpc.sendRequest directly
   * with its own 45s race).
   */
  async request(
    method: string,
    params?: unknown,
    timeoutMs: number = LanguageServerClient.REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.rpc || this.state !== "connected") {
      throw new Error("Client not connected");
    }
    return this.rpc.sendRequest(method, params, timeoutMs);
  }

  shutdown(): void {
    this.fileWatcherHandle?.close();
    this.fileWatcherHandle = null;
    this.process?.kill();
    this.process = null;
    this.rpc?.dispose();
    this.rpc = null;
    // Drop all cached document text + diagnostics so a shut-down client
    // releases its memory immediately (no lingering references until GC).
    // We don't send didClose here — the server process is being killed.
    this.openDocuments.clear();
    this.lastDiagSnapshot.clear();
    this.state = "not-started";
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
