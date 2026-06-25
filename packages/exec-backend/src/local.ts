import { spawn as nodeSpawn } from "node:child_process";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { DirEntry, ExecBackend, ExecResult, SpawnParams, StatResult } from "./backend.js";

/**
 * LocalExecBackend — wraps `node:fs/promises` + `node:child_process`.
 *
 * Behavior is IDENTICAL to today's local tools:
 * - `spawn` mirrors `realSpawn` in `packages/tool-shell/src/spawn.ts` — same
 *   `sh -c` invocation, detached process-group kill on abort/timeout,
 *   close-based resolution, and spawn-error → `{ exitCode: 1 }`.
 * - `readFile`/`writeFile`/`stat`/`readdir` use the same `node:fs/promises`
 *   calls (utf8, `withFileTypes`) the tools make inline today, and throw the
 *   same node errors (carrying `.code`) so the tools' existing error branches
 *   work unchanged.
 * - `exists` swallows all errors and returns `false` (an existence check).
 *
 * This factors the inline node calls out behind the `ExecBackend` interface so
 * a remote (SshExecBackend) can swap in transparently. Stateless — safe to
 * share as a singleton.
 */
export function createLocalExecBackend(): ExecBackend {
	return {
		spawn: localSpawn,

		readFile: (path) => readFile(path, "utf8"),

		writeFile: (path, content) => writeFile(path, content, "utf8"),

		stat: async (path): Promise<StatResult> => {
			const s = await stat(path);
			return { isFile: s.isFile(), isDirectory: s.isDirectory() };
		},

		readdir: async (path): Promise<readonly DirEntry[]> => {
			const entries = await readdir(path, { encoding: "utf8", withFileTypes: true });
			return entries.map((e): DirEntry => ({ name: e.name, isDirectory: e.isDirectory() }));
		},

		exists: async (path): Promise<boolean> => {
			try {
				await access(path);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** Default singleton — stateless, safe to share across calls. */
export const localExecBackend: ExecBackend = createLocalExecBackend();

/**
 * Run a shell command locally via `node:child_process`.
 *
 * Ported verbatim from `packages/tool-shell/src/spawn.ts` (`realSpawn`) so
 * behavior is byte-identical: `sh -c <command>`, `detached: true` (own process
 * group), process-group `SIGKILL` on abort/timeout so a backgrounded grandchild
 * cannot hold the stdio pipes open, and resolve-once-with-cleanup to avoid
 * listener/timer leaks.
 */
function localSpawn(params: SpawnParams): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve) => {
		// detached: true puts the child in its own process group (pgid = child.pid).
		// This lets us kill the entire group (child + any grandchildren that inherit
		// the pipes) via process.kill(-pgid, "SIGKILL") on abort/timeout, so a
		// backgrounded grandchild can't keep the stdio pipes open and stall the
		// promise on child.on("close").
		const child = nodeSpawn("sh", ["-c", params.command], {
			cwd: params.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});

		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		/** Kill the entire child process group (best-effort — group may be gone). */
		const killGroup = () => {
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Process group may already be gone — ignore.
				}
			}
		};

		/** Remove the abort listener and clear the timeout timer (no leaks). */
		const cleanup = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			params.signal.removeEventListener("abort", onAbort);
		};

		/** Resolve once, then clean up so listeners/timers never leak. */
		const settle = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const onAbort = () => {
			if (settled) return;
			killGroup();
			// Resolve immediately — do NOT wait for child.on("close"), which may
			// never fire if a grandchild holds the pipes open.
			settle({ exitCode: null, timedOut: false, aborted: true });
		};
		params.signal.addEventListener("abort", onAbort, { once: true });

		timer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			killGroup();
			// Resolve immediately — same reasoning as abort.
			settle({ exitCode: null, timedOut: true, aborted: false });
		}, params.timeout);

		child.stdout.on("data", (chunk: Buffer) => {
			params.onOutput(chunk.toString(), "stdout");
		});

		child.stderr.on("data", (chunk: Buffer) => {
			params.onOutput(chunk.toString(), "stderr");
		});

		// Normal-completion path: wait for "close" so all stdout/stderr is captured.
		// If abort/timeout already settled, this is a no-op (settled === true).
		child.on("close", (code) => {
			settle({ exitCode: code, timedOut, aborted: false });
		});

		// Spawn error (e.g. bad cwd, sh not found). Kill the group just in case
		// and resolve — never leave the promise pending.
		child.on("error", () => {
			killGroup();
			settle({ exitCode: 1, timedOut: false, aborted: false });
		});
	});
}
