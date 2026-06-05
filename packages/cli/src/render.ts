/**
 * Pure event renderer — zero I/O.
 *
 * Maps an AgentEvent to optional stdout/stderr strings.
 * Consumers write these to process.stdout / process.stderr.
 */

import type { AgentEvent } from "@dispatch/transport-contract";

interface RenderOpts {
	readonly showReasoning: boolean;
}

interface RenderOutput {
	readonly stdout?: string;
	readonly stderr?: string;
}

export function renderEvent(e: AgentEvent, opts: RenderOpts): RenderOutput | undefined {
	switch (e.type) {
		case "text-delta":
			return { stdout: e.delta };
		case "reasoning-delta":
			return opts.showReasoning ? { stdout: e.delta } : undefined;
		case "tool-call":
			return { stdout: `\n[tool] ${e.toolName} ${JSON.stringify(e.input)}\n` };
		case "tool-output":
			return { stdout: e.data };
		case "tool-result":
			return {
				stdout: `[tool:${e.toolName}]${e.isError ? " ERROR" : ""} ${e.content}\n`,
			};
		case "usage":
			return {
				stdout: `\n[usage] in=${e.usage.inputTokens} out=${e.usage.outputTokens}\n`,
			};
		case "error":
			return { stderr: `[error] ${e.message}\n` };
		case "status":
		case "turn-start":
		case "turn-sealed":
		case "done":
			return undefined;
	}
}
