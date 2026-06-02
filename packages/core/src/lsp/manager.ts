import { extname } from "node:path";
import { createLspClient, type Diagnostic, type LspClient } from "./client.js";
import type { ResolvedLspServer } from "./server.js";

/**
 * Process-wide owner of LSP client lifecycles.
 *
 * Clients are keyed by `root + serverID` and spawned lazily on the first file
 * that matches a server's extensions, then reused. Concurrent spawns for the
 * same key are de-duplicated via an in-flight map, and servers that fail to
 * start are remembered in `broken` so we don't spawn-spam. Modeled on
 * opencode's `lsp/lsp.ts` `getClients` flow, minus the Effect machinery.
 *
 * The manager is config-agnostic: callers resolve `ResolvedLspServer[]` from a
 * tab's working-directory config (`resolveServersFromConfig`) and pass them in
 * alongside the `root`. This keeps per-working-directory config out of the
 * manager while letting it own all the long-lived processes for the process.
 */
export class LspManager {
	private clients = new Map<string, LspClient>();
	private spawning = new Map<string, Promise<LspClient | undefined>>();
	private broken = new Set<string>();

	private key(root: string, serverID: string): string {
		return `${root}\u0000${serverID}`;
	}

	private serversForFile(file: string, servers: ResolvedLspServer[]): ResolvedLspServer[] {
		const extension = extname(file) || file;
		return servers.filter(
			(server) => server.extensions.length === 0 || server.extensions.includes(extension),
		);
	}

	/**
	 * True if any provided server is configured to attach to this file's
	 * extension (regardless of whether it has spawned yet). Used to decide
	 * whether an LSP operation is even applicable to a file.
	 */
	hasServerForFile(file: string, servers: ResolvedLspServer[]): boolean {
		return this.serversForFile(file, servers).length > 0;
	}

	/**
	 * Get (spawning if needed) all clients that should attach to `file` at
	 * `root`. Spawn failures are swallowed (logged via `broken`) and simply
	 * yield fewer clients — callers degrade gracefully to "no diagnostics".
	 */
	async getClients(input: {
		file: string;
		root: string;
		servers: ResolvedLspServer[];
	}): Promise<LspClient[]> {
		const { file, root, servers } = input;
		const matching = this.serversForFile(file, servers);
		const result: LspClient[] = [];

		for (const server of matching) {
			const key = this.key(root, server.id);
			if (this.broken.has(key)) continue;

			const existing = this.clients.get(key);
			if (existing) {
				result.push(existing);
				continue;
			}

			const inflight = this.spawning.get(key);
			if (inflight) {
				const client = await inflight;
				if (client) result.push(client);
				continue;
			}

			const task = this.spawn(server, root, key);
			this.spawning.set(key, task);
			task.finally(() => {
				if (this.spawning.get(key) === task) this.spawning.delete(key);
			});
			const client = await task;
			if (client) result.push(client);
		}

		return result;
	}

	private async spawn(
		server: ResolvedLspServer,
		root: string,
		key: string,
	): Promise<LspClient | undefined> {
		let handle: ReturnType<ResolvedLspServer["spawn"]>;
		try {
			handle = server.spawn(root);
		} catch (err) {
			this.broken.add(key);
			console.warn(
				`dispatch: failed to spawn LSP server "${server.id}": ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}

		// A spawn that fails asynchronously (e.g. ENOENT — binary not on PATH)
		// emits `error` on the child process; mark broken so we don't retry it.
		handle.process.on("error", (err) => {
			this.broken.add(key);
			console.warn(`dispatch: LSP server "${server.id}" process error: ${err.message}`);
		});

		try {
			const client = await createLspClient({
				serverID: server.id,
				server: handle,
				root,
				directory: root,
			});
			// A racing caller may have created the same client; prefer the
			// existing one and discard ours.
			const existing = this.clients.get(key);
			if (existing) {
				await client.shutdown();
				return existing;
			}
			this.clients.set(key, client);
			return client;
		} catch (err) {
			this.broken.add(key);
			try {
				handle.process.kill();
			} catch {
				/* already dead */
			}
			console.warn(
				`dispatch: failed to initialize LSP client "${server.id}": ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}
	}

	/**
	 * Open/sync a file with its clients and (optionally) wait for diagnostics
	 * to settle. `mode: "document"` waits for the file's own diagnostics;
	 * `"full"` also waits on workspace diagnostics; omitted just syncs.
	 */
	async touchFile(input: {
		file: string;
		root: string;
		servers: ResolvedLspServer[];
		mode?: "document" | "full";
	}): Promise<void> {
		const clients = await this.getClients(input);
		await Promise.all(
			clients.map(async (client) => {
				const after = Date.now();
				const version = await client.notifyOpen(input.file);
				if (!input.mode) return;
				await client.waitForDiagnostics({
					path: input.file,
					version,
					mode: input.mode,
					after,
				});
			}),
		).catch((err) => {
			console.warn(
				`dispatch: failed to touch file for LSP: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	/**
	 * Merged diagnostics for a single file across all of its clients, keyed by
	 * absolute file path. Includes related-file diagnostics a client surfaced
	 * (e.g. workspace pulls), so the result map may contain more than `file`.
	 */
	getDiagnostics(input: {
		root: string;
		servers: ResolvedLspServer[];
		file: string;
	}): Record<string, Diagnostic[]> {
		const results: Record<string, Diagnostic[]> = {};
		const matching = this.serversForFile(input.file, input.servers);
		for (const server of matching) {
			const client = this.clients.get(this.key(input.root, server.id));
			if (!client) continue;
			for (const [path, diags] of client.diagnostics.entries()) {
				results[path] = (results[path] ?? []).concat(diags);
			}
		}
		return results;
	}

	/**
	 * Run a positional LSP request (hover/definition/references/etc.) against
	 * every client for the file and flatten the (non-null) results. `line`/
	 * `character` are 0-based here — the caller converts from editor 1-based.
	 */
	async request(input: {
		file: string;
		root: string;
		servers: ResolvedLspServer[];
		method: string;
		params: Record<string, unknown>;
	}): Promise<unknown[]> {
		const clients = await this.getClients(input);
		const results = await Promise.all(
			clients.map((client) => client.request(input.method, input.params)),
		);
		return results.filter((r) => r !== null && r !== undefined);
	}

	/** Shut down every live client and clear all state. */
	async shutdownAll(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		this.spawning.clear();
		this.broken.clear();
		await Promise.all(clients.map((client) => client.shutdown().catch(() => {})));
	}
}
