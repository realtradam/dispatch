/**
 * Language-server client — wires codec + rpc + edges; runs the
 * initialize handshake, honors server→client requests, runs the
 * FileWatcher, and forwards matching disk changes.
 */

import {
  type Diagnostic,
  DiagnosticsStore,
  diagnosticKey,
  type PublishDiagnosticsParams,
  type PushOutcome,
} from "./diagnostics.js";
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
    // Advertise version-bearing publishDiagnostics (LSP 3.15+). Servers that
    // support it echo the document version, which lets the client reject a
    // push from a previous version outright instead of guessing.
    publishDiagnostics: { versionSupport: true },
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
  /**
   * Quiet window (ms) for UNVERSIONED `publishDiagnostics` bursts — default
   * 300. A server that omits `version` gives no way to tell which document
   * version a push belongs to; typescript-language-server emits several pushes
   * per sync and none carries a version.
   *
   * The client treats an unversioned push stream as a burst:
   *  - EVERY push (re)opens the window, including the first push after a cold
   *    start (typescript-language-server's first push lands seconds after
   *    `didOpen`, followed by more over the next ~200 ms). A push is only
   *    trusted once no further push has arrived for the whole window.
   *  - A `didChange` that lands inside the window is DEFERRED to the window's
   *    end, so a late push from the previous generation can never satisfy it.
   *
   * The longer default is safe: checks are background work now, and notice
   * latency matters far less than reporting the right content's diagnostics.
   * Exposed so tests can shrink it.
   */
  readonly unversionedSettleMs?: number | undefined;
  /**
   * Grace period (ms) before a sync with NO push at all is treated as
   * "diagnostics unchanged" — default 1500. Some servers (notably
   * typescript-language-server 5.3.0) suppress the push entirely when a
   * diagnostic kind was empty and stays empty, so a clean→clean edit is
   * indistinguishable from a slow server except by waiting. The fallback is
   * deliberately narrow: it applies only when the document's last reported
   * diagnostics were EMPTY (so "unchanged" means "still clean") and only after
   * a grace comfortably longer than the observed response latency, so a slow
   * server that is about to report a NEW error is not pre-empted.
   */
  readonly noPushGraceMs?: number | undefined;
  /**
   * Containment hook for errors caught at the client's UNTRUSTED edges —
   * timers, rpc notification handlers, process-exit and file-watcher
   * callbacks, and stdin writes. Such callbacks are invoked by the runtime
   * (or by a dying child process), so a throw there would escape into an
   * `uncaughtException` and could take the whole host down; the client catches
   * and reports instead. Implementations MUST NOT throw.
   */
  readonly onError?: ((where: string, error: unknown) => void) | undefined;
}

export type ClientState = "starting" | "connected" | "error" | "not-started";

/**
 * Per-URI synchronization bookkeeping for diagnostics. Keyed by URI (not
 * filePath) because that is what `publishDiagnostics` carries.
 *
 * `settling` is the unversioned quiet window: true from the moment a sync is
 * sent until no push has arrived for `unversionedSettleMs`. `pending` holds the
 * latest content whose sync was DEFERRED because it landed inside an open's
 * quiet window (see the class docs on `waitForDiagnostics`).
 */
interface SyncState {
  readonly uri: string;
  readonly filePath: string;
  /** Last document version written to the server (didOpen/didChange). */
  version: number;
  /** True while unversioned pushes may still be in flight for this sync. */
  settling: boolean;
  /** Set once the server proves it echoes versions — no debounce needed after that. */
  versioned: boolean;
  /** A push has arrived for the current sync (guards `settled` resolution). */
  pushSinceSync: boolean;
  /** Latest content whose sync was deferred until the quiet window closes. */
  pending: { readonly text: string } | { readonly fromDisk: true } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Default quiet window for unversioned diagnostic bursts. */
const UNVERSIONED_SETTLE_MS = 300;
/**
 * Default grace before "no push at all" means "diagnostics unchanged". Must be
 * comfortably above the observed push latency (~400 ms warm) so a slow server
 * reporting a NEW issue is not pre-empted.
 */
const NO_PUSH_GRACE_MS = 1500;

export interface WaitForDiagnosticsResult {
  /** Formatted diagnostics (filtered by `minSeverity`), empty if none. */
  readonly formatted: string;
  /** Structurally false — retained for contract compatibility. */
  readonly slow: boolean;
  /** True when the wait hit its cap or the client broke before a push. */
  readonly timedOut: boolean;
  /** The merged (push + pull) diagnostics behind `formatted`, for structured diffs. */
  readonly diagnostics: readonly Diagnostic[];
}

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
  /**
   * Per-URI diagnostics synchronization state (quiet windows, deferred
   * changes). Keyed by URI; cleared on close/broken/shutdown.
   */
  private syncStates = new Map<string, SyncState>();
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
      // A write failure during initialize marks the client broken; never mask
      // that with "connected" (the manager must see the error and re-spawn).
      if (this.getState() !== "error") this.state = "connected";
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
    // Called from the spawn adapter's exit hook (and from stdout-end inside an
    // async loop). It must never throw back into the process runtime.
    try {
      if (this.state === "error" || this.state === "not-started") return;
      const detail =
        info.signal !== undefined ? `signal ${info.signal}` : `code ${info.code ?? "?"}`;
      this.markBroken(`language server process exited (${detail})`);
    } catch (error: unknown) {
      this.report("process exit", error);
    }
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
    // Every teardown step touches an edge that can fail (a closed watcher, a
    // process that already exited, an rpc whose socket rejected). Containment:
    // none of them may stop the rest of the teardown or escape the caller.
    try {
      this.fileWatcherHandle?.close();
    } catch (error: unknown) {
      this.report("watcher close", error);
    }
    this.fileWatcherHandle = null;
    try {
      this.process?.kill();
    } catch (error: unknown) {
      this.report("process kill", error);
    }
    this.process = null;
    try {
      this.rpc?.dispose();
    } catch (error: unknown) {
      this.report("rpc dispose", error);
    }
    this.rpc = null;
    // Release cached document text + diagnostics — the server is dead, so
    // the contents are stale anyway. Keeps a repeatedly-crashed client from
    // accumulating memory across re-spawn cycles. Pending diagnostic waiters
    // resolve NOW (as failed) rather than polling a corpse until the cap.
    this.openDocuments.clear();
    this.lastDiagSnapshot.clear();
    try {
      this.clearSyncStates();
    } catch (error: unknown) {
      this.report("sync cleanup", error);
    }
    try {
      this.diagnostics.failAllPushWaiters(reason);
    } catch (error: unknown) {
      this.report("waiter cleanup", error);
    }
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

  /**
   * Report an error caught at an untrusted edge. The reporting hook itself is
   * untrusted (it is injected) and must never break containment.
   */
  private report(where: string, error: unknown): void {
    try {
      this.deps.onError?.(where, error);
    } catch {
      // A throwing reporter must not defeat the containment it exists for.
    }
  }

  /**
   * write a JSON-RPC notification, containing any stdin failure (EPIPE when
   * the child died mid-write, a closed pipe, a throwing spawn adapter). A
   * failed write means the server is unusable, so the client is marked broken —
   * which fails pending waiters and lets the manager re-spawn later.
   */
  private notify(method: string, params: unknown): boolean {
    const rpc = this.rpc;
    if (!rpc) return false;
    try {
      rpc.sendNotification(method, params);
      return true;
    } catch (error: unknown) {
      this.report(`sendNotification(${method})`, error);
      this.markBroken(`failed to write ${method}: ${errorText(error)}`);
      return false;
    }
  }

  private handleBytes(chunk: Uint8Array): void {
    // stdout 'data' handlers are invoked by the runtime with no caller to
    // catch anything we throw: a framing/decoder error must stop here.
    let messages: readonly string[];
    try {
      messages = this.decoder.decode(chunk);
    } catch (error: unknown) {
      this.report("frame decode", error);
      return;
    }
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
      try {
        void this.rpc
          ?.handleMessage(msg)
          ?.catch((error: unknown) => this.report("rpc message", error));
      } catch (error: unknown) {
        this.report("rpc dispatch", error);
      }
    }
  }

  private setupServerHandlers(rpc: JsonRpcConnection): void {
    rpc.onNotification("textDocument/publishDiagnostics", (params) => {
      this.handlePush(params as PublishDiagnosticsParams);
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

    this.notify("initialized", {});

    if (this.deps.initialization) {
      this.notify("workspace/didChangeConfiguration", {
        settings: this.deps.initialization,
      });
    }

    this.startFileWatcher();
  }

  private startFileWatcher(): void {
    this.fileWatcherHandle = this.deps.fileWatcher(this.root, (event) => {
      // fs.watch invokes this with no caller to catch a throw.
      try {
        this.forwardFileEvent(event);
      } catch (error: unknown) {
        this.report("file watcher event", error);
      }
    });
  }

  private forwardFileEvent(event: {
    readonly type: "create" | "change" | "delete";
    readonly path: string;
  }): void {
    const rootPrefix = this.root.endsWith("/") ? this.root : `${this.root}/`;
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
      this.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: `file://${event.path}`, type: changeType }],
      });
    }
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

    const sync = this.beginSync(filePath, version);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: sync.uri,
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
   * sync state, and the diagnostics store). Idempotent — a no-op for a path
   * that isn't open. This is the lifecycle hook that keeps memory bounded:
   * without it the maps retained every file an agent ever touched (9.5 GB
   * over 12h). Pending waiters resolve immediately (as failed) — a closed
   * document will never produce the push they are waiting for.
   * Safe to call on a broken/disconnected client (sends nothing, still frees
   * local state).
   */
  closeDocument(filePath: string): void {
    const wasOpen = this.openDocuments.has(filePath);
    this.openDocuments.delete(filePath);
    this.lastDiagSnapshot.delete(filePath);
    const uri = uriFor(filePath);
    this.clearSyncState(uri);
    this.diagnostics.purge(uri);

    if (!wasOpen) return;
    this.notify("textDocument/didClose", {
      textDocument: { uri },
    });
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

    if (existing.text === newText) {
      // Nothing changed: the server already holds exactly this content, and
      // re-sending an identical didChange can make some servers skip the push
      // entirely (bumping the version while never answering it). Leave the
      // sync state untouched — `waitForDiagnostics` reports from the store.
      return;
    }

    const sync = this.syncStates.get(uriFor(filePath));
    if (sync?.settling && !sync.versioned) {
      // Unversioned quiet window still open (typically right after didOpen,
      // where typescript-language-server emits a SECOND push for the old
      // generation). Sending didChange now would race that late push; an
      // unversioned push carries no version to reject it. Defer the sync —
      // only the latest content matters — until the window closes.
      sync.pending = { text: newText };
      return;
    }

    this.sendChange(filePath, newText);
  }

  /**
   * Write a didChange for a document that is already open. Sets the sync
   * generation BEFORE writing to the pipe so a fast response can never be
   * attributed to the previous version, and arms the unversioned quiet window.
   */
  private sendChange(filePath: string, newText: string): void {
    try {
      this.sendChangeInner(filePath, newText);
    } catch (error: unknown) {
      this.report("didChange", error);
    }
  }

  private sendChangeInner(filePath: string, newText: string): void {
    const existing = this.openDocuments.get(filePath);
    if (!this.rpc || this.state !== "connected" || !existing) return;

    const version = existing.version + 1;
    // Re-insert (delete + set) to move this key to the tail of the insertion-
    // ordered Map = most-recently-used. A plain `set` on an existing key
    // updates the value but leaves its LRU position unchanged, so a hot file
    // opened early could still be evicted first. Deleting first reorders it.
    this.openDocuments.delete(filePath);
    this.openDocuments.set(filePath, { version, text: newText });

    const sync = this.beginSync(filePath, version);
    if (this.textDocumentChange === 2) {
      // Incremental sync — compute the minimal change range.
      const changeEvent = computeChangeRange(existing.text, newText);
      this.notify("textDocument/didChange", {
        textDocument: { uri: sync.uri, version },
        contentChanges: [changeEvent],
      });
    } else {
      // Full sync — send the entire content.
      this.notify("textDocument/didChange", {
        textDocument: { uri: sync.uri, version },
        contentChanges: [{ text: newText }],
      });
    }
  }

  /** Start a new sync generation for `filePath` and arm its quiet window. */
  private beginSync(filePath: string, version: number): SyncState {
    const uri = uriFor(filePath);
    const previous = this.syncStates.get(uri);
    if (previous?.timer) clearTimeout(previous.timer);
    const sync: SyncState = {
      uri,
      filePath,
      version,
      settling: true,
      versioned: previous?.versioned ?? false,
      pushSinceSync: false,
      pending: null,
      timer: null,
    };
    this.syncStates.set(uri, sync);
    this.armSettle(sync);
    return sync;
  }

  /** (Re)arm the quiet window. Each push extends it until the burst ends. */
  private armSettle(sync: SyncState): void {
    if (sync.timer) clearTimeout(sync.timer);
    sync.settling = true;
    const timer = setTimeout(() => {
      // Timer callbacks have no caller to catch a throw: containment.
      try {
        sync.timer = null;
        this.finishSettle(sync.uri);
      } catch (error: unknown) {
        this.report("settle timer", error);
      }
    }, this.deps.unversionedSettleMs ?? UNVERSIONED_SETTLE_MS);
    // Never hold the process open for a background quiet window.
    (timer as { unref?: () => void }).unref?.();
    sync.timer = timer;
  }

  /**
   * The quiet window closed: the store's contents are final for the sync that
   * armed it, so let waiters take them. Any change deferred during the window
   * is then written — AFTER the waiters resolved, so its push cannot be
   * confused with the settled generation.
   */
  private finishSettle(uri: string): void {
    // Called from a timer and from a versioned push handler; contain anything
    // thrown by the deferred-sync flush (e.g. a write to a dead child).
    try {
      this.finishSettleInner(uri);
    } catch (error: unknown) {
      this.report("finishSettle", error);
    }
  }

  private finishSettleInner(uri: string): void {
    const sync = this.syncStates.get(uri);
    if (sync === undefined || !sync.settling) return;
    if (sync.timer) {
      clearTimeout(sync.timer);
      sync.timer = null;
    }
    sync.settling = false;
    this.diagnostics.settlePushWaiters(uri);

    const pending = sync.pending;
    sync.pending = null;
    if (pending === null) return;
    if ("text" in pending) {
      this.sendChange(sync.filePath, pending.text);
      return;
    }
    // Re-open from disk (content was not supplied). Fire-and-forget: the
    // caller's own wait resolves on the push this produces.
    void this.deps.fs
      .readText(sync.filePath)
      .then((text) => this.sendChange(sync.filePath, text))
      .catch((error: unknown) => {
        // Vanished/unreadable file — nothing to sync; never reject.
        this.report("read for deferred sync", error);
      });
  }

  private clearSyncState(uri: string): void {
    const sync = this.syncStates.get(uri);
    if (sync?.timer) clearTimeout(sync.timer);
    this.syncStates.delete(uri);
  }

  private clearSyncStates(): void {
    for (const sync of this.syncStates.values()) {
      if (sync.timer) clearTimeout(sync.timer);
    }
    this.syncStates.clear();
  }

  /**
   * Accept a `publishDiagnostics` push. Rules:
   *  - Versioned push: drop if it is older than the version we last wrote.
   *  - Versioned push during a window: the server has proven it echoes
   *    versions, so end the window immediately (the next change need not be
   *    deferred).
   *  - Unversioned push: it belongs to a burst whose boundaries the protocol
   *    does not reveal. (Re)open the quiet window — including for the FIRST
   *    push after a cold start, where the initial window has already expired
   *    with no push at all (typescript-language-server takes ~2.4 s to push
   *    once and then emits more over the next ~200 ms). A push is trusted only
   *    when the burst goes quiet.
   */
  private handlePush(params: PublishDiagnosticsParams): void {
    // Invoked from an rpc notification handler; a malformed payload must not
    // escape into the runtime's message loop.
    try {
      this.handlePushInner(params);
    } catch (error: unknown) {
      this.report("publishDiagnostics", error);
    }
  }

  private handlePushInner(params: PublishDiagnosticsParams): void {
    const sync = this.syncStates.get(params.uri);
    if (sync !== undefined && params.version !== undefined && params.version < sync.version) {
      return; // stale: belongs to a document version we have already replaced
    }

    if (sync !== undefined) {
      sync.pushSinceSync = true;
      if (params.version !== undefined) {
        sync.versioned = true;
      } else {
        // Arm BEFORE storing/notifying: waiters must observe `settling` and
        // hold the push until the burst goes quiet.
        this.armSettle(sync);
      }
    }

    this.diagnostics.setPushDiagnostics(params);

    if (sync === undefined) return;
    if (params.version !== undefined && sync.settling) {
      this.finishSettle(params.uri);
    }
  }

  /** Version the next `waitForDiagnostics` sync will write for `filePath`. */
  private nextSyncVersion(filePath: string): number {
    const doc = this.openDocuments.get(filePath);
    return doc === undefined ? 1 : doc.version + 1;
  }

  /**
   * Does `outcome` satisfy a wait targeting `targetVersion`? `version` is the
   * only trustworthy discriminator; without it the quiet window is the best
   * available proxy.
   */
  private satisfiesWait(uri: string, targetVersion: number, outcome: PushOutcome): boolean {
    if (outcome.kind === "failed") return true;
    const sync = this.syncStates.get(uri);
    if (sync === undefined) {
      // No sync on record: either the sync was never written (disconnected) or
      // this push predates it (e.g. a workspace scan for a file we are about
      // to open). Neither can be trusted as the result of THIS call.
      return false;
    }
    if (outcome.kind === "push" && outcome.params.version !== undefined) {
      return outcome.params.version >= targetVersion;
    }
    if (sync.settling) return false;
    if (!sync.pushSinceSync) return false;
    return sync.version >= targetVersion;
  }

  /**
   * Sync `filePath` to the server and wait for the diagnostics that reflect
   * THAT content.
   *
   * Event-driven: the waiter resolves when the matching push arrives (or the
   * unversioned quiet window closes), never on a poll tick, and resolves
   * IMMEDIATELY if the client breaks or the document closes while waiting.
   *
   * Stale-push protection:
   *  - Versioned pushes are accepted only when `version >= targetVersion`
   *    (the version this call is about to write).
   *  - Unversioned pushes are held until a quiet window with no further push
   *    closes (every push reopens it, including the first one after a cold
   *    start), and a didChange that lands inside a window is deferred to its
   *    end — so the extra pushes typescript-language-server emits after
   *    `didOpen` can never satisfy an edit's wait.
   *  - A NO-OP sync (the requested content is already the document's content)
   *    sends nothing and resolves from the store: the server already holds
   *    this content, and re-sending an identical didChange may produce no push
   *    at all.
   */
  async waitForDiagnostics(
    filePath: string,
    opts?: { readonly text?: string; readonly timeoutMs?: number; readonly minSeverity?: number },
  ): Promise<WaitForDiagnosticsResult> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const uri = uriFor(filePath);

    // The version the wait targets. For a real sync this is the version the
    // sync will write; a no-op sync keeps the document's current version.
    let targetVersion = this.nextSyncVersion(filePath);

    let resolveWait!: (value: boolean) => void;
    const waited = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });

    const waiter = this.diagnostics.addPushWaiter(uri, (outcome) => {
      if (outcome.kind === "failed") {
        resolveWait(false); // client broke → report as skipped, never hang
        return;
      }
      if (this.satisfiesWait(uri, targetVersion, outcome)) resolveWait(true);
    });
    const timer = setTimeout(() => resolveWait(false), timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    // Some servers send NO push when a change leaves the diagnostics empty and
    // they were already empty (typescript-language-server suppresses exactly
    // that case). Waiting the full cap would turn every clean edit into a
    // spurious "took too long". After a bounded grace, resolve as "unchanged"
    // — but only when the last reported set was empty, so a slow server about
    // to report a new issue keeps waiting.
    const grace = setTimeout(() => {
      try {
        if (this.isUnchangedEmptyResult(uri, targetVersion)) resolveWait(true);
      } catch (error: unknown) {
        this.report("no-push grace timer", error);
      }
    }, this.deps.noPushGraceMs ?? NO_PUSH_GRACE_MS);
    (grace as { unref?: () => void }).unref?.();

    // Sync AFTER the waiter is registered so a push that races the write is
    // never missed. `change`/`open` may defer the actual write (quiet window).
    try {
      let text = opts?.text ?? null;
      if (text === null) {
        try {
          text = await this.deps.fs.readText(filePath);
        } catch {
          text = null; // vanished/unreadable: `open` degrades the same way
        }
      }

      const docBefore = this.openDocuments.get(filePath);
      const noOp = text !== null && docBefore !== undefined && docBefore.text === text;
      if (noOp && docBefore !== undefined) targetVersion = docBefore.version;

      if (text !== null) {
        await this.openWithText(filePath, text);
      } else {
        await this.open(filePath);
      }

      // The document already holds this content and the current sync has
      // already reported: the store IS the answer (no push will come back).
      if (noOp && this.syncAlreadyReported(uri)) resolveWait(true);

      const received = await waited;
      if (received) this.detectStaleDiagnostics(uri, text ?? "");
      return {
        formatted: this.diagnostics.formatFiltered(uri, opts?.minSeverity),
        diagnostics: this.filteredDiagnostics(uri, opts?.minSeverity),
        slow: false,
        timedOut: !received,
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      waiter.cancel();
    }
  }

  /**
   * True when a wait has received NO push for its sync and the document's last
   * reported diagnostics were empty. Servers that suppress empty→empty pushes
   * (typescript-language-server) will never answer such a sync, so "no push"
   * is the answer: still clean.
   */
  private isUnchangedEmptyResult(uri: string, targetVersion: number): boolean {
    const sync = this.syncStates.get(uri);
    if (sync === undefined) return false;
    if (sync.version < targetVersion) return false; // sync not written yet
    if (sync.pushSinceSync) return false; // a push arrived; normal path applies
    if (!this.diagnostics.hasReceivedPush(uri)) return false; // never reported yet
    return this.diagnostics.getMerged(uri).length === 0;
  }

  /**
   * True when the current sync generation has produced a push and its burst
   * (for unversioned servers) has gone quiet — i.e. the store holds final
   * diagnostics for the document's current content.
   */
  private syncAlreadyReported(uri: string): boolean {
    const sync = this.syncStates.get(uri);
    return sync?.pushSinceSync === true && !sync.settling;
  }

  /** Merged (push + pull) diagnostics for `uri`, optionally severity-filtered. */
  private filteredDiagnostics(uri: string, minSeverity?: number): readonly Diagnostic[] {
    const merged = this.diagnostics.getMerged(uri);
    if (minSeverity === undefined) return merged;
    return merged.filter((d) => (d.severity ?? 0) <= minSeverity);
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
    // Called from deactivate() and the manager; must never throw (a throwing
    // deactivate can leave the host's unload sweep half-done).
    try {
      this.fileWatcherHandle?.close();
    } catch (error: unknown) {
      this.report("watcher close", error);
    }
    this.fileWatcherHandle = null;
    try {
      this.process?.kill();
    } catch (error: unknown) {
      this.report("process kill", error);
    }
    this.process = null;
    try {
      this.rpc?.dispose();
    } catch (error: unknown) {
      this.report("rpc dispose", error);
    }
    this.rpc = null;
    // Drop all cached document text + diagnostics so a shut-down client
    // releases its memory immediately (no lingering references until GC).
    // We don't send didClose here — the server process is being killed.
    // Pending waiters resolve NOW instead of sitting out their cap.
    try {
      this.clearSyncStates();
    } catch (error: unknown) {
      this.report("sync cleanup", error);
    }
    this.openDocuments.clear();
    this.lastDiagSnapshot.clear();
    try {
      this.diagnostics.failAllPushWaiters("language server client shut down");
    } catch (error: unknown) {
      this.report("waiter cleanup", error);
    }
    this.state = "not-started";
  }
}

/** LSP document URI for an absolute file path. */
function uriFor(filePath: string): string {
  return `file://${filePath}`;
}

/** Human-readable message for an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
