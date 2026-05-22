import { z } from "zod";
import type { ToolDefinition, ToolExecuteContext } from "../types/index.js";

export interface RetrieveCallbacks {
	getResult(
		agentId: string,
	): Promise<{ status: "done"; result: string } | { status: "error"; error: string }>;
}

export function createRetrieveTool(callbacks: RetrieveCallbacks): ToolDefinition {
	return {
		name: "retrieve",
		description: [
			"Wait for a child agent or backgrounded shell command to finish and retrieve its result. This tool BLOCKS until completion.",
			"",
			"Pass the ID returned by summon (agent_id) or by an interrupted run_shell (job_id). Once it finishes, the output is returned.",
			"If an error occurred, the error message is returned instead.",
			"",
			"Typical usage:",
			'  1. summon({ task: "...", tools: [...] })  -> get agent_id',
			"  2. ... do other work or summon more agents ...",
			'  3. retrieve({ agent_id: "..." })  -> blocks until done, returns result',
			"",
			"Also used for backgrounded shell commands:",
			"  If run_shell is interrupted by a user message, it returns a job_id (run_shell_...).",
			'  Use retrieve({ agent_id: "run_shell_..." }) to get the final output when ready.',
		].join("\n"),
		parameters: z.object({
			agent_id: z.string().describe("The agent_id returned by a previous summon call."),
		}),
		execute: async (
			args: Record<string, unknown>,
			context?: ToolExecuteContext,
		): Promise<string> => {
			const agentId = args.agent_id as string;
			const queueCallbacks = context?.queueCallbacks;

			try {
				let outcome: { status: "done"; result: string } | { status: "error"; error: string };

				if (queueCallbacks) {
					const childPromise = callbacks.getResult(agentId);
					const { promise: queuePromise, cancel: cancelQueueWait } =
						queueCallbacks.waitForQueuedMessage();
					const queueSignal = queuePromise.then(() => "QUEUE_INTERRUPT" as const);

					const raceResult = await Promise.race([childPromise, queueSignal]);

					if (raceResult === "QUEUE_INTERRUPT") {
						const queuedMsgs = queueCallbacks.dequeueMessages();
						const userMessages = queuedMsgs.map((m) => m.message).join("\n---\n");
						return `The subagent (agent_id: ${agentId}) has not completed its task yet. You will need to call retrieve with this agent_id again later to get the result.\n\n[USER INTERRUPT]\nThe user has sent you message(s) while you were working. You MUST address these before continuing with your current task:\n\n${userMessages}`;
					}

					// Child finished first — clean up the queue listener
					cancelQueueWait();
					outcome = raceResult;
				} else {
					outcome = await callbacks.getResult(agentId);
				}

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
