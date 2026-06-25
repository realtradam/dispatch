/**
 * SshExecBackend — implements `ExecBackend` over a pooled SSH connection.
 *
 * `spawn` runs a command on the remote via `client.exec` (shell-quoting the cwd
 * into `cd "<cwd>" && <command>`; ssh2 exec has no cwd option). `readFile`/
 * `writeFile`/`stat`/`readdir`/`exists` use SFTP. Every ssh2/SFTP error is
 * routed through `errors.ts` so it lands as a node:fs-style `.code` error — the
 * bundled tools' existing error branches (e.g. `read_file`'s "File not found"
 * on `ENOENT`) work unchanged (plan §4.3).
 *
 * Built per `acquire`: captures the alias + a lazy `acquire` thunk so merely
 * RESOLVING a backend never opens a connection — only the first actual method
 * call connects (the resolver stays side-effect-free; see exec-backend service).
 */

import type {
	DirEntry,
	ExecBackend,
	ExecResult,
	SpawnParams,
	StatResult,
} from "@dispatch/exec-backend";
import type { Client, ClientChannel } from "ssh2";
import { mapSshError } from "./errors.js";
import type { SshConnection } from "./pool.js";

/** Acquire the pooled connection for an alias (lazy — the backend is built
 *  before any connection exists; acquire runs on first method call). */
export type AcquireConnection = (alias: string) => Promise<SshConnection>;

/**
 * Build a remote `ExecBackend` for `alias`. The connection is acquired lazily
 * inside each method (so resolving a backend in the resolver is free — opening
 * a connection is deferred to the first actual tool call). Only the alias is
 * needed here: the pool re-resolves the real `Computer` (hostName/port/user/key)
 * from `~/.ssh/config` at connect time, so the backend carries no stale params.
 */
export function createSshExecBackend(alias: string, acquire: AcquireConnection): ExecBackend {
	const getConn = (): Promise<SshConnection> => acquire(alias);

	return {
		async spawn(params: SpawnParams): Promise<ExecResult> {
			const conn = await getConn();
			const client = await conn.getClient();
			// ssh2 exec has no cwd option → prefix `cd "<cwd>" && <command>`.
			// Shell-quote the cwd so a path with metachars can't break out (plan §7.6).
			const wrapped = `cd ${shellQuote(params.cwd)} && ${params.command}`;

			return runExec(client, wrapped, params);
		},

		async readFile(path: string): Promise<string> {
			const conn = await getConn();
			const sftp = await conn.getSftp();
			return new Promise<string>((resolve, reject) => {
				sftp.readFile(path, "utf8", (err, data) => {
					if (err !== null && err !== undefined) reject(mapSshError(err, `readFile ${path}`));
					else resolve(data.toString("utf8"));
				});
			});
		},

		async writeFile(path: string, content: string): Promise<void> {
			const conn = await getConn();
			const sftp = await conn.getSftp();
			return new Promise<void>((resolve, reject) => {
				sftp.writeFile(path, content, "utf8", (err) => {
					if (err !== null && err !== undefined) reject(mapSshError(err, `writeFile ${path}`));
					else resolve();
				});
			});
		},

		async stat(path: string): Promise<StatResult> {
			const conn = await getConn();
			const sftp = await conn.getSftp();
			return new Promise<StatResult>((resolve, reject) => {
				sftp.stat(path, (err, stats) => {
					if (err !== null && err !== undefined) reject(mapSshError(err, `stat ${path}`));
					else resolve({ isFile: stats.isFile(), isDirectory: stats.isDirectory() });
				});
			});
		},

		async readdir(path: string): Promise<readonly DirEntry[]> {
			const conn = await getConn();
			const sftp = await conn.getSftp();
			return new Promise<readonly DirEntry[]>((resolve, reject) => {
				sftp.readdir(path, (err, list) => {
					if (err !== null && err !== undefined) reject(mapSshError(err, `readdir ${path}`));
					else
						resolve(
							list.map((e): DirEntry => ({ name: e.filename, isDirectory: e.attrs.isDirectory() })),
						);
				});
			});
		},

		async exists(path: string): Promise<boolean> {
			const conn = await getConn();
			const sftp = await conn.getSftp();
			// ssh2's `sftp.exists` invokes the callback with a boolean that is TRUE
			// when the path exists and FALSE when missing (verified empirically).
			// Never throws — a missing path resolves `false`.
			return new Promise<boolean>((resolve) => {
				sftp.exists(path, (exists: boolean) => resolve(exists));
			});
		},
	};
}

// ─── spawn core ─────────────────────────────────────────────────────────────

/**
 * Run one `client.exec`, wiring stdout/stderr → `params.onOutput`, exit code,
 * abort (`stream.end()`), and timeout. Mirrors `localSpawn`'s settle-once +
 * cleanup semantics so the tool sees the same `ExecResult` shape (plan §4.3/§8).
 */
function runExec(client: Client, command: string, params: SpawnParams): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve) => {
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let exitCode: number | null = null;

		const settle = (result: ExecResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			params.signal.removeEventListener("abort", onAbort);
			client.removeListener("error", onClientError);
			resolve(result);
		};

		const onAbort = (): void => {
			if (settled) return;
			try {
				stream?.end();
			} catch {
				// best-effort — the remote channel may already be gone
			}
			settle({ exitCode: null, timedOut: false, aborted: true });
		};

		// If the client errors mid-exec, surface as a non-zero exit (the turn is
		// NOT aborted — the model sees a normal tool error and can retry; §8).
		const onClientError = (): void => {
			if (!settled) settle({ exitCode: 1, timedOut: false, aborted: false });
		};
		client.on("error", onClientError);

		let stream: ClientChannel | undefined;

		client.exec(command, { pty: false }, (err, channel) => {
			if (err !== null && err !== undefined) {
				// Spawn error → non-zero exit, like localSpawn's error path.
				settle({ exitCode: 1, timedOut: false, aborted: false });
				return;
			}
			stream = channel;

			// stdout: ssh2 channel IS its stdout stream (this.stdin = this.stdout = this).
			channel.on("data", (data: Buffer) => {
				params.onOutput(data.toString(), "stdout");
			});
			channel.stderr.on("data", (data: Buffer) => {
				params.onOutput(data.toString(), "stderr");
			});
			channel.on("exit", (code: number | null) => {
				exitCode = code;
			});
			channel.on("close", () => {
				settle({ exitCode, timedOut, aborted: false });
			});

			params.signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				try {
					channel.end();
				} catch {
					// best-effort
				}
				settle({ exitCode: null, timedOut: true, aborted: false });
			}, params.timeout);
		});
	});
}

// ─── shell quoting ─────────────────────────────────────────────────────────

/**
 * Shell-quote a path for the `cd "<cwd>" && ...` prefix so a cwd containing
 * shell metacharacters cannot break out (plan §7.6). Single-quotes wrap the
 * value and any embedded single-quote is escaped (`'\''`).
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
