import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export interface RetrieveCallbacks {
	getResult(
		agentId: string,
	): Promise<{ status: "done"; result: string } | { status: "error"; error: string }>;
}

export function createRetrieveTool(callbacks: RetrieveCallbacks): ToolDefinition {
	return {
		name: "retrieve",
		description: [
			"Wait for a child agent to finish and retrieve its result. This tool BLOCKS until the child completes.",
			"",
			"Pass the agent_id returned by the summon tool. Once the child finishes, its final output is returned.",
			"If the child encountered an error, the error message is returned instead.",
			"",
			"Typical usage:",
			'  1. summon({ task: "...", tools: [...] })  -> get agent_id',
			"  2. ... do other work or summon more agents ...",
			'  3. retrieve({ agent_id: "..." })  -> blocks until done, returns result',
		].join("\n"),
		parameters: z.object({
			agent_id: z.string().describe("The agent_id returned by a previous summon call."),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const agentId = args.agent_id as string;

			try {
				const outcome = await callbacks.getResult(agentId);
				if (outcome.status === "done") {
					return ["<agent_result>", outcome.result, "</agent_result>"].join("\n");
				}
				return `Agent error: ${outcome.error}`;
			} catch (err) {
				return `Error retrieving result: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
