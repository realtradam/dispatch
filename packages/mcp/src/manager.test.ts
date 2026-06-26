import { describe, expect, it } from "vitest";
import { McpManager, type McpManagerDeps } from "./manager.js";
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

function makeManager(
  connectionFactory: (_server: ResolvedMcpServer) => {
    connection: Connection;
    promise: Promise<void>;
  },
): McpManager {
  const currentTime = 1000;
  const deps: McpManagerDeps = {
    spawn: () => ({
      stdin: { write: () => {} },
      stdout: { on: () => {} },
      pid: 1,
      kill: () => {},
    }),
    now: () => currentTime,
  };

  const factory = (_server: ResolvedMcpServer, _cwd: string) => connectionFactory(_server);

  const manager = new McpManager(deps, factory);
  return manager;
}

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
      return { connection: conn, promise: Promise.resolve() };
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
      return { connection: conn, promise: Promise.resolve() };
    });

    const client1 = await manager.ensureConnected(testServer, "/tmp");
    const client2 = await manager.ensureConnected(testServer, "/tmp");
    expect(client1).toBe(client2);
    expect(spawnCount).toBe(1);
  });

  it("status returns server states", async () => {
    const conn = makeMockConnection();
    const manager = makeManager(() => {
      return { connection: conn, promise: Promise.resolve() };
    });

    // Before connecting
    let statuses = manager.status([testServer]);
    expect(statuses.length).toBe(1);
    expect(statuses[0].state).toBe("disconnected");

    // After connecting
    await manager.ensureConnected(testServer, "/tmp");
    statuses = manager.status([testServer]);
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
      return { connection: conn, promise: Promise.resolve() };
    });

    await manager.ensureConnected(testServer, "/tmp");
    manager.shutdownAll();

    expect(closed).toBe(true);
    const statuses = manager.status([testServer]);
    expect(statuses[0].state).toBe("disconnected");
  });

  it("broken server reports error state", async () => {
    const manager = makeManager(() => {
      return { connection: makeBrokenConnection(), promise: Promise.resolve() };
    });

    await expect(manager.ensureConnected(testServer, "/tmp")).rejects.toThrow();

    const statuses = manager.status([testServer]);
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
      return { connection: conn, promise: Promise.resolve() };
    };

    const manager = new McpManager(deps, factory);

    // First attempt fails
    await expect(manager.ensureConnected(testServer, "/tmp")).rejects.toThrow();
    expect(manager.status([testServer])[0].state).toBe("error");

    // Not enough time passed — still broken
    currentTime += 29_000;
    expect(manager.status([testServer])[0].state).toBe("error");

    // After backoff — should allow retry
    useGood = true;
    currentTime += 2_000;
    const statuses = manager.status([testServer]);
    // After backoff, status() clears the broken entry
    expect(statuses[0].state).toBe("disconnected");
  });

  it("getClient returns undefined for unknown server", () => {
    const manager = makeManager(() => {
      return { connection: makeMockConnection(), promise: Promise.resolve() };
    });

    expect(manager.getClient("nonexistent")).toBeUndefined();
  });
});
