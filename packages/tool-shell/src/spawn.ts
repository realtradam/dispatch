import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnResult, SpawnShell } from "./shell.js";

export const realSpawn: SpawnShell = (params): Promise<SpawnResult> => {
	return new Promise<SpawnResult>((resolve) => {
		const child = nodeSpawn("sh", ["-c", params.command], {
			cwd: params.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let timedOut = false;
		let killed = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, params.timeout);

		const onAbort = () => {
			killed = true;
			child.kill("SIGKILL");
		};
		params.signal.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			params.onOutput(chunk.toString(), "stdout");
		});

		child.stderr.on("data", (chunk: Buffer) => {
			params.onOutput(chunk.toString(), "stderr");
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			params.signal.removeEventListener("abort", onAbort);
			resolve({ exitCode: code, timedOut });
		});

		child.on("error", () => {
			clearTimeout(timer);
			params.signal.removeEventListener("abort", onAbort);
			if (!killed && !timedOut) {
				resolve({ exitCode: 1, timedOut: false });
			}
		});
	});
};
