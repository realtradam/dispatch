import type { ToolContract, ToolParameterSchema } from "@dispatch/kernel";

export interface OpenAITool {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: ToolParameterSchema;
	};
}

export function convertTools(tools: readonly ToolContract[]): OpenAITool[] {
	return tools.map(convertTool);
}

function convertTool(tool: ToolContract): OpenAITool {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}
