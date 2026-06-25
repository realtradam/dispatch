/**
 * ComputerService — the read-only computer discovery + live-state surface the
 * transport-http routes delegate to (`computerServiceHandle`), plus the remote
 * `ExecBackend` factory exec-backend consumes (`remoteExecBackendFactoryHandle`).
 *
 * This is the IMPERATIVE SHELL that wires the pure config reader (`config.ts`)
 * to the real filesystem + the `SshConnectionPool`. It reads `~/.ssh/config` +
 * `~/.ssh/known_hosts` (read-only — decision #4: computers are discovered, not
 * CRUD'd), resolves aliases, and delegates connect/test/status to the pool.
 *
 * `usageCount` (on `ComputerEntry`) is INJECTED, not owned here: the ssh package
 * discovers computers; how many conversations/workspaces reference an alias is
 * conversation-store data. host-bin wires `getUsageCounts` from conversation-store
 * later (a CR — conversation-store needs a count-by-alias helper); until then it
 * defaults to 0 so the feature is fully functional (discovery + connect).
 */

import type { ExecBackend } from "@dispatch/exec-backend";
import type { Logger } from "@dispatch/kernel";
import type { ComputerStatusResponse, TestComputerResponse } from "@dispatch/transport-contract";
import type { ComputerService } from "@dispatch/transport-http/dist/seam.js";
import type { Computer, ComputerEntry } from "@dispatch/wire";
import { createSshExecBackend } from "./backend.js";
import { resolveComputer, resolveComputers, type SshConfigResolveEnv } from "./config.js";
import { createSshConnectionPool, type SshConnectionPool, type SshPoolDeps } from "./pool.js";

/**
 * Edges the service drives (mirrors mcp's injected deps). The real wiring
 * (extension.ts) passes `node:fs` + real ssh2; the integration test passes the
 * same real edges against a real sshd.
 */
export interface SshServiceDeps extends SshPoolDeps {
	readonly logger: Logger;
	/** Read `~/.ssh/config` text (the source of truth — decision #4). */
	readonly readConfigText: () => Promise<string>;
	/** The current OS user (fallback when the config sets no `User`). */
	readonly defaultUser: string;
	/** Home dir, for resolving `~` in `IdentityFile`/default key probing. */
	readonly homeDir: string;
	/**
	 * Optional: alias → usage count (conversations/workspaces referencing it).
	 * host-bin wires this from conversation-store; absent → every count is 0.
	 */
	readonly getUsageCounts?: () => Promise<ReadonlyMap<string, number>>;
	/**
	 * Optional: glob patterns to exclude from the computer catalog (e.g.
	 * `github.com`, `*.ts.net`). Sourced from `dispatch.toml` `[ssh].reject`.
	 * Absent → no filtering.
	 */
	readonly readRejectPatterns?: () => Promise<readonly string[]>;
}

/** Build the `ComputerService` + the remote-`ExecBackend` factory. */
export function createSshService(deps: SshServiceDeps): {
	readonly service: ComputerService;
	readonly pool: SshConnectionPool;
	/** `(computerId) => ExecBackend` — provided via remoteExecBackendFactoryHandle. */
	readonly remoteFactory: (computerId: string) => ExecBackend;
} {
	const pool = createSshConnectionPool(deps);

	async function readEnv(): Promise<SshConfigResolveEnv> {
		const [configText, knownHostsText, rejectPatterns] = await Promise.all([
			deps.readConfigText().catch(async () => ""),
			deps.readFileText(deps.knownHostsPath).catch(async () => ""),
			deps.readRejectPatterns !== undefined
				? deps.readRejectPatterns().catch(async () => [] as readonly string[])
				: Promise.resolve([] as readonly string[]),
		]);
		const base: SshConfigResolveEnv = {
			configText,
			knownHostsText,
			defaultUser: deps.defaultUser,
			homeDir: deps.homeDir,
		};
		return rejectPatterns.length > 0 ? { ...base, rejectPatterns } : base;
	}

	const service: ComputerService = {
		async listComputers(): Promise<readonly ComputerEntry[]> {
			const env = await readEnv();
			const computers = resolveComputers(env);
			const counts = deps.getUsageCounts !== undefined ? await deps.getUsageCounts() : new Map();
			return computers.map(
				(c): ComputerEntry => ({
					...c,
					usageCount: counts.get(c.alias) ?? 0,
				}),
			);
		},

		async getComputer(alias: string): Promise<Computer | null> {
			const env = await readEnv();
			return resolveComputer(alias, env);
		},

		async getStatus(alias: string): Promise<ComputerStatusResponse> {
			const env = await readEnv();
			const computer = resolveComputer(alias, env);
			if (computer === null) {
				return {
					alias,
					state: "disconnected",
					knownHost: false,
				};
			}
			// Surface the pool's live state for this alias (disconnected if never
			// acquired; connecting/connected/error once a connect is attempted).
			const entry = pool.status().find((s) => s.computerId === alias);
			if (entry === undefined) {
				return { alias, state: "disconnected", knownHost: computer.knownHost };
			}
			if (entry.error !== undefined) {
				return { alias, state: "error", error: entry.error, knownHost: computer.knownHost };
			}
			return { alias, state: entry.state, knownHost: computer.knownHost };
		},

		async test(alias: string): Promise<TestComputerResponse> {
			const env = await readEnv();
			const computer = resolveComputer(alias, env);
			if (computer === null) {
				return { alias, ok: false, error: `unknown computer alias "${alias}"` };
			}
			// One-shot probe: acquire (connects), run a trivial command, then drop
			// the connection so a test never holds a pooled socket open (plan §9.1).
			try {
				const conn = await pool.acquire(alias);
				const client = await conn.getClient();
				const ok = await runProbe(client);
				if (ok) {
					// Successful connect pins the host key (the accept-new analog);
					// a fresh known_hosts read reflects the new pin.
					deps.logger.info("computer test ok", { alias });
				}
				await pool.drop(alias);
				return ok
					? { alias, ok: true }
					: { alias, ok: false, error: "remote command returned no exit code" };
			} catch (err: unknown) {
				await pool.drop(alias).catch(() => undefined);
				const message = err instanceof Error ? err.message : String(err);
				deps.logger.warn("computer test failed", { alias, error: message });
				return { alias, ok: false, error: message };
			}
		},
	};

	/**
	 * The factory exec-backend consumes: given a computerId (alias), return a
	 * remote `ExecBackend`. The backend acquires lazily — merely building it
	 * (in the resolver) opens NO connection; the first method call connects.
	 * Only the alias is captured; the pool re-resolves connection params from
	 * `~/.ssh/config` at connect time, so no stale snapshot is held here.
	 */
	const remoteFactory = (computerId: string): ExecBackend =>
		createSshExecBackend(computerId, async (alias) => pool.acquire(alias));

	return { service, pool, remoteFactory };
}

/** Run `true` over SSH as a connectivity probe; resolve ok=true on exit 0. */
function runProbe(client: import("ssh2").Client): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		client.exec("true", { pty: false }, (err, stream) => {
			if (err !== null && err !== undefined) {
				resolve(false);
				return;
			}
			let exitCode: number | null = null;
			stream.on("exit", (code: number | null) => {
				exitCode = code;
			});
			stream.on("close", () => {
				resolve(exitCode === 0);
			});
		});
	});
}
