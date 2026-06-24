import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnResult, SpawnShell } from "./shell.js";

export const realSpawn: SpawnShell = (params): Promise<SpawnResult> => {
	return new Promise<SpawnResult>((resolve) => {
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
		const settle = (result: SpawnResult) => {
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
};
