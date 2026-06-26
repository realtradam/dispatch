import { describe, expect, it } from "vitest";
import { McpClient } from "./client.js";
import type { Connection } from "./transport.js";

function makeMockConnection(): Connection & {
  responses: Map<string, unknown>;
  feedResponse: (method: string, result: unknown) => void;
  notifications: Array<{ method: string; params: unknown }>;
} {
  const responses = new Map<string, unknown>();
  const pendingRequests = new Map<number, { method: string; resolve: (v: unknown) => void }>();
  let nextId = 1;
  const notifications: Array<{ method: string; params: unknown }> = [];
  const notificationHandlers = new Map<string, (params: unknown) => void>();

  return {
    responses,
    notifications,
    feedResponse: (_method: string, _result: unknown) => {},
    send: (method: string, _params?: unknown) => {
      const id = nextId++;
      return new Promise((resolve) => {
        pendingRequests.set(id, { method, resolve });
        // Auto-respond for initialize
        if (method === "initialize") {
          resolve({
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "test-server", version: "1.0.0" },
          });
        } else if (method === "tools/list") {
          resolve({
            tools: [
              {
                name: "test_tool",
                description: "A test tool",
                inputSchema: { type: "object", properties: { input: { type: "string" } } },
              },
            ],
          });
        } else if (method === "tools/call") {
          resolve({
            content: [{ type: "text", text: "result from tool" }],
            isError: false,
          });
        }
      });
    },
    notify: (method: string, params?: unknown) => {
      notifications.push({ method, params });
    },
    onNotification: (method: string, handler: (params: unknown) => void) => {
      notificationHandlers.set(method, handler);
    },
    close: () => {},
    pid: 999,
  };
}

describe("McpClient", () => {
  it("initialize sends correct protocolVersion + capabilities", async () => {
    const conn = makeMockConnection();
    const client = new McpClient({ connection: conn });

    const result = await client.initialize();

    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.capabilities.tools?.listChanged).toBe(true);
    expect(result.serverInfo.name).toBe("test-server");
    expect(client.getState()).toBe("connected");

    // Should have sent notifications/initialized
    expect(conn.notifications.length).toBe(1);
    expect(conn.notifications[0].method).toBe("notifications/initialized");
  });

  it("listTools returns parsed tools", async () => {
    const conn = makeMockConnection();
    const client = new McpClient({ connection: conn });

    await client.initialize();
    const tools = await client.listTools();

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("test_tool");
    expect(tools[0].description).toBe("A test tool");
  });

  it("callTool sends name + arguments", async () => {
    const conn = makeMockConnection();
    let callParams: unknown = null;
    const origSend = conn.send.bind(conn);
    conn.send = (method: string, params?: unknown) => {
      if (method === "tools/call") callParams = params;
      return origSend(method, params);
    };

    const client = new McpClient({ connection: conn });

    await client.initialize();
    const result = await client.callTool("test_tool", { input: "hello" });

    expect(callParams).toEqual({ name: "test_tool", arguments: { input: "hello" } });
    expect(result.content).toEqual([{ type: "text", text: "result from tool" }]);
    expect(result.isError).toBe(false);
  });

  it("list_changed triggers re-list", async () => {
    const conn = makeMockConnection();
    const notificationHandlers = new Map<string, (params: unknown) => void>();
    conn.onNotification = (method: string, handler: (params: unknown) => void) => {
      notificationHandlers.set(method, handler);
    };

    const client = new McpClient({ connection: conn });

    let toolsChangedFired = false;
    client.onToolsChanged(() => {
      toolsChangedFired = true;
    });

    await client.initialize();

    // Simulate list_changed notification
    const handler = notificationHandlers.get("notifications/tools/list_changed");
    expect(handler).toBeDefined();
    handler?.(undefined);

    expect(toolsChangedFired).toBe(true);
  });

  it("handles server error on initialize", async () => {
    const conn = makeMockConnection();
    conn.send = (method: string) => {
      if (method === "initialize") {
        return Promise.reject(new Error("Server startup failed"));
      }
      return Promise.resolve({});
    };

    const client = new McpClient({ connection: conn });

    await expect(client.initialize()).rejects.toThrow("Server startup failed");
    expect(client.getState()).toBe("error");
  });

  it("callTool rejects when not connected", async () => {
    const conn = makeMockConnection();
    const client = new McpClient({ connection: conn });

    await expect(client.callTool("test", {})).rejects.toThrow("Client not connected");
  });

  it("listTools rejects when not connected", async () => {
    const conn = makeMockConnection();
    const client = new McpClient({ connection: conn });

    await expect(client.listTools()).rejects.toThrow("Client not connected");
  });

  it("close sets state to disconnected", async () => {
    const conn = makeMockConnection();
    const client = new McpClient({ connection: conn });

    await client.initialize();
    expect(client.getState()).toBe("connected");

    client.close();
    expect(client.getState()).toBe("disconnected");
  });

  it("callTool with abort signal", async () => {
    const conn = makeMockConnection();
    let resolveRequest: ((v: unknown) => void) | null = null;
    conn.send = (method: string) => {
      if (method === "tools/call") {
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      }
      if (method === "initialize") {
        return Promise.resolve({
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "test", version: "1.0.0" },
        });
      }
      return Promise.resolve({});
    };

    const client = new McpClient({ connection: conn });
    await client.initialize();

    const controller = new AbortController();
    const callPromise = client.callTool("test", {}, controller.signal);

    controller.abort();

    await expect(callPromise).rejects.toThrow("Aborted");

    // Clean up
    resolveRequest?.({
      content: [{ type: "text", text: "too late" }],
    });
  });
});
