/**
 * list_agent_models — returns the model catalog available for `summon_agent`
 * (plan §6.1). Reads the catalog through the typed `credential-store` service;
 * never calls the HTTP endpoint or CLI. Returns exact model names plus
 * metadata (context window, vision). `vision` restricts by authoritative
 * `ModelInfo.vision` with the name heuristic as a fallback only.
 */

import type { ToolContract, ToolResult } from "@dispatch/kernel";
import { formatError, formatListModelsResult } from "../pure.js";
import type { AgentManagementService } from "../service.js";

export function createListAgentModelsTool(service: AgentManagementService): ToolContract {
  return {
    name: "list_agent_models",
    description:
      "List the models available for summon_agent. Returns exact model names " +
      "(<credential>/<model>) plus context window and vision metadata. Use " +
      "'query' to filter by name, 'vision' to restrict to vision-capable " +
      "models, and 'limit' to cap the result count. Do NOT use run_shell + " +
      "'dispatch models' — this tool is the supported way to discover a valid " +
      "model name.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive substring filter over model name/display name.",
        },
        vision: {
          type: "boolean",
          description:
            "true = only vision-capable models; false = only non-vision models; " +
            "omit = no vision filter.",
        },
        limit: {
          type: "number",
          description: "Maximum number of models to return (bounded).",
        },
      },
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content:
            "Error [invalid-input]: list_agent_models requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as { query?: unknown; vision?: unknown; limit?: unknown } | null;
      const result = await service.listModels({
        callerConversationId,
        ...(typeof input?.query === "string" ? { query: input.query } : {}),
        ...(typeof input?.vision === "boolean" ? { vision: input.vision } : {}),
        ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatListModelsResult(result.value) };
    },
  };
}
