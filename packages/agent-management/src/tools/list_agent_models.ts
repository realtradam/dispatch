/**
 * list_agent_models — returns ONLY the locally configured Named Agents
 * available for `summon_agent` (plan §8.1). Reads the Named Agent registry
 * directly; performs ZERO provider-catalog calls. Returns each Named Agent's
 * friendly name, stable id, and the resolved canonical `<credential>/<model>`
 * it is bound to. Pass a returned Named Agent's `name` (or id) to
 * `summon_agent` as `agent`; do not guess raw provider/model identifiers.
 *
 * `query` is a case-insensitive substring filter over the Named Agent name;
 * `limit` caps the result count. Vision filtering is intentionally omitted
 * (no local metadata supports it). When no Named Agents are configured the
 * result carries immediate setup guidance — it never falls back to the raw
 * catalog.
 */

import type { ToolContract, ToolResult } from "@dispatch/kernel";
import { formatError, formatListModelsResult } from "../pure.js";
import type { AgentManagementService } from "../service.js";

export function createListAgentModelsTool(service: AgentManagementService): ToolContract {
  return {
    name: "list_agent_models",
    description:
      "List the Named Agents available for summon_agent. Returns the locally " +
      "configured Named Agents (a friendly name bound to one provider/model) — " +
      "NOT the full raw provider catalog. Pass a returned Named Agent's name " +
      "or id to summon_agent as 'agent'. Use 'query' to filter by name and " +
      "'limit' to cap the result count. Do NOT use run_shell + 'dispatch " +
      "models' — this tool is the supported way to discover a Named Agent to " +
      "summon. When no Named Agents are configured, ask the user to add one " +
      "in the Named Agents sidebar view.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive substring filter over the Named Agent name.",
        },
        limit: {
          type: "number",
          description: "Maximum number of Named Agents to return (bounded).",
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
      const input = args as { query?: unknown; limit?: unknown } | null;
      const result = await service.listModels({
        callerConversationId,
        ...(typeof input?.query === "string" ? { query: input.query } : {}),
        ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatListModelsResult(result.value) };
    },
  };
}
