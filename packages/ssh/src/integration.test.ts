/**
 * Integration test against a REAL sshd (the outermost edge). NOT mocked:
 *  - no `vi.mock` of `@dispatch/*` (forbidden by the constitution);
 *  - no mock of `ssh2` itself (that would defeat the purpose — the smoke test
 *    from the load-bearing first step IS the real-edge proof).
 *
 * Skipped unless `SSH_TEST_HOST` is set, so CI without an sshd stays green. The
 * orchestrator live-verifies by exporting `SSH_TEST_HOST=localhost` (with the
 * user's own key + an sshd on :22). The test exercises the full path: config
 * reader → pool connect (key-only auth + host-key pin) → SshExecBackend spawn +
 * SFTP fs ops, all over the real ssh2-under-Bun edge.
 */

import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@dispatch/kernel";
import { Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSshExecBackend } from "./backend.js";
import { resolveComputer } from "./config.js";
import { createSshConnectionPool } from "./pool.js";

const HOST = process.env.SSH_TEST_HOST;
const PORT = process.env.SSH_TEST_PORT ? Number.parseInt(process.env.SSH_TEST_PORT, 10) : 22;
const USER = process.env.SSH_TEST_USER ?? process.env.USER ?? "";

const testEnv = HOST === undefined ? null : { host: HOST, port: PORT, user: USER };

// Build a real config env fixture pointing at the test sshd.
function configText(): string {
	if (testEnv === null) return "";
	return `Host testremote\n  HostName ${testEnv.host}\n  Port ${testEnv.port}\n  User ${testEnv.user}\n`;
}

const sshDir = join(homedir(), ".ssh");

// Build real pool deps (real node:fs + real ssh2) for the test sshd.
/**
 * A self-referential `Logger` stub: every method is a no-op, and `child()`
 * returns itself so the type is complete (the integration test logs nothing).
 */
function noopLogger(): Logger {
	const log: Logger = {
		debug: () => undefined,
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		child: () => log,
		span: (name: string) => ({
			id: name,
			log,
			setAttributes: () => undefined,
			addLink: () => undefined,
			child: (n: string) =>
				({
					id: n,
					log,
					setAttributes: () => undefined,
					addLink: () => undefined,
					child: () => ({ id: n, log }) as never,
					end: () => undefined,
				}) as never,
			end: () => undefined,
		}),
	};
	return log;
}

function realDeps() {
	return {
		logger: noopLogger(),
		homeDir: homedir(),
		knownHostsPath: join(sshDir, "known_hosts"),
		readFileText: (p: string) => readFile(p, "utf8"),
		appendKnownHosts: async () => undefined, // don't mutate the real known_hosts in a test
		pathExists: (p: string) =>
			access(p)
				.then(() => true)
				.catch(() => false),
		newClient: () => new Client(),
		resolveComputer: async (alias: string) =>
			resolveComputer(alias, {
				configText: configText(),
				knownHostsText: "",
				defaultUser: USER,
				homeDir: homedir(),
			}),
	};
}

describe.skipIf(testEnv === null)("SshExecBackend against a real sshd", () => {
	let pool: ReturnType<typeof createSshConnectionPool>;
	let tmpRemoteDir: string;

	beforeEach(async () => {
		pool = createSshConnectionPool(realDeps());
		// Create a remote temp dir to run cwd-scoped commands in.
		tmpRemoteDir = await mkdtemp(join(tmpdir(), "ssh-int-"));
	});

	afterEach(async () => {
		await pool.closeAll();
		// best-effort cleanup of the remote temp dir.
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		try {
			await backend.spawn({
				command: `rm -rf ${tmpRemoteDir}`,
				cwd: "/",
				signal: new AbortController().signal,
				timeout: 5000,
				onOutput: () => undefined,
			});
		} catch {
			// ignore
		}
	});

	it("connects + execs a command, returning stdout + exit code", async () => {
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		let stdout = "";
		const res = await backend.spawn({
			command: "echo integration_ok; exit 7",
			cwd: tmpRemoteDir,
			signal: new AbortController().signal,
			timeout: 10000,
			onOutput: (data, stream) => {
				if (stream === "stdout") stdout += data;
			},
		});
		expect(stdout.trim()).toBe("integration_ok");
		expect(res.exitCode).toBe(7);
		expect(res.timedOut).toBe(false);
		expect(res.aborted).toBe(false);
	});

	it("writes a file over SFTP then reads it back", async () => {
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		const path = join(tmpRemoteDir, "sftp-probe.txt");
		await backend.writeFile(path, "hello-sftp");
		const content = await backend.readFile(path);
		expect(content).toBe("hello-sftp");
	});

	it("stat reports isFile/isDirectory correctly", async () => {
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		const path = join(tmpRemoteDir, "stat-probe.txt").replace(/\\/g, "/");
		await backend.writeFile(path, "x");
		const s = await backend.stat(path);
		expect(s.isFile).toBe(true);
		expect(s.isDirectory).toBe(false);
		// A directory stat reports the inverse.
		const dirStat = await backend.stat(tmpRemoteDir);
		expect(dirStat.isDirectory).toBe(true);
		expect(dirStat.isFile).toBe(false);
	});

	it("readdir lists entries with isDirectory flags", async () => {
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		await backend.writeFile(join(tmpRemoteDir, "a.txt").replace(/\\/g, "/"), "a");
		await mkdir(join(tmpRemoteDir, "subdir").replace(/\\/g, "/")).catch(() => undefined);
		const entries = await backend.readdir(tmpRemoteDir);
		const names = entries.map((e) => e.name);
		expect(names).toContain("a.txt");
		expect(entries.find((e) => e.name === "a.txt")?.isDirectory).toBe(false);
	});

	it("readFile on a missing path throws an ENOENT .code error", async () => {
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		await expect(
			backend.readFile(join(tmpRemoteDir, "nope.txt").replace(/\\/g, "/")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("exists returns false for a missing path and true for an existing one", async () => {
		const backend = createSshExecBackend("testremote", async (a) => pool.acquire(a));
		const path = join(tmpRemoteDir, "exists-probe.txt").replace(/\\/g, "/");
		await backend.writeFile(path, "x");
		expect(await backend.exists(path)).toBe(true);
		expect(await backend.exists(join(tmpRemoteDir, "missing.txt").replace(/\\/g, "/"))).toBe(false);
	});
});
