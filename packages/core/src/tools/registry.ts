import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types/index.js";

/**
 * Strip JSON Schema fields that Anthropic's API does not accept from a
 * `zodToJsonSchema()` output. The Anthropic `/messages` API rejects (or
 * silently ignores) tools whose `input_schema` contains `$schema`,
 * `additionalProperties`, `default`, or `nullable` — when this happens
 * Claude never sees the tool and the model "thinks forever" instead of
 * calling it.
 *
 * The stripped fields are also harmless to remove for OpenAI-compatible
 * endpoints, so we apply this unconditionally.
 */
function normalizeForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
	delete schema.$schema;
	delete schema.additionalProperties;
	delete schema.default;
	delete schema.nullable;

	const properties = schema.properties;
	if (properties && typeof properties === "object") {
		for (const key of Object.keys(properties as Record<string, unknown>)) {
			const prop = (properties as Record<string, unknown>)[key];
			if (prop && typeof prop === "object") {
				normalizeForAnthropic(prop as Record<string, unknown>);
			}
		}
	}

	const items = schema.items;
	if (items && typeof items === "object") {
		normalizeForAnthropic(items as Record<string, unknown>);
	}

	return schema;
}

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
	const raw = zodToJsonSchema(def.parameters) as Record<string, unknown>;
	const normalized = normalizeForAnthropic(raw);
	return tool({
		description: def.description,
		inputSchema: jsonSchema(normalized),
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
