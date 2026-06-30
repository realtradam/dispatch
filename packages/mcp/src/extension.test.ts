import type { Extension, HostAPI, Logger, ToolContract } from "@dispatch/kernel";
import type { ToolAssembly, toolsFilter } from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import { filterMcpTools, makeMcpExtension } from "./extension.js";
import { encode, FrameDecoder } from "./framing.js";
import type { SpawnedProcess, SpawnProcess } from "./transport.js";
import type { McpToolInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Pure filterMcpTools
// ---------------------------------------------------------------------------

const stubTool = (name: string): ToolContract => ({
  name,
  description: "",
  parameters: { type: "object" },
  execute: async () => ({ content: "" }),
});

describe("filterMcpTools (pure)", () => {
  it("keeps non-MCP tools and connected-server tools, removes disconnected-server tools", () => {
    const toolToServer = new Map<string, string>([
      ["a__x", "a"],
      ["b__y", "b"],
    ]);
    const connected = new Set<string>(["a"]);

    const result = filterMcpTools(
      {
        tools: [stubTool("a__x"), stubTool("b__y"), stubTool("other")],
        cwd: "/p",
        conversationId: "c",
      },
      toolToServer,
      connected,
    );

    expect(result.tools.map((t) => t.name).sort()).toEqual(["a__x", "other"]);
    expect(result.cwd).toBe("/p");
    expect(result.conversationId).toBe("c");
  });

  it("removes all MCP tools when no server is connected", () => {
    const result = filterMcpTools(
      { tools: [stubTool("a__x")], conversationId: "c" },
      new Map<string, string>([["a__x", "a"]]),
      new Set<string>(),
    );
    expect(result.tools).toHaveLength(0);
    expect(result.conversationId).toBe("c");
    expect(result.cwd).toBeUndefined();
    expect(result.computerId).toBeUndefined();
  });

  it("preserves computerId when set (mirrors cwd/conversationId preservation)", () => {
    const toolToServer = new Map<string, string>([["a__x", "a"]]);
    const connected = new Set<string>(["a"]);

    const result = filterMcpTools(
      {
        tools: [stubTool("a__x"), stubTool("other")],
        cwd: "/p",
        computerId: "ssh-host",
        conversationId: "c",
      },
      toolToServer,
      connected,
    );

    expect(result.tools.map((t) => t.name).sort()).toEqual(["a__x", "other"]);
    expect(result.computerId).toBe("ssh-host");
    expect(result.cwd).toBe("/p");
    expect(result.conversationId).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// In-memory MCP server + fake spawn (integration)
// ---------------------------------------------------------------------------

interface FakeServer {
  tools: McpToolInfo[];
  failInitialize: boolean;
  /** When true, the spawn never responds to `initialize` (a hanging /
   * framing-incompatible server) — used to exercise timeout/abort paths. */
  hangInitialize: boolean;
  emitListChanged: () => void;
}

/**
 * Build a fake spawn backed by a shared `FakeServer`. Incoming framed
 * JSON-RPC on stdin is answered with framed responses on stdout, exercising
 * transport → framing → rpc → client → manager end to end.
 */
function makeFakeSpawn(server: FakeServer): SpawnProcess {
  const decoder = new FrameDecoder();
  let dataListeners: Array<(data: Uint8Array) => void> = [];

  const emit = (frame: Uint8Array) => {
    for (const cb of dataListeners) cb(frame);
  };

  const spawn: SpawnProcess = (_command, _opts) => {
    // Each spawn is a fresh process; reset listeners so a reconnect (after
    // shutdown) doesn't feed closed rpc instances.
    dataListeners = [];
    const process: SpawnedProcess = {
      stdin: {
        write: (bytes: Uint8Array) => {
          for (const msg of decoder.decode(bytes)) {
            const parsed = JSON.parse(msg) as {
              id?: number;
              method?: string;
              params?: unknown;
            };
            const id = parsed.id ?? 0;
            const method = parsed.method;
            if (method === "initialize") {
              if (server.hangInitialize) {
                // Never respond — simulates a framing-incompatible server
                // (e.g. chrome-devtools-mcp under the old Content-Length
                // framing). The connect must be bounded by timeout/abort.
              } else if (server.failInitialize) {
                emit(
                  encode(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32603, message: "initialize failed" },
                    }),
                  ),
                );
              } else {
                emit(
                  encode(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id,
                      result: {
                        protocolVersion: "2025-11-25",
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: "fake", version: "0.0.0" },
                      },
                    }),
                  ),
                );
              }
            } else if (method === "tools/list") {
              emit(encode(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: server.tools } })));
            } else if (method === "tools/call") {
              emit(
                encode(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: "ok" }], isError: false },
                  }),
                ),
              );
            }
            // notifications (notifications/initialized): no response.
          }
        },
      },
      stdout: {
        on: (event: string, cb: (data: Uint8Array) => void) => {
          if (event === "data") dataListeners.push(cb);
        },
      },
      pid: 7000,
      kill: () => {},
    };
    return process;
  };

  server.emitListChanged = () => {
    emit(encode(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })));
  };

  return spawn;
}

// ---------------------------------------------------------------------------
// Minimal fake HostAPI
// ---------------------------------------------------------------------------

function makeFakeHost(): {
  host: HostAPI;
  tools: Map<string, ToolContract>;
  getFilter: () => ((a: ToolAssembly) => Promise<ToolAssembly>) | null;
  getService: () => unknown;
} {
  const tools = new Map<string, ToolContract>();
  let filterFn: ((a: ToolAssembly) => Promise<ToolAssembly>) | null = null;
  let service: unknown = null;

  const noopSpan = {
    id: "s",
    log: {} as Logger,
    setAttributes: () => {},
    addLink: () => {},
    child: () => noopSpan,
    end: () => {},
  };
  const noopLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLogger,
    span: () => noopSpan,
  };

  const host = {
    defineTool: (t: ToolContract) => {
      tools.set(t.name, t);
    },
    addFilter: (_hook: typeof toolsFilter, fn: (a: ToolAssembly) => Promise<ToolAssembly>) => {
      filterFn = fn;
      return () => {
        filterFn = null;
      };
    },
    provideService: (_handle: unknown, impl: unknown) => {
      service = impl;
    },
    getService: () => service,
    getTools: () => tools,
    logger: noopLogger,
  } as unknown as HostAPI;

  return { host, tools, getFilter: () => filterFn, getService: () => service };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dispatchConfig = (servers: Record<string, unknown>): string => JSON.stringify({ servers });

const tool = (name: string, description = name): McpToolInfo => ({
  name,
  description,
  inputSchema: { type: "object" },
});

const assembly = (tools: ToolContract[], cwd = "/proj"): ToolAssembly => ({
  tools,
  cwd,
  conversationId: "conv-1",
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeServer(initialTools: McpToolInfo[]): FakeServer {
  return {
    tools: [...initialTools],
    failInitialize: false,
    hangInitialize: false,
    emitListChanged: () => {},
  };
}

function makeExt(server: FakeServer, configJson: string): Extension {
  return makeMcpExtension({
    spawn: makeFakeSpawn(server),
    readFile: async (path) => (path.endsWith(".dispatch/mcp.json") ? configJson : null),
    getCwd: () => "/proj",
  });
}

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------
describe("mcp extension lifecycle", () => {
  /** Get the registered filter, throwing if activation did not register one. */
  function requireFilter(getFilter: () => ((a: ToolAssembly) => Promise<ToolAssembly>) | null) {
    const filter = getFilter();
    if (!filter) throw new Error("toolsFilter was not registered");
    return filter;
  }

  /** Look up a registered tool, throwing if absent. */
  function requireTool(tools: Map<string, ToolContract>, name: string) {
    const t = tools.get(name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t;
  }

  it("registers tools on connect", async () => {
    const server = makeServer([tool("create_object", "Create an object")]);
    const ext = makeExt(server, dispatchConfig({ freecad: { command: "fake" } }));
    const { host, tools, getFilter } = makeFakeHost();

    ext.activate(host);
    const filter = requireFilter(getFilter);

    // Running the filter triggers lazy connect + register.
    await filter(assembly([]));

    expect(tools.has("freecad__create_object")).toBe(true);
    const t = requireTool(tools, "freecad__create_object");
    expect(t.description).toBe("[freecad] Create an object");
    expect(t.concurrencySafe).toBe(false);
    ext.deactivate?.();
  });

  it("toolsFilter keeps connected-server tools and removes disconnected-server tools", async () => {
    const server = makeServer([tool("create_object")]);
    const ext = makeExt(server, dispatchConfig({ freecad: { command: "fake" } }));
    const { host, tools, getFilter } = makeFakeHost();
    ext.activate(host);
    const filter = requireFilter(getFilter);

    // Connect + register the tool.
    await filter(assembly([]));
    const registered = requireTool(tools, "freecad__create_object");

    // Connected server → tool passes through the filter.
    const kept = await filter(assembly([registered]));
    expect(kept.tools.map((t) => t.name)).toContain("freecad__create_object");

    // Disconnect: deactivate shuts down the client (clearing it), then make
    // the server fail to reconnect. toolToServer still maps the tool, so the
    // filter drops it because the server is no longer connected.
    ext.deactivate?.();
    server.failInitialize = true;

    const removed = await filter(assembly([registered]));
    expect(removed.tools.map((t) => t.name)).not.toContain("freecad__create_object");
  });

  it("re-registers tools on list_changed", async () => {
    const server = makeServer([tool("first_tool")]);
    const ext = makeExt(server, dispatchConfig({ freecad: { command: "fake" } }));
    const { host, tools, getFilter } = makeFakeHost();
    ext.activate(host);
    const filter = requireFilter(getFilter);

    await filter(assembly([]));
    expect(tools.has("freecad__first_tool")).toBe(true);

    // Server changes its tool set, then announces list_changed.
    server.tools = [tool("first_tool"), tool("second_tool", "The second")];
    server.emitListChanged();

    // Let the async onToolsChanged handler (re-list + re-register) flush.
    await flush();

    expect(tools.has("freecad__second_tool")).toBe(true);
    expect(requireTool(tools, "freecad__second_tool").description).toBe("[freecad] The second");
    ext.deactivate?.();
  });

  it("deactivate shuts down all clients", async () => {
    const server = makeServer([tool("create_object")]);
    const ext = makeExt(server, dispatchConfig({ freecad: { command: "fake" } }));
    const { host, getFilter, getService } = makeFakeHost();
    ext.activate(host);
    const filter = requireFilter(getFilter);

    await filter(assembly([]));

    const service = getService() as {
      status: (cwd: string) => Promise<readonly { state: string }[]>;
    };
    const before = await service.status("/proj");
    expect(before[0].state).toBe("connected");

    ext.deactivate?.();

    const after = await service.status("/proj");
    expect(after[0].state).toBe("disconnected");
  });

  // -------------------------------------------------------------------------
  // Bug 2 + Bug 3: a misbehaving/hanging server must not hang a turn, and the
  // turn's AbortSignal (assembly.signal) must interrupt a stuck connect.
  // -------------------------------------------------------------------------

  it("degrades gracefully (no MCP tools) when the turn's signal is already aborted", async () => {
    const server = makeServer([tool("create_object")]);
    const ext = makeExt(server, dispatchConfig({ freecad: { command: "fake" } }));
    const { host, getFilter } = makeFakeHost();
    ext.activate(host);
    const filter = requireFilter(getFilter);

    const controller = new AbortController();
    controller.abort();

    const base = assembly([]);
    // The filter must NOT hang on the (never-needed) connect: an aborted turn
    // signal propagates to initialize, which rejects immediately.
    const result = await filter({
      tools: base.tools,
      cwd: base.cwd,
      conversationId: base.conversationId,
      signal: controller.signal,
    });

    expect(result.tools).toEqual([]);
    ext.deactivate?.();
  });

  it("the turn's signal aborts a hanging server connect (POST /stop interrupts)", async () => {
    // hangInitialize: the spawn never responds to initialize (a framing-
    // incompatible / misbehaving server). Without abort propagation this
    // would hang the filter until MCP_CONNECT_TIMEOUT_MS; with propagation
    // the abort breaks it immediately.
    const server = makeServer([tool("create_object")]);
    server.hangInitialize = true;
    const ext = makeExt(server, dispatchConfig({ chrome: { command: "fake" } }));
    const { host, getFilter } = makeFakeHost();
    ext.activate(host);
    const filter = requireFilter(getFilter);

    const controller = new AbortController();
    const base = assembly([]);
    const resultPromise = filter({
      tools: base.tools,
      cwd: base.cwd,
      conversationId: base.conversationId,
      signal: controller.signal,
    });

    // Let the filter progress into the hanging initialize (withTimeout has
    // its abort listener armed), THEN abort — a true mid-flight cancel
    // simulating POST /conversations/:id/stop. Without signal propagation
    // this would hang ~30s (the connect backstop) and time out the test.
    await flush();
    controller.abort();

    const result = await resultPromise;
    // Degraded: no MCP tools surfaced, and the filter resolved (did not hang).
    expect(result.tools).toEqual([]);
    ext.deactivate?.();
  });

  it("non-MCP tools pass through unchanged when an MCP connect fails", async () => {
    // failInitialize: the server rejects initialize (a fast failure, not a
    // hang) so the connect degrades promptly without waiting on a backstop.
    const server = makeServer([tool("create_object")]);
    server.failInitialize = true;
    const ext = makeExt(server, dispatchConfig({ chrome: { command: "fake" } }));
    const { host, getFilter } = makeFakeHost();
    ext.activate(host);
    const filter = requireFilter(getFilter);

    const stubNonMcp: ToolContract = {
      name: "run_shell",
      description: "kept",
      parameters: { type: "object" },
      execute: async () => ({ content: "" }),
    };

    const result = await filter({
      tools: [stubNonMcp],
      cwd: "/proj",
      conversationId: "c",
    });

    // Non-MCP tool survives; the failed MCP server contributed no tools.
    expect(result.tools.map((t) => t.name)).toEqual(["run_shell"]);
    ext.deactivate?.();
  });
});
