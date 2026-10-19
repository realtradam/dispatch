import { describe, expect, it } from "vitest";
import {
  type FileWatcher,
  type FsAccess,
  LanguageServerClient,
  type ProcessExitHandler,
  type SpawnProcess,
} from "./client.js";
import { encode } from "./framing.js";

function makeClient(overrides?: {
  readonly spawn?: SpawnProcess;
  readonly fileWatcher?: FileWatcher;
  readonly fs?: FsAccess;
  readonly initialization?: Record<string, unknown>;
  readonly initializeTimeoutMs?: number;
  readonly unversionedSettleMs?: number;
  readonly noPushGraceMs?: number;
}): {
  client: LanguageServerClient;
  stdinChunks: Uint8Array[];
  serverResponses: (msg: string) => void;
} {
  const stdinChunks: Uint8Array[] = [];
  let serverMessageHandler: ((msg: string) => void) | null = null;

  const mockSpawn: SpawnProcess = () => ({
    stdin: { write: (bytes) => stdinChunks.push(bytes) },
    stdout: {
      on: (_event: string, cb: (data: Uint8Array) => void) => {
        // We'll feed messages through serverResponses
        serverMessageHandler = (msg: string) => {
          cb(encode(msg));
        };
      },
    },
    pid: 123,
    kill: () => {},
  });

  const mockFileWatcher: FileWatcher = (_root, _onEvent) => ({
    close: () => {},
  });

  const mockFs: FsAccess = {
    readText: async (path) => `// content of ${path}`,
    exists: async () => true,
  };

  const client = new LanguageServerClient({
    spawn: overrides?.spawn ?? mockSpawn,
    fileWatcher: overrides?.fileWatcher ?? mockFileWatcher,
    fs: overrides?.fs ?? mockFs,
    command: ["test-lsp"],
    root: "/project",
    serverId: "test",
    ...(overrides?.initialization ? { initialization: overrides.initialization } : {}),
    ...(overrides?.initializeTimeoutMs !== undefined
      ? { initializeTimeoutMs: overrides.initializeTimeoutMs }
      : {}),
    ...(overrides?.unversionedSettleMs !== undefined
      ? { unversionedSettleMs: overrides.unversionedSettleMs }
      : {}),
    ...(overrides?.noPushGraceMs !== undefined ? { noPushGraceMs: overrides.noPushGraceMs } : {}),
  });

  return {
    client,
    stdinChunks,
    serverResponses: (msg: string) => serverMessageHandler?.(msg),
  };
}

describe("client", () => {
  it("initialize declares didChangeWatchedFiles.dynamicRegistration true", async () => {
    const { client, stdinChunks, serverResponses } = makeClient();

    const startPromise = client.start();

    // Wait for the initialize message to be sent
    await new Promise((r) => setTimeout(r, 50));

    // Parse the sent messages to find initialize
    const sentMessages = stdinChunks.map((chunk) => {
      const decoded = new TextDecoder().decode(chunk);
      const headerEnd = decoded.indexOf("\r\n\r\n");
      return JSON.parse(decoded.slice(headerEnd + 4));
    });

    const initMsg = sentMessages.find((m: { method?: string }) => m.method === "initialize");
    expect(initMsg).toBeDefined();
    expect(initMsg.params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration).toBe(
      true,
    );

    // Send initialize response
    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initMsg.id,
        result: { capabilities: {} },
      }),
    );

    await startPromise;
    expect(client.getState()).toBe("connected");
  });

  it("honors registerCapability for BOTH textDocument/diagnostic and workspace/didChangeWatchedFiles", async () => {
    const { client, serverResponses } = makeClient();
    const startPromise = client.start();

    await new Promise((r) => setTimeout(r, 50));

    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: {} },
      }),
    );

    await startPromise;

    // Register workspace/didChangeWatchedFiles
    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "client/registerCapability",
        params: {
          registrations: [
            {
              id: "reg-watched",
              method: "workspace/didChangeWatchedFiles",
              registerOptions: {
                watchers: [{ globPattern: "**/*.luau" }],
              },
            },
            {
              id: "reg-diag",
              method: "textDocument/diagnostic",
              registerOptions: {},
            },
          ],
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const registry = client.getWatchedFilesRegistry();
    expect(registry.matches("src/main.luau")).toBe(true);
    expect(registry.matches("src/main.ts")).toBe(false);
  });

  it("an injected fs change for a registered glob sends workspace/didChangeWatchedFiles type=Changed (opencode-bug regression)", async () => {
    const callbackHolder: {
      cb:
        | ((e: { readonly type: "create" | "change" | "delete"; readonly path: string }) => void)
        | null;
    } = { cb: null };

    const trackingFileWatcher: FileWatcher = (_root, onEvent) => {
      callbackHolder.cb = onEvent;
      return { close: () => {} };
    };

    const { client, stdinChunks, serverResponses } = makeClient({
      fileWatcher: trackingFileWatcher,
    });

    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));

    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: {} },
      }),
    );

    await startPromise;

    // Register a watcher for sourcemap.json
    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "client/registerCapability",
        params: {
          registrations: [
            {
              id: "reg-1",
              method: "workspace/didChangeWatchedFiles",
              registerOptions: {
                watchers: [{ globPattern: "sourcemap.json" }],
              },
            },
          ],
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 100));

    // Simulate a file change
    const onFsEvent = callbackHolder.cb;
    if (!onFsEvent) throw new Error("file watcher callback was never registered");
    onFsEvent({ type: "change", path: "/project/sourcemap.json" });

    await new Promise((r) => setTimeout(r, 100));

    // Check that the notification was sent
    const sentMessages = stdinChunks.map((chunk) => {
      const decoded = new TextDecoder().decode(chunk);
      const headerEnd = decoded.indexOf("\r\n\r\n");
      return JSON.parse(decoded.slice(headerEnd + 4));
    });

    const didChangeMsg = sentMessages.find(
      (m: { method?: string }) => m.method === "workspace/didChangeWatchedFiles",
    );
    expect(didChangeMsg).toBeDefined();
    expect(didChangeMsg.params.changes[0].uri).toBe("file:///project/sourcemap.json");
    expect(didChangeMsg.params.changes[0].type).toBe(2); // Changed
  });

  it("publishDiagnostics are stored + returned", async () => {
    const { client, serverResponses } = makeClient();
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));

    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: {} },
      }),
    );

    await startPromise;

    // Send diagnostics
    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///project/test.ts",
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1,
              message: "Test error",
            },
          ],
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const store = client.getDiagnosticsStore();
    const formatted = store.format("file:///project/test.ts");
    expect(formatted).toContain("ERROR");
    expect(formatted).toContain("Test error");
  });

  it("shutdown kills the process", async () => {
    const state = { killed: false };
    const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    const killableSpawn: SpawnProcess = () => ({
      stdin: { write: () => {} },
      stdout: {
        on: (_event: string, cb: (data: Uint8Array) => void) => {
          stdoutHolder.cb = cb;
        },
      },
      pid: 123,
      kill: () => {
        state.killed = true;
      },
    });

    const { client } = makeClient({ spawn: killableSpawn });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));

    // Deliver the initialize response through the spawned process's own
    // stdout (the real read path), so start() can complete the handshake.
    stdoutHolder.cb?.(
      encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
    );

    await startPromise;

    client.shutdown();
    expect(state.killed).toBe(true);
  });

  it("onExit marks the client broken (error) so callers stop querying a corpse", async () => {
    const state = { killed: false };
    let exitCb: ProcessExitHandler | null = null;
    const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };

    const spawnWithExit: SpawnProcess = () => ({
      stdin: { write: () => {} },
      stdout: {
        on: (_event: string, cb: (data: Uint8Array) => void) => {
          stdoutHolder.cb = cb;
        },
      },
      pid: 999,
      kill: () => {
        state.killed = true;
      },
      onExit: (handler) => {
        exitCb = handler;
      },
    });

    const { client } = makeClient({ spawn: spawnWithExit });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    stdoutHolder.cb?.(
      encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
    );
    await startPromise;
    expect(client.getState()).toBe("connected");

    // Simulate the process dying (user kill / crash).
    exitCb?.({ code: 1 });

    expect(client.getState()).toBe("error");
    expect(client.getStateError()).toMatch(/process exited/);
    // The (still-alive-in-test) process was killed to avoid a zombie.
    expect(state.killed).toBe(true);
  });

  it("a dead client is skipped by waitForDiagnostics callers (state !== connected)", async () => {
    // Build a client, connect, kill via onExit, then assert a diagnostics
    // query would not block: getState() is "error" so the matching filter
    // (state === "connected") excludes it. We assert the state guard.
    const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    let exitCb: ProcessExitHandler | null = null;
    const spawnWithExit: SpawnProcess = () => ({
      stdin: { write: () => {} },
      stdout: {
        on: (_e, cb) => {
          stdoutHolder.cb = cb;
        },
      },
      pid: 1,
      kill: () => {},
      onExit: (handler) => {
        exitCb = handler;
      },
    });

    const { client } = makeClient({ spawn: spawnWithExit });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    stdoutHolder.cb?.(
      encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
    );
    await startPromise;

    exitCb?.({ code: null });
    expect(client.getState()).toBe("error");
    // The aggregate / getDiagnostics matching filter requires "connected".
    expect(client.getState() === "connected").toBe(false);
  });

  it("corruption detector marks the client broken after repeated identical diagnostics despite text changes", async () => {
    // A healthy server would change diagnostics as the file changes; a
    // corrupted one re-emits the SAME non-empty set. Drive 5 edits with
    // different text but identical diagnostics → client flips to error.
    const { client, serverResponses } = makeClient({ unversionedSettleMs: 20 });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    await startPromise;

    const phantom = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///project/game.rb",
        diagnostics: [
          {
            range: { start: { line: 0, character: 27 }, end: { line: 0, character: 28 } },
            severity: 1,
            message: "SyntaxError: unexpected token",
          },
        ],
      },
    });

    const path = "/project/game.rb";
    // The first call establishes the baseline snapshot (no increment).
    // Each subsequent call with identical diagnostics + changed text
    // increments; the 6th call (5th increment) trips the threshold.
    for (let i = 1; i <= 5; i++) {
      const p = client.waitForDiagnostics(path, { text: `buf-v${i}`, timeoutMs: 2000 });
      // Push the identical phantom diagnostics so the poll resolves.
      await new Promise((r) => setTimeout(r, 30));
      serverResponses(phantom);
      await p;
      expect(client.getState()).toBe("connected");
    }
    // 6th identical-across-changed-text repeat trips the threshold.
    const p6 = client.waitForDiagnostics(path, { text: "buf-v6", timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 30));
    serverResponses(phantom);
    await p6;

    expect(client.getState()).toBe("error");
    expect(client.getStateError()).toMatch(/repeated stale diagnostics/i);
  });

  it("corruption detector does NOT trip on a clean file (empty diagnostics stay identical)", async () => {
    const { client, serverResponses } = makeClient({ unversionedSettleMs: 20 });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    await startPromise;

    const clean = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///project/game.rb", diagnostics: [] },
    });
    const path = "/project/game.rb";

    for (let i = 1; i <= 6; i++) {
      const p = client.waitForDiagnostics(path, { text: `clean-v${i}`, timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 30));
      serverResponses(clean);
      await p;
    }
    // Empty diagnostics never count as "stale" — a clean file staying clean
    // is normal, not corruption.
    expect(client.getState()).toBe("connected");
  });

  it("handleBytes does not crash when the server dies and rpc is null (Bug 1)", async () => {
    // When the process dies, markBroken() sets this.rpc = null. If stdout
    // then flushes a final chunk, the old code `this.rpc?.handleMessage(msg).catch()`
    // threw a synchronous TypeError: Cannot read properties of undefined
    // (reading 'catch') — undefined.catch. The fix adds a second `?.`.
    const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    let exitCb: ProcessExitHandler | null = null;
    const spawnWithExit: SpawnProcess = () => ({
      stdin: { write: () => {} },
      stdout: {
        on: (_e, cb) => {
          stdoutHolder.cb = cb;
        },
      },
      pid: 1,
      kill: () => {},
      onExit: (handler) => {
        exitCb = handler;
      },
    });

    const { client } = makeClient({ spawn: spawnWithExit });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    stdoutHolder.cb?.(
      encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
    );
    await startPromise;
    expect(client.getState()).toBe("connected");

    // Kill the server — rpc is now null.
    exitCb?.({ code: 1 });
    expect(client.getState()).toBe("error");

    // A final stdout chunk must NOT throw (the regression crashed here).
    expect(() => {
      stdoutHolder.cb?.(encode(JSON.stringify({ jsonrpc: "2.0", method: "foo", params: {} })));
    }).not.toThrow();
  });

  it("closeDocument sends textDocument/didClose and purges cached text + diagnostics (Bug 3)", async () => {
    const { client, stdinChunks, serverResponses } = makeClient();
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    await startPromise;

    // Open a doc + receive some diagnostics.
    await client.openWithText("/project/a.ts", "const x = 1;\n");
    serverResponses(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///project/a.ts",
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1,
              message: "unused",
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const store = client.getDiagnosticsStore();
    expect(store.format("file:///project/a.ts")).toContain("unused");

    client.closeDocument("/project/a.ts");

    // didClose was sent.
    const sent = stdinChunks.map((chunk) => {
      const decoded = new TextDecoder().decode(chunk);
      const headerEnd = decoded.indexOf("\r\n\r\n");
      return JSON.parse(decoded.slice(headerEnd + 4));
    });
    const didClose = sent.find((m: { method?: string }) => m.method === "textDocument/didClose");
    expect(didClose).toBeDefined();
    expect(didClose.params.textDocument.uri).toBe("file:///project/a.ts");

    // Cached text + diagnostics are gone.
    expect(store.format("file:///project/a.ts")).toBe("");
    expect(store.hasReceivedPush("file:///project/a.ts")).toBe(false);
  });

  it("opening more than the LRU cap evicts the least-recently-used document (Bug 3)", async () => {
    const { client, stdinChunks, serverResponses } = makeClient();
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));
    serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    await startPromise;

    const CAP = 50;
    // Open `CAP` documents (the first is the LRU eviction candidate).
    for (let i = 0; i < CAP; i++) {
      await client.openWithText(`/project/file${i}.ts`, `content ${i}`);
    }

    const sentBefore = stdinChunks.length;

    // Touching an early doc (file1) promotes it: it should NOT be evicted
    // when we then open one more (file50) past the cap. Instead file0 (the
    // oldest untouched) is evicted.
    await client.change("/project/file1.ts", "content 1 updated");

    // Open one beyond the cap → eviction.
    await client.openWithText("/project/file50.ts", "content 50");

    const sentAfter = stdinChunks.slice(sentBefore).map((chunk) => {
      const decoded = new TextDecoder().decode(chunk);
      const headerEnd = decoded.indexOf("\r\n\r\n");
      return JSON.parse(decoded.slice(headerEnd + 4));
    });

    // file0 was evicted (didClose sent); file1 was NOT evicted.
    const didCloses = sentAfter.filter(
      (m: { method?: string }) => m.method === "textDocument/didClose",
    );
    const closedUris = didCloses.map(
      (m: { params: { textDocument: { uri: string } } }) => m.params.textDocument.uri,
    );
    expect(closedUris).toContain("file:///project/file0.ts");
    expect(closedUris).not.toContain("file:///project/file1.ts");
    // Exactly one eviction for one overflow open.
    expect(didCloses.length).toBe(1);
  });

  it("initialize timeout clears the pending rpc entry and errors the client (Bug 4)", async () => {
    // A short, injectable initialize timeout lets us drive the timeout path
    // fast. The fix passes the timeout into rpc.sendRequest (not Promise.race),
    // so the pending entry is cleared on expiry — no leak.
    const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    const spawnNoInit: SpawnProcess = () => ({
      stdin: { write: () => {} },
      stdout: {
        on: (_e, cb) => {
          stdoutHolder.cb = cb;
        },
      },
      pid: 7,
      kill: () => {},
    });

    const { client } = makeClient({ spawn: spawnNoInit, initializeTimeoutMs: 80 });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 50));

    // Never answer initialize. The client should time out → error.
    await expect(startPromise).resolves.toBeUndefined();
    expect(client.getState()).toBe("error");
    expect(client.getStateError()).toMatch(/timed out/i);

    // A LATE initialize response must not resolve/dangle anything (the
    // pending entry was cleared on timeout). Feeding it is a safe no-op.
    expect(() => {
      stdoutHolder.cb?.(
        encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
      );
    }).not.toThrow();
    // State stays errored; the stale response didn't flip it to connected.
    expect(client.getState()).toBe("error");
  });
});

/**
 * Diagnostics-wait behavior (the non-blocking feature's correctness core):
 * event-driven resolution, immediate failure on client death, version
 * rejection, and the unversioned stale-push regression.
 */
describe("client diagnostics wait", () => {
  const PATH = "/project/src/app.ts";
  const URI = "file:///project/src/app.ts";

  function push(params: {
    readonly uri?: string;
    readonly version?: number;
    readonly messages: readonly string[];
    readonly severity?: number;
  }): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: params.uri ?? URI,
        ...(params.version !== undefined ? { version: params.version } : {}),
        diagnostics: params.messages.map((message) => ({
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: params.severity ?? 1,
          source: "ts",
          message,
        })),
      },
    });
  }

  /** Connect a client; returns the fake-server controls plus the client. */
  async function connectedClient(opts?: {
    readonly unversionedSettleMs?: number;
    readonly noPushGraceMs?: number;
  }): Promise<{
    client: LanguageServerClient;
    serverResponses: (msg: string) => void;
    exit: () => void;
    sentMethods: () => string[];
  }> {
    const chunks = stdinMethods();
    const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    let exitHandler: ProcessExitHandler | null = null;
    const spawn: SpawnProcess = () => ({
      stdin: { write: (bytes: Uint8Array) => chunks.record(bytes) },
      stdout: {
        on: (_e, cb) => {
          stdoutHolder.cb = cb;
        },
      },
      pid: 42,
      kill: () => {},
      onExit: (handler) => {
        exitHandler = handler;
      },
    });

    const { client } = makeClient({
      spawn,
      ...(opts?.unversionedSettleMs !== undefined
        ? { unversionedSettleMs: opts.unversionedSettleMs }
        : {}),
      ...(opts?.noPushGraceMs !== undefined ? { noPushGraceMs: opts.noPushGraceMs } : {}),
    });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 30));
    stdoutHolder.cb?.(
      encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
    );
    await startPromise;
    expect(client.getState()).toBe("connected");

    return {
      client,
      serverResponses: (msg) => stdoutHolder.cb?.(encode(msg)),
      exit: () => exitHandler?.({ code: 1 }),
      sentMethods: chunks.methods,
    };
  }

  it("resolves on the push itself — no 100 ms poll floor (versioned)", async () => {
    // A long quiet window proves resolution didn't come from the debounce.
    const { client, serverResponses } = await connectedClient({ unversionedSettleMs: 5000 });
    const started = Date.now();

    const wait = client.waitForDiagnostics(PATH, { text: "content", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 10));
    serverResponses(push({ version: 1, messages: ["boom"] }));

    const result = await wait;
    // The 5000 ms quiet window is the proof that resolution came from the PUSH
    // itself (and not from a poll tick, the settle window, or the 10 s cap).
    // The wall-clock bound is generous so parallel test load cannot flake it.
    expect(Date.now() - started).toBeLessThan(400);
    expect(result.timedOut).toBe(false);
    expect(result.formatted).toContain("boom");
    expect(result.diagnostics).toHaveLength(1);
  });

  it("rejects a versioned push from an older document version", async () => {
    const { client, serverResponses } = await connectedClient({ unversionedSettleMs: 20 });
    await client.openWithText(PATH, "v1");
    await new Promise((r) => setTimeout(r, 40)); // let the open's window close

    const wait = client.waitForDiagnostics(PATH, { text: "v2", timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 10));
    // Stale push for v1 (the version the document had before this change).
    serverResponses(push({ version: 1, messages: ["stale error"] }));
    await new Promise((r) => setTimeout(r, 30));
    serverResponses(push({ version: 2, messages: ["fresh error"] }));

    const result = await wait;
    expect(result.timedOut).toBe(false);
    expect(result.formatted).toContain("fresh error");
    expect(result.formatted).not.toContain("stale error");
  });

  it("resolves immediately (timed out) when the server dies mid-wait", async () => {
    const { client, exit } = await connectedClient({ unversionedSettleMs: 20 });
    const started = Date.now();

    const wait = client.waitForDiagnostics(PATH, { text: "content", timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    exit();

    const result = await wait;
    // Not the 10 s cap: markBroken failed the waiter at once.
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.timedOut).toBe(true);
    expect(client.getState()).toBe("error");
  });

  it("REGRESSION: a late second didOpen push cannot satisfy a back-to-back edit (unversioned)", async () => {
    // typescript-language-server emits TWO pushes after didOpen, neither
    // carrying a version. An edit issued right after the open must see the
    // EDIT's result, not the late open-generation push.
    const { client, serverResponses } = await connectedClient({ unversionedSettleMs: 40 });

    const openWait = client.waitForDiagnostics(PATH, { text: "open content", timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 10));
    serverResponses(push({ messages: ["old error"] })); // open push #1

    await new Promise((r) => setTimeout(r, 10));
    const editWait = client.waitForDiagnostics(PATH, { text: "edited content", timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 5));
    serverResponses(push({ messages: ["old error"] })); // late open push #2

    // The quiet window closes (~40 ms after the last push), the deferred
    // didChange is written, and only THEN does the edit's real push land.
    await new Promise((r) => setTimeout(r, 70));
    serverResponses(push({ messages: ["new error"] }));

    const editResult = await editWait;
    expect(editResult.timedOut).toBe(false);
    expect(editResult.formatted).toContain("new error");
    expect(editResult.formatted).not.toContain("old error");

    const openResult = await openWait;
    expect(openResult.formatted).toContain("old error");
  });

  it("COLD START: a late multi-push open burst cannot satisfy a back-to-back edit (unversioned)", async () => {
    // Real cold typescript-language-server: the initial quiet window expires
    // with NO push (the server takes ~2.4 s), then THREE pushes arrive over
    // ~185 ms. The first late push must reopen the window, and a change issued
    // right after it must be deferred until the whole burst goes quiet.
    const { client, serverResponses } = await connectedClient({ unversionedSettleMs: 60 });

    const openWait = client.waitForDiagnostics(PATH, { text: "clean v1", timeoutMs: 4000 });

    // The initial window (60 ms) expires with no push at all.
    await new Promise((r) => setTimeout(r, 90));
    serverResponses(push({ messages: [] })); // open push #1, late
    await new Promise((r) => setTimeout(r, 15));

    const editWait = client.waitForDiagnostics(PATH, { text: "broken v2", timeoutMs: 4000 });
    await new Promise((r) => setTimeout(r, 15));
    serverResponses(push({ messages: [] })); // burst push #2 (stale generation)
    await new Promise((r) => setTimeout(r, 15));
    serverResponses(push({ messages: [] })); // burst push #3 (stale generation)

    // Burst quiesces → the open settles clean and the deferred didChange is
    // written. Only then does the real result for the edit arrive.
    await new Promise((r) => setTimeout(r, 180));
    serverResponses(push({ messages: ["real error"] }));

    const edit = await editWait;
    expect(edit.timedOut).toBe(false);
    expect(edit.formatted).toContain("real error");

    const open = await openWait;
    expect(open.timedOut).toBe(false);
    expect(open.formatted).toBe("");
  });

  it("the first unversioned push after a cold-start delay reopens the quiet window", async () => {
    // Directly asserts the burst rule: a push arriving after the sync's
    // initial window already expired must NOT resolve the wait immediately.
    const { client, serverResponses } = await connectedClient({ unversionedSettleMs: 50 });
    let resolved = false;

    const wait = client.waitForDiagnostics(PATH, { text: "content", timeoutMs: 4000 }).then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 120)); // initial window long gone
    serverResponses(push({ messages: ["from the burst"] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false); // held: waiting for the burst to go quiet

    const result = await wait;
    expect(result.formatted).toContain("from the burst");
  });

  it("resolves as unchanged when a sync produces NO push and the last result was empty", async () => {
    // typescript-language-server suppresses empty→empty publishes entirely.
    const { client, serverResponses } = await connectedClient({
      unversionedSettleMs: 20,
      noPushGraceMs: 60,
    });

    const first = client.waitForDiagnostics(PATH, { text: "v1", timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 15));
    serverResponses(push({ messages: [] }));
    expect((await first).formatted).toBe("");

    // No push will ever answer this sync. The grace must report it as
    // unchanged (not a 5 s "server skipped").
    const started = Date.now();
    const second = await client.waitForDiagnostics(PATH, { text: "v2", timeoutMs: 5000 });
    expect(second.timedOut).toBe(false);
    expect(second.formatted).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does NOT fall back to 'unchanged' when the last result was non-empty", async () => {
    // A non-empty set means the server WILL publish (empty or different), so a
    // missing push must keep waiting — never report stale data as current.
    const { client, serverResponses } = await connectedClient({
      unversionedSettleMs: 20,
      noPushGraceMs: 40,
    });

    const first = client.waitForDiagnostics(PATH, { text: "v1", timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 15));
    serverResponses(push({ messages: ["existing error"] }));
    expect((await first).formatted).toContain("existing error");

    const second = await client.waitForDiagnostics(PATH, { text: "v2", timeoutMs: 150 });
    expect(second.timedOut).toBe(true); // no push, non-empty previous set
  });

  it("defers a didChange that lands inside an unversioned quiet window", async () => {
    const { client, sentMethods } = await connectedClient({ unversionedSettleMs: 40 });
    await client.openWithText(PATH, "v1");
    // Immediately change while the open's quiet window is open.
    await client.change(PATH, "v2");
    // The didChange is deferred — not yet written.
    expect(sentMethods().filter((m) => m === "textDocument/didChange")).toHaveLength(0);
    // ...and is written once the window closes.
    await new Promise((r) => setTimeout(r, 80));
    expect(sentMethods().filter((m) => m === "textDocument/didChange")).toHaveLength(1);
  });
});

/** Tiny stdin recorder: decoded JSON-RPC methods, in order. */
function stdinMethods(): { record: (bytes: Uint8Array) => void; methods: () => string[] } {
  const sent: string[] = [];
  return {
    record: (bytes) => {
      const text = new TextDecoder().decode(bytes);
      const headerEnd = text.indexOf("\r\n\r\n");
      const msg = JSON.parse(text.slice(headerEnd + 4)) as { method?: string };
      if (msg.method !== undefined) sent.push(msg.method);
    },
    methods: () => sent,
  };
}

/**
 * LSP FAILURE CONTAINMENT — the harness invariant: nothing an LSP server (or a
 * bug in our own client) does may escape as an uncaught exception / unhandled
 * rejection. Edits, turns and the host process keep working; the LSP feature
 * degrades to "no diagnostics".
 */
describe("client failure containment", () => {
  const PATH = "/project/src/c.ts";
  const URI = "file:///project/src/c.ts";

  function pushPayload(messages: readonly string[] = []): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: URI,
        diagnostics: messages.map((message) => ({
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          source: "ts",
          message,
        })),
      },
    });
  }

  interface Harness {
    readonly client: LanguageServerClient;
    readonly respond: (msg: string) => void;
    readonly exit: () => void;
  }

  /**
   * A client whose stdin write throws after `writeFailsAfter` successful
   * writes — the "server died between notifications" (EPIPE) case. Writes in
   * order: initialize request (1), initialized notification (2), didOpen (3),
   * didChange (4), ...
   */
  async function connected(opts: {
    readonly writeFailsAfter: number;
    readonly killThrows?: boolean;
    readonly fileWatcher?: FileWatcher;
  }): Promise<Harness> {
    const holder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
    let exitHandler: ProcessExitHandler | null = null;
    let writes = 0;

    const spawn: SpawnProcess = () => ({
      stdin: {
        write: () => {
          writes += 1;
          if (writes > opts.writeFailsAfter) throw new Error("EPIPE: broken pipe");
        },
      },
      stdout: {
        on: (_e, cb) => {
          holder.cb = cb;
        },
      },
      pid: 11,
      kill: () => {
        if (opts.killThrows === true) throw new Error("kill failed");
      },
      onExit: (handler) => {
        exitHandler = handler;
      },
    });

    const { client } = makeClient({
      spawn,
      unversionedSettleMs: 20,
      ...(opts.fileWatcher !== undefined ? { fileWatcher: opts.fileWatcher } : {}),
    });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 20));
    holder.cb?.(encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })));
    await startPromise;

    return {
      client,
      respond: (msg) => holder.cb?.(encode(msg)),
      exit: () => exitHandler?.({ code: 1 }),
    };
  }

  it("a throwing stdin write in the settle timer is contained and breaks the client", async () => {
    // didOpen (write 3) succeeds; the deferred didChange write (4) throws from
    // inside setTimeout, where no caller can catch it.
    const harness = await connected({ writeFailsAfter: 3 });
    const client = harness.client;
    expect(client.getState()).toBe("connected");

    const open = client.waitForDiagnostics(PATH, { text: "v1", timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 5));
    harness.respond(pushPayload([])); // arms the quiet window
    const deferred = client.waitForDiagnostics(PATH, { text: "v2", timeoutMs: 3000 });

    // Both promises settle (the open from the held burst, the deferred as
    // skipped); nothing escapes the timer.
    await expect(open).resolves.toBeDefined();
    const second = await deferred;
    expect(second.timedOut).toBe(true);

    expect(client.getState()).toBe("error");
    expect(client.getStateError()).toMatch(/failed to write textDocument\/didChange/);
    expect(client.getStateError()).toMatch(/EPIPE/);
  });

  it("a write failure during initialization leaves the client in error (never masks it as connected)", async () => {
    // initialize request (1) succeeds, the `initialized` notification (2) throws.
    const harness = await connected({ writeFailsAfter: 1 });
    expect(harness.client.getState()).toBe("error");
    expect(harness.client.getStateError()).toMatch(/failed to write initialized/);
  });

  it("a throwing file-watcher event is contained", async () => {
    let watcherCb: ((e: { type: "change"; path: string }) => void) | null = null;
    const harness = await connected({
      writeFailsAfter: Number.POSITIVE_INFINITY,
      fileWatcher: (_root, onEvent) => {
        watcherCb = onEvent as typeof watcherCb;
        return { close: () => {} };
      },
    });
    expect(harness.client.getState()).toBe("connected");

    // A malformed event makes our callback throw (`.startsWith` on undefined);
    // fs.watch would otherwise propagate it into the runtime.
    expect(() =>
      watcherCb?.({ type: "change", path: undefined as unknown as string }),
    ).not.toThrow();
    expect(harness.client.getState()).toBe("connected");
  });

  it("a malformed publishDiagnostics payload is contained", async () => {
    const harness = await connected({ writeFailsAfter: Number.POSITIVE_INFINITY });
    // params: null → reading params.uri throws inside the notification handler.
    expect(() =>
      harness.respond(
        JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: null }),
      ),
    ).not.toThrow();
    expect(harness.client.getState()).toBe("connected");
  });

  it("a throwing kill() during a process exit is contained", async () => {
    const harness = await connected({
      writeFailsAfter: Number.POSITIVE_INFINITY,
      killThrows: true,
    });
    expect(() => harness.exit()).not.toThrow();
    expect(harness.client.getState()).toBe("error");
  });

  it("a spawn that throws (missing server binary) yields state error, never throws", async () => {
    const { client } = makeClient({
      spawn: () => {
        throw new Error("ENOENT: no such file or directory, posix_spawn");
      },
    });

    await expect(client.start()).resolves.toBeUndefined();
    expect(client.getState()).toBe("error");
    expect(client.getStateError()).toMatch(/ENOENT/);
    // Teardown of a never-started client must also be safe.
    expect(() => client.shutdown()).not.toThrow();
  });

  it("a server that crashes mid-check resolves as skipped instead of hanging", async () => {
    const harness = await connected({ writeFailsAfter: Number.POSITIVE_INFINITY });
    const wait = harness.client.waitForDiagnostics(PATH, { text: "v1", timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 10));
    harness.exit(); // crash mid-check
    const result = await wait;
    expect(result.timedOut).toBe(true);
    expect(result.formatted).toBe("");
  });
});

describe("client failure containment — injected dependencies", () => {
  it("a throwing fileWatcher factory yields state:error (start catches)", async () => {
    // The watcher factory runs inside initialize(); it throws AFTER the
    // handshake, which must not reject start().
    const spawn: SpawnProcess = () => {
      let handler: ((data: Uint8Array) => void) | null = null;
      return {
        stdin: {
          write: (bytes: Uint8Array) => {
            const text = new TextDecoder().decode(bytes);
            const headerEnd = text.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            const msg = JSON.parse(text.slice(headerEnd + 4));
            if (msg.method === "initialize") {
              setTimeout(() => {
                handler?.(
                  encode(
                    JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }),
                  ),
                );
              }, 5);
            }
          },
        },
        stdout: {
          on: (_e, cb) => {
            handler = cb;
          },
        },
        pid: 2,
        kill: () => {},
      };
    };

    const { client } = makeClient({
      spawn,
      fileWatcher: () => {
        throw new Error("watch failed");
      },
    });
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.getState()).toBe("error");
    expect(client.getStateError()).toMatch(/watch failed/);
  });

  it("a throwing fs.readText is contained and the wait resolves as skipped", async () => {
    const { client, serverResponses } = makeClient({
      fs: {
        readText: async () => {
          throw new Error("EACCES: permission denied");
        },
        exists: async () => false,
      },
    });
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 20));
    serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    await startPromise;

    const result = await client.waitForDiagnostics("/project/src/gone.ts", { timeoutMs: 120 });
    expect(result.timedOut).toBe(true);
    expect(result.formatted).toBe("");
  });
});
