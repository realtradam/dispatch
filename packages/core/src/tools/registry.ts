import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types/index.js";

/**
 * Convert an internal `ToolDefinition` (Zod-parameterised) to an AI SDK v6
 * `Tool` object.
 *
 * Critically, NO `execute` function is attached.  The agent's manual tool
 * loop (see agent.ts) handles execution itself — for permission prompts,
 * shell-output streaming, and queued-message injection.  Without `execute`,
 * the SDK never auto-runs tools; it only surfaces `tool-call` events from
 * `fullStream` that agent.ts collects and dispatches.
 */
function toAISDKTool(def: ToolDefinition): Tool {
	return tool({
		description: def.description,
		inputSchema: jsonSchema(zodToJsonSchema(def.parameters)),
	});
}

export function createToolRegistry(tools: ToolDefinition[]) {
	const toolMap = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

	return {
		getTools(): ToolDefinition[] {
			return [...toolMap.values()];
		},

		getTool(name: string): ToolDefinition | undefined {
			return toolMap.get(name);
		},

		/**
		 * Returns AI SDK v6 `Tool` objects keyed by tool name, for passing
		 * directly to `streamText({ tools })`.
		 *
		 * Each tool has:
		 *  - `description`  — forwarded verbatim from the internal definition.
		 *  - `inputSchema`  — Zod schema converted to JSONSchema7 via
		 *                     `zod-to-json-schema`, then wrapped with the v6
		 *                     `jsonSchema()` helper.
		 *  - NO `execute`   — intentional; see `toAISDKTool` above.
		 */
		getAISDKTools(): Record<string, Tool> {
			const result: Record<string, Tool> = {};
			for (const [name, def] of toolMap) {
				result[name] = toAISDKTool(def);
			}
			return result;
		},
	};
}
