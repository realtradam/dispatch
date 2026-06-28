/**
 * McpClient — MCP protocol client.
 *
 * Manages a single MCP server connection: initialize handshake,
 * tool discovery, tool invocation, and list_changed notifications.
 *
 * Every awaited handshake/list operation is bounded by `withTimeout` (a default
 * timeout) and an optional `AbortSignal`, so a misbehaving or framing-
 * incompatible server can never hang the caller (the per-turn tools filter)
 * indefinitely. `callTool` was already abort-aware; `initialize`/`listTools`
 * now are too.
 */

import { MCP_DEFAULT_TIMEOUT_MS, withTimeout } from "./timeout.js";
import type { Connection } from "./transport.js";
import type {
  McpCallResult,
  McpInitializeResult,
  McpListToolsResult,
  McpServerCapabilities,
  McpToolInfo,
} from "./types.js";

export type McpClientState = "disconnected" | "connecting" | "connected" | "error";

export interface McpClientDeps {
  readonly connection: Connection;
}

export class McpClient {
  private state: McpClientState = "disconnected";
  private capabilities: McpServerCapabilities = {};
  private tools: readonly McpToolInfo[] = [];
  private connection: Connection;
  private toolsChangedHandler: (() => void) | null = null;

  constructor(deps: McpClientDeps) {
    this.connection = deps.connection;
  }

  getState(): McpClientState {
    return this.state;
  }

  getCapabilities(): McpServerCapabilities {
    return this.capabilities;
  }

  getTools(): readonly McpToolInfo[] {
    return this.tools;
  }

  onToolsChanged(handler: () => void): void {
    this.toolsChangedHandler = handler;
  }

  /**
   * Perform the MCP `initialize` handshake. Bounded by `timeoutMs` (default
   * {@link MCP_DEFAULT_TIMEOUT_MS}) and the optional `signal` (the turn's abort
   * signal) so a server that never responds cannot hang the caller forever.
   */
  async initialize(
    signal?: AbortSignal,
    timeoutMs: number = MCP_DEFAULT_TIMEOUT_MS,
  ): Promise<McpInitializeResult> {
    this.state = "connecting";
    try {
      const result = (await withTimeout(
        this.connection.send("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "dispatch", version: "0.0.0" },
        }),
        "initialize",
        timeoutMs,
        signal,
      )) as McpInitializeResult;

      this.capabilities = result.capabilities;
      this.connection.notify("notifications/initialized", {});

      this.connection.onNotification("notifications/tools/list_changed", () => {
        if (this.toolsChangedHandler) {
          this.toolsChangedHandler();
        }
      });

      this.state = "connected";
      return result;
    } catch (err: unknown) {
      this.state = "error";
      throw err;
    }
  }

  /**
   * List the server's tools. Bounded by `timeoutMs` (default
   * {@link MCP_DEFAULT_TIMEOUT_MS}) and the optional `signal`.
   */
  async listTools(
    signal?: AbortSignal,
    timeoutMs: number = MCP_DEFAULT_TIMEOUT_MS,
  ): Promise<readonly McpToolInfo[]> {
    if (this.state !== "connected") {
      throw new Error("Client not connected");
    }
    const result = (await withTimeout(
      this.connection.send("tools/list"),
      "tools/list",
      timeoutMs,
      signal,
    )) as McpListToolsResult;
    this.tools = result.tools;
    return this.tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (this.state !== "connected") {
      throw new Error("Client not connected");
    }

    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    const resultPromise = this.connection.send("tools/call", {
      name,
      arguments: args,
    }) as Promise<McpCallResult>;

    if (!signal) {
      return resultPromise;
    }

    return new Promise<McpCallResult>((resolve, reject) => {
      const onAbort = () => reject(new Error("Aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      resultPromise.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  close(): void {
    this.state = "disconnected";
    this.connection.close();
  }
}
