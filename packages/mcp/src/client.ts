/**
 * McpClient — MCP protocol client.
 *
 * Manages a single MCP server connection: initialize handshake,
 * tool discovery, tool invocation, and list_changed notifications.
 */

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

	async initialize(): Promise<McpInitializeResult> {
		this.state = "connecting";
		try {
			const result = (await this.connection.send("initialize", {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "dispatch", version: "0.0.0" },
			})) as McpInitializeResult;

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

	async listTools(): Promise<readonly McpToolInfo[]> {
		if (this.state !== "connected") {
			throw new Error("Client not connected");
		}
		const result = (await this.connection.send("tools/list")) as McpListToolsResult;
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
