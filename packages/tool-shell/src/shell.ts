import { resolve } from "node:path";
import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";

const DEFAULT_TIMEOUT = 120_000;
const OUTPUT_CAP = 50_000;

export interface ValidatedArgs {
	readonly command: string;
	readonly timeout: number;
}

export interface SpawnResult {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
}

export type SpawnShell = (params: {
	readonly command: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly timeout: number;
	readonly onOutput: (data: string, stream: "stdout" | "stderr") => void;
}) => Promise<SpawnResult>;

export function validateArgs(args: unknown): ValidatedArgs | { readonly error: string } {
	if (args === null || args === undefined || typeof args !== "object") {
		return { error: "Error: Arguments must be an object." };
	}
	const obj = args as Record<string, unknown>;

	const rawCommand = obj.command;
	if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
		return { error: 'Error: Missing or empty "command" parameter (must be a non-empty string).' };
	}

	let timeout = DEFAULT_TIMEOUT;
	if (obj.timeout !== undefined) {
		const n = Number(obj.timeout);
		if (!Number.isFinite(n) || n < 1) {
			return { error: 'Error: Invalid "timeout" parameter (must be a positive number).' };
		}
		timeout = Math.floor(n);
	}

	return { command: rawCommand, timeout };
}

export function truncateOutput(output: string, cap: number): string {
	if (output.length <= cap) {
		return output;
	}
	const truncated = output.slice(0, cap);
	return `${truncated}\n\n[Output truncated: exceeded ${cap} characters]`;
}

export function buildResult(params: {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly output: string;
	readonly cap: number;
}): ToolResult {
	if (params.aborted) {
		return {
			content: truncateOutput(params.output, params.cap),
			isError: true,
		};
	}
	if (params.timedOut) {
		const content = truncateOutput(params.output, params.cap);
		return {
			content: `${content}\n\n[Command timed out]`,
			isError: true,
		};
	}
	const exitCode = params.exitCode;
	if (exitCode !== null && exitCode !== 0) {
		return {
			content: truncateOutput(params.output, params.cap),
			isError: true,
		};
	}
	return {
		content: truncateOutput(params.output, params.cap),
	};
}

export function createRunShellTool(deps: {
	readonly workdir: string;
	readonly spawn: SpawnShell;
	readonly outputCap?: number;
}): ToolContract {
	const workdir = resolve(deps.workdir);
	const cap = deps.outputCap ?? OUTPUT_CAP;

	return {
		name: "run_shell",
		description:
			"Execute a shell command and return its output. " +
			"Use for running CLI tools, scripts, or system commands.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute.",
				},
				timeout: {
					type: "number",
					description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}).`,
					default: DEFAULT_TIMEOUT,
				},
			},
			required: ["command"],
		},
		concurrencySafe: false,
		async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
			const validated = validateArgs(args);
			if ("error" in validated) {
				return { content: validated.error, isError: true };
			}

			const { command, timeout } = validated;
			const effectiveCwd = ctx.cwd ? resolve(ctx.cwd) : workdir;

			if (ctx.signal.aborted) {
				return buildResult({
					exitCode: null,
					timedOut: false,
					aborted: true,
					output: "",
					cap,
				});
			}

			let output = "";
			const appendOutput = (data: string, _stream: "stdout" | "stderr") => {
				output += data;
			};

			let spawnResult: SpawnResult;

			try {
				spawnResult = await deps.spawn({
					command,
					cwd: effectiveCwd,
					signal: ctx.signal,
					timeout,
					onOutput: (data, stream) => {
						ctx.onOutput(data, stream);
						appendOutput(data, stream);
					},
				});
			} catch (err: unknown) {
				if (ctx.signal.aborted) {
					return buildResult({
						exitCode: null,
						timedOut: false,
						aborted: true,
						output,
						cap,
					});
				}
				return {
					content: `Error spawning command: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			return buildResult({
				exitCode: spawnResult.exitCode,
				timedOut: spawnResult.timedOut,
				aborted: spawnResult.aborted,
				output,
				cap,
			});
		},
	};
}
