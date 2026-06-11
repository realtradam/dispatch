/**
 * Manager — lazy-spawn one client per (serverID, root); dedup concurrent
 * spawns; track a broken set (no retry storm); status(cwd); shutdownAll().
 */

import { join } from "node:path";
import {
	type ClientDeps,
	type FileWatcher,
	type FsAccess,
	LanguageServerClient,
	type SpawnProcess,
} from "./client.js";
import { type ResolvedServer, resolveServers } from "./config.js";
import { findRoot } from "./root.js";
import type { LspServerState, LspServerStatus } from "./types.js";

export type Logger = {
	readonly info: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
	readonly warn: (msg: string, attrs?: Record<string, string | number | boolean | null>) => void;
	readonly error: (msg: string, attrs?: Record<string, unknown>) => void;
};

export interface ManagerDeps {
	readonly spawn: SpawnProcess;
	readonly fileWatcher: FileWatcher;
	readonly fs: FsAccess;
	readonly logger?: Logger | undefined;
}

type ClientEntry = {
	readonly client: LanguageServerClient;
	readonly server: ResolvedServer;
	readonly promise: Promise<void>;
};

export class LspManager {
	private clients = new Map<string, ClientEntry>();
	private broken = new Set<string>();
	private spawning = new Map<string, Promise<void>>();
	private deps: ManagerDeps;

	constructor(deps: ManagerDeps) {
		this.deps = deps;
	}

	async status(cwd: string): Promise<readonly LspServerStatus[]> {
		// Config is resolved PER cwd: a different conversation cwd (e.g. a Roblox
		// project) gets its own .dispatch/lsp.json or opencode.json, not a global one.
		const dispatchLspJson = await this.readOrNull(join(cwd, ".dispatch", "lsp.json"));
		const opencodeJson = await this.readOrNull(join(cwd, "opencode.json"));
		const servers = await resolveServers({
			cwd,
			dispatchLspJson,
			opencodeJson,
			exists: this.deps.fs.exists,
		});

		const results: LspServerStatus[] = [];

		for (const server of servers) {
			const root = await findRoot(cwd, cwd, server.rootMarkers, this.deps.fs.exists);
			const key = `${server.id}:${root}`;

			if (this.broken.has(key)) {
				const status: LspServerStatus = {
					id: server.id,
					name: server.name,
					root,
					extensions: server.extensions,
					state: "error",
					error: "Previously failed to start",
				};
				results.push(status);
				continue;
			}

			const existing = this.clients.get(key);
			if (existing) {
				const state = existing.client.getState();
				const stateError = existing.client.getStateError();
				const status: LspServerStatus = {
					id: server.id,
					name: server.name,
					root,
					extensions: server.extensions,
					state: mapState(state),
				};
				if (stateError !== undefined) {
					(status as { error?: string }).error = stateError;
				}
				results.push(status);
				continue;
			}

			try {
				await this.spawnClient(server, root, key);
				const entry = this.clients.get(key);
				if (entry) {
					const state = entry.client.getState();
					const stateError = entry.client.getStateError();
					const status: LspServerStatus = {
						id: server.id,
						name: server.name,
						root,
						extensions: server.extensions,
						state: mapState(state),
					};
					if (stateError !== undefined) {
						(status as { error?: string }).error = stateError;
					}
					results.push(status);
				}
			} catch (err: unknown) {
				this.broken.add(key);
				const status: LspServerStatus = {
					id: server.id,
					name: server.name,
					root,
					extensions: server.extensions,
					state: "error",
					error: err instanceof Error ? err.message : String(err),
				};
				results.push(status);
			}
		}

		return results;
	}

	getClient(serverId: string, root: string): LanguageServerClient | undefined {
		const key = `${serverId}:${root}`;
		return this.clients.get(key)?.client;
	}

	/** Read a config file's contents, or null if it is absent/unreadable. */
	private async readOrNull(path: string): Promise<string | null> {
		if (!(await this.deps.fs.exists(path))) return null;
		try {
			return await this.deps.fs.readText(path);
		} catch {
			return null;
		}
	}

	private async spawnClient(server: ResolvedServer, root: string, key: string): Promise<void> {
		const existingSpawn = this.spawning.get(key);
		if (existingSpawn) return existingSpawn;

		const spawnPromise = this.doSpawn(server, root, key);
		this.spawning.set(key, spawnPromise);

		try {
			await spawnPromise;
		} finally {
			this.spawning.delete(key);
		}
	}

	private async doSpawn(server: ResolvedServer, root: string, key: string): Promise<void> {
		const clientDeps: ClientDeps = {
			spawn: this.deps.spawn,
			fileWatcher: this.deps.fileWatcher,
			fs: this.deps.fs,
			command: server.command,
			root,
			serverId: server.id,
		};
		if (server.env) {
			(clientDeps as { env?: Readonly<Record<string, string>> }).env = server.env;
		}
		if (server.initialization) {
			(clientDeps as { initialization?: Readonly<Record<string, unknown>> }).initialization =
				server.initialization;
		}

		const client = new LanguageServerClient(clientDeps);
		const entry: ClientEntry = {
			client,
			server,
			promise: client.start(),
		};

		this.clients.set(key, entry);
		await entry.promise;

		if (client.getState() === "error") {
			this.broken.add(key);
			this.deps.logger?.warn("LSP server failed to start", {
				serverId: server.id,
				root,
				error: client.getStateError() ?? "unknown",
			});
		} else {
			this.deps.logger?.info("LSP server connected", {
				serverId: server.id,
				root,
			});
		}
	}

	shutdownAll(): void {
		for (const [key, entry] of this.clients) {
			entry.client.shutdown();
			this.deps.logger?.info("LSP server shutdown", { key });
		}
		this.clients.clear();
		this.broken.clear();
		this.spawning.clear();
	}
}

function mapState(state: LspServerState): LspServerState {
	return state;
}
