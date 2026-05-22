import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition, ToolExecuteContext } from "../types/index.js";

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes

export interface BackgroundShellJob {
	command: string;
	stdout: string;
	stderr: string;
	/** Resolves when the process exits */
	completion: Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }>;
}

/** Shared store for shell commands that were backgrounded due to user interrupt */
export class BackgroundShellStore {
	private jobs = new Map<string, BackgroundShellJob>();

	register(job: BackgroundShellJob): string {
		const id = `run_shell_${randomUUID()}`;
		this.jobs.set(id, job);
		// Auto-cleanup after completion + 10 minutes
		job.completion.finally(() => {
			setTimeout(() => this.jobs.delete(id), 10 * 60 * 1000);
		});
		return id;
	}

	async getResult(
		id: string,
	): Promise<{ status: "done"; result: string } | { status: "error"; error: string }> {
		const job = this.jobs.get(id);
		if (!job) {
			return { status: "error", error: `No background shell job found with id '${id}'` };
		}
		const result = await job.completion;
		return { status: "done", result: JSON.stringify(result) };
	}

	has(id: string): boolean {
		return this.jobs.has(id);
	}
}

export function createRunShellTool(
	workingDirectory: string,
	shellStore?: BackgroundShellStore,
): ToolDefinition {
	return {
		name: "run_shell",
		description:
			"Execute a shell command in the working directory. Returns stdout, stderr, and exit code. Use for running tests, builds, git operations, package management, and other development tasks. If the user interrupts while a command is running, the command continues in the background and you receive a job ID. Use the retrieve tool with that ID to get the result later.",
		parameters: z.object({
			command: z.string().describe("The shell command to execute"),
			timeout: z.number().optional().describe("Timeout in milliseconds (default 2 minutes)"),
		}),
		execute: async (
			args: Record<string, unknown>,
			context?: ToolExecuteContext,
		): Promise<string> => {
			const command = args.command as string;
			const timeout = (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT;

			const [shell, shellArgs] = getShell();
			const child = spawn(shell, [...shellArgs, command], {
				cwd: workingDirectory,
				env: process.env,
				timeout,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			const completionPromise = new Promise<{
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

			const queueCallbacks = context?.queueCallbacks;

			if (queueCallbacks && shellStore) {
				const { promise: queuePromise, cancel: cancelQueueWait } =
					queueCallbacks.waitForQueuedMessage();
				const queueSignal = queuePromise.then(() => "QUEUE_INTERRUPT" as const);

				const raceResult = await Promise.race([completionPromise, queueSignal]);

				if (raceResult === "QUEUE_INTERRUPT") {
					// Background the still-running process
					const jobId = shellStore.register({
						command,
						stdout,
						stderr,
						completion: completionPromise,
					});

					const queuedMsgs = queueCallbacks.dequeueMessages();
					const userMessages = queuedMsgs.map((m) => m.message).join("\n---\n");

					return [
						`Command backgrounded — still running.`,
						`job_id: ${jobId}`,
						`command: ${command}`,
						`stdout so far: ${stdout.slice(-500) || "(none)"}`,
						`stderr so far: ${stderr.slice(-500) || "(none)"}`,
						``,
						`Use the retrieve tool with this job_id to get the final result when ready.`,
						``,
						`[USER INTERRUPT]`,
						`The user has sent you message(s) while you were working. You MUST address these before continuing with your current task:`,
						``,
						userMessages,
					].join("\n");
				}

				// Command finished before interrupt — clean up queue listener
				cancelQueueWait();
				return JSON.stringify(raceResult);
			}

			const result = await completionPromise;
			return JSON.stringify(result);
		},
	};
}

function getShell(): [string, string[]] {
	return process.platform === "win32" ? ["powershell", ["-Command"]] : ["bash", ["-c"]];
}
