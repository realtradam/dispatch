import { tool } from "ai";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export function createToolRegistry(tools: ToolDefinition[]) {
	const toolMap = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

	return {
		getTools(): ToolDefinition[] {
			return [...toolMap.values()];
		},

		getTool(name: string): ToolDefinition | undefined {
			return toolMap.get(name);
		},

		getAISDKTools() {
			const result: Record<string, ReturnType<typeof tool>> = {};
			for (const [name, def] of toolMap) {
				const schema = def.parameters;
				// Do NOT pass execute here — agent.ts handles tool execution
				// manually via executeToolWithStreaming. Passing execute would
				// cause the AI SDK to auto-execute tools AND agent.ts to execute
				// them again, resulting in double execution.
				const t = tool({
					description: def.description,
					parameters: schema instanceof z.ZodObject ? schema : z.object({}),
				});
				result[name] = t as unknown as ReturnType<typeof tool>;
			}
			return result;
		},
	};
}
