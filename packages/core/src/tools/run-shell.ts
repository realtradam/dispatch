import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition, ToolExecuteContext } from "../types/index.js";

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes

export function createRunShellTool(workingDirectory: string): ToolDefinition {
	return {
		name: "run_shell",
		description:
			"Execute a shell command in the working directory. Returns stdout, stderr, and exit code. Use for running tests, builds, git operations, package management, and other development tasks.",
		parameters: z.object({
			command: z.string().describe("The shell command to execute"),
			timeout: z
				.number()
				.optional()
				.describe("Timeout in milliseconds (default 2 minutes)"),
		}),
		execute: async (args: Record<string, unknown>, context?: ToolExecuteContext): Promise<string> => {
			const command = args.command as string;
			const timeout = (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT;

			const [shell, shellArgs] = getShell();
			// NOTE (MVP limitation): `spawn` timeout sends SIGTERM only to the shell
			// process itself, not to any child processes it may have spawned. If the
			// command forks sub-processes they will continue running after timeout.
			// A full fix would require spawning with `detached: true` and killing the
			// entire process group (process.kill(-child.pid, "SIGTERM")).
			const child = spawn(shell, [...shellArgs, command], {
				cwd: workingDirectory,
				env: process.env,
				timeout,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			const result = await new Promise<{
				stdout: string;
				stderr: string;
				exitCode: number;
				error?: string;
			}>((resolve) => {
				child.stdout?.on("data", (data: Buffer) => {
					const chunk = data.toString();
					stdout += chunk;
					context?.onOutput?.(chunk, "stdout");
				});
				child.stderr?.on("data", (data: Buffer) => {
					const chunk = data.toString();
					stderr += chunk;
					context?.onOutput?.(chunk, "stderr");
				});

				child.on("close", (exitCode) => {
					resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
				});

				child.on("error", (err) => {
					resolve({ stdout, stderr, exitCode: 1, error: err.message });
				});
			});

			return JSON.stringify(result);
		},
	};
}

function getShell(): [string, string[]] {
	return process.platform === "win32"
		? ["powershell", ["-Command"]]
		: ["bash", ["-c"]];
}
