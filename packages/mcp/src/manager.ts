/**
 * McpManager — one McpClient per configured server; lazy-spawn on first
 * tool access; status(servers); getClient(serverId); shutdownAll().
 *
 * Mirrors the LSP manager lifecycle. Injected spawn + logger (no I/O of its
 * own: config resolution happens in the extension layer; the manager receives
 * already-resolved servers).
 */

import { McpClient } from "./client.js";
import type { Connection, SpawnProcess } from "./transport.js";
import type { McpServerState, McpServerStatus, ResolvedMcpServer } from "./types.js";

export interface Logger {
	readonly info: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
	readonly warn: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
	readonly error: (msg: string, attrs?: Record<string, unknown>) => void;
}

export interface McpManagerDeps {
	readonly spawn: SpawnProcess;
	readonly logger?: Logger;
	readonly now?: () => number;
}

export type ConnectionFactory = (
	server: ResolvedMcpServer,
	cwd: string,
) => { connection: Connection; promise: Promise<void> };

type ClientEntry = {
	readonly client: McpClient;
	readonly server: ResolvedMcpServer;
	readonly promise: Promise<void>;
};

type BrokenEntry = {
	readonly brokenAt: number;
	readonly error: string;
};

const BACKOFF_MS = 30_000;

export class McpManager {
	private clients = new Map<string, ClientEntry>();
	private broken = new Map<string, BrokenEntry>();
	private spawning = new Map<string, Promise<void>>();
	private readonly deps: McpManagerDeps;
	private readonly connectionFactory: ConnectionFactory;
	private readonly now: () => number;

	constructor(deps: McpManagerDeps, connectionFactory: ConnectionFactory) {
		this.deps = deps;
		this.connectionFactory = connectionFactory;
		this.now = deps.now ?? Date.now;
	}

	getClient(serverId: string): McpClient | undefined {
		return this.clients.get(serverId)?.client;
	}

	getServerState(serverId: string): McpServerState {
		const brokenEntry = this.broken.get(serverId);
		if (brokenEntry) {
			const backoffElapsed = this.now() - brokenEntry.brokenAt >= BACKOFF_MS;
			if (backoffElapsed) {
				this.broken.delete(serverId);
			} else {
				return "error";
			}
		}

		const entry = this.clients.get(serverId);
		if (!entry) return "disconnected";

		const state = entry.client.getState();
		if (state === "error") return "error";
		if (state === "connecting") return "connecting";
		if (state === "connected") return "connected";
		return "disconnected";
	}

	status(servers: readonly ResolvedMcpServer[]): McpServerStatus[] {
		const results: McpServerStatus[] = [];

		for (const server of servers) {
			const state = this.getServerState(server.id);
			const entry = this.clients.get(server.id);
			const brokenEntry = this.broken.get(server.id);

			const status: McpServerStatus = {
				id: server.id,
				state,
				toolCount: entry?.client.getTools().length ?? 0,
			};
			if (state === "error" && brokenEntry) {
				(status as { error?: string }).error = brokenEntry.error;
			} else if (state === "error" && entry?.client.getState() === "error") {
				(status as { error?: string }).error = brokenEntry?.error ?? `${server.id}: client error`;
			}
			results.push(status);
		}

		return results;
	}

	async ensureConnected(server: ResolvedMcpServer, cwd: string): Promise<McpClient> {
		const existing = this.clients.get(server.id);
		if (existing && existing.client.getState() === "connected") {
			return existing.client;
		}

		const brokenEntry = this.broken.get(server.id);
		if (brokenEntry) {
			const backoffElapsed = this.now() - brokenEntry.brokenAt >= BACKOFF_MS;
			if (!backoffElapsed) {
				throw new Error(brokenEntry.error);
			}
			this.broken.delete(server.id);
		}

		await this.spawnClient(server, cwd);
		const entry = this.clients.get(server.id);
		if (!entry) {
			throw new Error(`Failed to spawn MCP client for ${server.id}`);
		}
		if (entry.client.getState() === "error") {
			const brokenNow = this.broken.get(server.id);
			throw new Error(brokenNow?.error ?? `${server.id}: client error`);
		}
		return entry.client;
	}

	private async spawnClient(server: ResolvedMcpServer, cwd: string): Promise<void> {
		const existingSpawn = this.spawning.get(server.id);
		if (existingSpawn) return existingSpawn;

		const spawnPromise = this.doSpawn(server, cwd);
		this.spawning.set(server.id, spawnPromise);

		try {
			await spawnPromise;
		} finally {
			this.spawning.delete(server.id);
		}
	}

	private async doSpawn(server: ResolvedMcpServer, cwd: string): Promise<void> {
		const { connection, promise } = this.connectionFactory(server, cwd);

		const client = new McpClient({ connection });

		const entry: ClientEntry = {
			client,
			server,
			promise: this.initClient(client, server, promise),
		};

		this.clients.set(server.id, entry);
		await entry.promise;

		// If initialization failed, the client is in an error state and broken[]
		// is already populated. Drop the half-created client (and reap its child
		// process) so a later retry spawns fresh instead of returning a dead entry.
		if (client.getState() === "error") {
			this.clients.delete(server.id);
			client.close();
		}
	}

	private async initClient(
		client: McpClient,
		server: ResolvedMcpServer,
		_transportPromise: Promise<void>,
	): Promise<void> {
		try {
			await client.initialize();
			await client.listTools();
			this.deps.logger?.info("MCP server connected", {
				serverId: server.id,
				toolCount: String(client.getTools().length),
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.broken.set(server.id, {
				brokenAt: this.now(),
				error: `${server.id}: ${message}`,
			});
			this.deps.logger?.warn("MCP server failed to connect", {
				serverId: server.id,
				error: message,
			});
		}
	}

	shutdownAll(): void {
		for (const [, entry] of this.clients) {
			entry.client.close();
		}
		this.clients.clear();
		this.broken.clear();
		this.spawning.clear();
		this.deps.logger?.info("All MCP servers shut down");
	}
}
