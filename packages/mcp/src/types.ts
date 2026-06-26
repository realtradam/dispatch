/**
 * Shared types for the MCP extension.
 */

import type { ToolParameterSchema } from "@dispatch/kernel";

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface ResolvedMcpServer {
  readonly id: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly configSource: ".dispatch/mcp.json" | "opencode.json";
}

export interface ResolveResult {
  readonly servers: readonly ResolvedMcpServer[];
  readonly shadowed: boolean;
}

export type McpServerState = "connecting" | "connected" | "error" | "disconnected";

export interface McpServerStatus {
  readonly id: string;
  readonly state: McpServerState;
  readonly error?: string;
  readonly toolCount: number;
}

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolParameterSchema;
}

export interface McpContentItem {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly resource?: {
    readonly uri: string;
    readonly text?: string;
  };
}

export interface McpCallResult {
  readonly content: readonly McpContentItem[];
  readonly isError?: boolean;
}

export interface McpServerCapabilities {
  readonly tools?: {
    readonly listChanged?: boolean;
  };
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpServerCapabilities;
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
}

export interface McpService {
  readonly status: (cwd: string) => Promise<readonly McpServerStatus[]>;
}

export interface McpListToolsResult {
  readonly tools: readonly McpToolInfo[];
}

/**
 * The narrow capability `adaptTool` depends on: the ability to invoke a tool
 * on the MCP server. Declared as a port so the registry stays pure and
 * testable against a real collaborator (not a mock of `McpClient`).
 * `McpClient` satisfies this structurally.
 */
export interface McpToolCaller {
  readonly callTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<McpCallResult>;
}
