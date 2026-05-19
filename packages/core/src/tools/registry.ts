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
				const t = tool({
					description: def.description,
					parameters: schema instanceof z.ZodObject ? schema : z.object({}),
					execute: async (args) => {
						return def.execute(args as Record<string, unknown>);
					},
				});
				// The AI SDK tool() overloads cause type narrowing issues when
				// execute is provided. The runtime value is correct.
				result[name] = t as unknown as ReturnType<typeof tool>;
			}
			return result;
		},
	};
}
