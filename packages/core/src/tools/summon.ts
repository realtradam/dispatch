import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export interface SummonCallbacks {
	spawn(options: { task: string; tools: string[]; workingDirectory?: string }): Promise<string>;
}

export function createSummonTool(
	defaultWorkingDirectory: string,
	callbacks: SummonCallbacks,
): ToolDefinition {
	return {
		name: "summon",
		description: [
			"Spawn a new child agent to work on a task independently. Returns immediately with an agent_id — does NOT wait for the child to finish.",
			"",
			"The child agent runs in its own tab visible to the user. Use the 'retrieve' tool with the returned agent_id to get the result when needed.",
			"",
			"Pattern for parallel work:",
			"  1. Call summon multiple times to start several agents",
			"  2. Do your own work or wait",
			"  3. Call retrieve for each agent_id to collect results",
			"",
			"The 'tools' parameter controls what the child can do. Available tool names:",
			"  - read_file: Read file contents",
			"  - list_files: List files and directories",
			"  - write_file: Write/edit files",
			"  - run_shell: Execute shell commands",
			"  - todo: Track work items",
			"  - summon: Spawn its own child agents (enables nesting)",
			"  - retrieve: Collect results from its children (required if summon is given)",
			"",
			"If tools is omitted, the child gets read_file, list_files, and todo only (read-only by default).",
		].join("\n"),
		parameters: z.object({
			task: z
				.string()
				.describe(
					"Detailed instructions for the child agent. Be specific about what it should do and what it should return.",
				),
			tools: z
				.array(
					z.enum([
						"read_file",
						"list_files",
						"write_file",
						"run_shell",
						"todo",
						"summon",
						"retrieve",
					]),
				)
				.optional()
				.describe(
					'Tool names to give the child. Defaults to ["read_file", "list_files", "todo"]. Include "summon" and "retrieve" to allow nesting.',
				),
			working_directory: z
				.string()
				.optional()
				.describe(
					"Absolute path for the child to work in. Defaults to the current working directory.",
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const task = args.task as string;
			const tools = (args.tools as string[] | undefined) ?? ["read_file", "list_files", "todo"];
			const workingDirectory =
				(args.working_directory as string | undefined) ?? defaultWorkingDirectory;

			try {
				const agentId = await callbacks.spawn({
					task,
					tools,
					workingDirectory,
				});
				return [
					`Agent spawned successfully.`,
					`agent_id: ${agentId}`,
					``,
					`The child agent is now working on the task in its own tab.`,
					`Use the retrieve tool with this agent_id to get the result when ready.`,
				].join("\n");
			} catch (err) {
				return `Error spawning agent: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
