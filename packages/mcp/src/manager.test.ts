import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConnectionFactory, McpManager, type McpManagerDeps } from "./manager.js";
import type { Connection } from "./transport.js";
import type { ResolvedMcpServer } from "./types.js";

function makeMockConnection(): Connection {
  return {
    send: async (method: string) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "test", version: "1.0.0" },
        };
      }
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "tool_a",
              description: "Tool A",
              inputSchema: { type: "object" },
            },
          ],
        };
      }
      return {};
    },
    notify: () => {},
    onNotification: () => {},
    close: () => {},
    pid: 100,
  };
}

function makeBrokenConnection(): Connection {
  return {
    send: async () => {
      throw new Error("Connection refused");
    },
    notify: () => {},
    onNotification: () => {},
    close: () => {},
    pid: 101,
  };
}

function makeManager(connectionFactory: ConnectionFactory): McpManager {
  const currentTime = vi.isFakeTimers() ? undefined : 1000;
  const deps: McpManagerDeps = {
    spawn: () => ({
      stdin: { write: () => {} },
      stdout: { on: () => {} },
      pid: 1,
      kill: () => {},
    }),
    now: () => currentTime ?? Date.now(),
  };

  const factory = connectionFactory;

  const manager = new McpManager(deps, factory);
  managers.push(manager);
  return manager;
}

const managers: McpManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdownAll();
  vi.useRealTimers();
});

const testServer: ResolvedMcpServer = {
  id: "test-server",
  command: ["test-cmd"],
  configSource: ".dispatch/mcp.json",
};

describe("McpManager", () => {
  it("lazy-spawn on first access", async () => {
    const conn = makeMockConnection();
    let spawnCount = 0;
    const manager = makeManager((_server) => {
      spawnCount++;
      return { connection: conn, promise: new Promise<void>(() => {}) };
    });

    const client = await manager.ensureConnected(testServer, "/tmp");
    expect(client).toBeDefined();
    expect(spawnCount).toBe(1);
  });

  it("reuses existing client on second access", async () => {
    const conn = makeMockConnection();
    let spawnCount = 0;
    const manager = makeManager(() => {
      spawnCount++;
      return { connection: conn, promise: new Promise<void>(() => {}) };
    });

    const client1 = await manager.ensureConnected(testServer, "/tmp");
    const client2 = await manager.ensureConnected(testServer, "/tmp");
    expect(client1).toBe(client2);
    expect(spawnCount).toBe(1);
  });

  it("status returns server states", async () => {
    const conn = makeMockConnection();
    const manager = makeManager(() => {
      return { connection: conn, promise: new Promise<void>(() => {}) };
    });

    // Before connecting
    let statuses = manager.status([testServer], "/tmp");
    expect(statuses.length).toBe(1);
    expect(statuses[0].state).toBe("disconnected");

    // After connecting
    await manager.ensureConnected(testServer, "/tmp");
    statuses = manager.status([testServer], "/tmp");
    expect(statuses.length).toBe(1);
    expect(statuses[0].state).toBe("connected");
    expect(statuses[0].toolCount).toBe(1);
  });

  it("shutdownAll kills all clients", async () => {
    let closed = false;
    const conn: Connection = {
      send: async (method: string) => {
        if (method === "initialize") {
          return {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "test", version: "1.0.0" },
          };
        }
        if (method === "tools/list") return { tools: [] };
        return {};
      },
      notify: () => {},
      onNotification: () => {},
      close: () => {
        closed = true;
      },
      pid: 200,
    };

    const manager = makeManager(() => {
      return { connection: conn, promise: new Promise<void>(() => {}) };
    });

    await manager.ensureConnected(testServer, "/tmp");
    manager.shutdownAll();

    expect(closed).toBe(true);
    const statuses = manager.status([testServer], "/tmp");
    expect(statuses[0].state).toBe("disconnected");
  });

  it("broken server reports error state", async () => {
    const manager = makeManager(() => {
      return { connection: makeBrokenConnection(), promise: new Promise<void>(() => {}) };
    });

    await expect(manager.ensureConnected(testServer, "/tmp")).rejects.toThrow();

    const statuses = manager.status([testServer], "/tmp");
    expect(statuses[0].state).toBe("error");
    expect(statuses[0].error).toContain("test-server");
  });

  it("broken server retries after backoff", async () => {
    let currentTime = 1000;
    const brokenConn = makeBrokenConnection();
    const goodConn = makeMockConnection();
    let useGood = false;

    const deps: McpManagerDeps = {
      spawn: () => ({
        stdin: { write: () => {} },
        stdout: { on: () => {} },
        pid: 1,
        kill: () => {},
      }),
      now: () => currentTime,
    };

    const factory = (_server: ResolvedMcpServer, _cwd: string) => {
      const conn = useGood ? goodConn : brokenConn;
      return { connection: conn, promise: new Promise<void>(() => {}) };
    };

    const manager = new McpManager(deps, factory);
    managers.push(manager);

    // First attempt fails
    await expect(manager.ensureConnected(testServer, "/tmp")).rejects.toThrow();
    expect(manager.status([testServer], "/tmp")[0].state).toBe("error");

    // Not enough time passed — still broken
    currentTime += 29_000;
    expect(manager.status([testServer], "/tmp")[0].state).toBe("error");

    // After backoff — should allow retry
    useGood = true;
    currentTime += 2_000;
    const statuses = manager.status([testServer], "/tmp");
    // After backoff, status() clears the broken entry
    expect(statuses[0].state).toBe("disconnected");
  });

  it("getClient returns undefined for unknown server", () => {
    const manager = makeManager(() => {
      return { connection: makeMockConnection(), promise: new Promise<void>(() => {}) };
    });

    expect(manager.getClient("nonexistent", "/tmp")).toBeUndefined();
  });

  it("isolates clients and backoff by cwd", async () => {
    const cwds: string[] = [];
    const manager = makeManager((_server, cwd) => {
      cwds.push(cwd);
      return {
        connection: cwd === "/bad" ? makeBrokenConnection() : makeMockConnection(),
        promise: new Promise(() => {}),
      };
    });
    await expect(manager.ensureConnected(testServer, "/bad")).rejects.toThrow();
    const a = await manager.ensureConnected(testServer, "/a");
    const b = await manager.ensureConnected(testServer, "/b");
    expect(a).not.toBe(b);
    expect(cwds).toEqual(["/bad", "/a", "/b"]);
    expect(manager.status([testServer], "/bad")[0].state).toBe("error");
    expect(manager.status([testServer], "/a")[0].state).toBe("connected");
  });

  it.each([
    "error",
    "disconnected",
  ] as const)("closes a %s client before replacing it", async (state) => {
    const events: string[] = [];
    let fail = false;
    const conn = makeMockConnection();
    const manager = makeManager(() => {
      events.push("spawn");
      return {
        connection: {
          ...conn,
          send: (method) => {
            if (fail) return Promise.reject(new Error("lost connection"));
            return conn.send(method);
          },
          close: () => events.push("close"),
        },
        promise: new Promise(() => {}),
      };
    });
    const old = await manager.ensureConnected(testServer, "/tmp");
    if (state === "error") {
      // Exercise the real client's error transition, not a mocked state method.
      fail = true;
      await expect(old.initialize()).rejects.toThrow();
    } else old.close();
    events.length = 0;
    // Each replacement gets a healthy connection.
    fail = false;
    expect(await manager.ensureConnected(testServer, "/tmp")).not.toBe(old);
    expect(events).toEqual(["close", "spawn"]);
  });

  it("reaps at 30 minutes, refreshes use, and never reaps an active call", async () => {
    vi.useFakeTimers();
    let finish: ((value: unknown) => void) | undefined;
    const close = vi.fn();
    const conn = makeMockConnection();
    const manager = makeManager(() => ({
      connection: {
        ...conn,
        close,
        send: (method) =>
          method === "tools/call"
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : conn.send(method),
      },
      promise: new Promise(() => {}),
    }));
    await manager.ensureConnected(testServer, "/tmp");
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(close).not.toHaveBeenCalled();
    const call = manager.callTool(testServer, "/tmp", "tool_a", {});
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(close).not.toHaveBeenCalled();
    if (!finish) throw new Error("Call not started");
    finish({ content: [] });
    await call;
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(close).toHaveBeenCalledOnce();
    expect(manager.getClient(testServer.id, "/tmp")).toBeUndefined();
  });

  it("bounds a shared handshake, closes its process, and clears its timer", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const manager = makeManager(() => ({
      connection: { ...makeMockConnection(), close, send: () => new Promise(() => {}) },
      promise: new Promise(() => {}),
    }));
    const connect = expect(manager.ensureConnected(testServer, "/tmp")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await connect;
    expect(close).toHaveBeenCalledOnce();
    expect(manager.getServerState(testServer.id, "/tmp")).toBe("error");
    manager.shutdownAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    false,
    true,
  ])("handles transport EOF/error (rejected=%s) before reconnect", async (rejected) => {
    let end: (() => void) | undefined;
    const close = vi.fn();
    const manager = makeManager(() => ({
      connection: { ...makeMockConnection(), close },
      promise: new Promise<void>((resolve, reject) => {
        end = () => (rejected ? reject(new Error("transport failed")) : resolve());
      }),
    }));
    const old = await manager.ensureConnected(testServer, "/tmp");
    if (!end) throw new Error("Transport not started");
    end();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(manager.getServerState(testServer.id, "/tmp")).toBe("disconnected");
    expect(await manager.ensureConnected(testServer, "/tmp")).not.toBe(old);
  });

  it("rejects an already-aborted caller without spawning", async () => {
    const factory = vi.fn(() => ({
      connection: makeMockConnection(),
      promise: new Promise<void>(() => {}),
    }));
    const manager = makeManager(factory);
    const controller = new AbortController();
    controller.abort();
    await expect(manager.ensureConnected(testServer, "/tmp", controller.signal)).rejects.toThrow(
      "Aborted",
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("waits for shared tool discovery and shutdown cannot restore broken state", async () => {
    const conn = makeMockConnection();
    const manager = makeManager(() => ({
      connection: {
        ...conn,
        send: (method) => (method === "tools/list" ? new Promise(() => {}) : conn.send(method)),
      },
      promise: new Promise(() => {}),
    }));
    const first = expect(manager.ensureConnected(testServer, "/tmp")).rejects.toThrow();
    await Promise.resolve();
    const controller = new AbortController();
    const second = manager.ensureConnected(testServer, "/tmp", controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow("Aborted");
    manager.shutdownAll();
    await first;
    expect(manager.getServerState(testServer.id, "/tmp")).toBe("disconnected");
  });

  it("first caller aborts but the second connects without marking the server broken", async () => {
    let initialize: ((value: unknown) => void) | undefined;
    const conn = makeMockConnection();
    const manager = makeManager(() => ({
      connection: {
        ...conn,
        send: (method) =>
          method === "initialize"
            ? new Promise((resolve) => {
                initialize = resolve;
              })
            : conn.send(method),
      },
      promise: new Promise(() => {}),
    }));
    const first = new AbortController();
    const second = new AbortController();
    const a = manager.ensureConnected(testServer, "/tmp", first.signal);
    const b = manager.ensureConnected(testServer, "/tmp", second.signal);
    first.abort();
    await expect(a).rejects.toThrow("Aborted");
    expect(manager.getServerState(testServer.id, "/tmp")).not.toBe("error");
    if (!initialize) throw new Error("Handshake not started");
    initialize(await conn.send("initialize"));
    const client = await b;
    expect(client.getState()).toBe("connected");
    expect(await manager.ensureConnected(testServer, "/tmp")).toBe(client);
  });
});
