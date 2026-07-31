/**
 * list_agents — lists manageable conversations, defaulting to the caller's
 * current workspace (plan §6.3). Defaults: relationship=children,
 * status=[active,queued,idle], newest activity first, bounded result count.
 * Returns concise machine-readable JSON text, never a terminal table.
 */

import type { ConversationStatus } from "@dispatch/kernel";
import type { ToolContract, ToolResult } from "@dispatch/kernel";
import type { AgentManagementService } from "../service.js";
import { formatError, formatListAgentsResult } from "../pure.js";

const VALID_STATUSES: readonly ConversationStatus[] = ["active", "queued", "idle", "closed"];

export function createListAgentsTool(service: AgentManagementService): ToolContract {
  return {
    name: "list_agents",
    description:
      "List agent conversations you can manage. By default lists your direct " +
      "children (conversations you summoned) with active/queued/idle status, " +
      "newest activity first. Use relationship=descendants for the full " +
      "descendant tree, or relationship=workspace for all conversations in " +
      "your workspace (concise metadata; mutations still limited to your " +
      "descendants). Returns stable machine-readable text.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "Workspace to list (defaults to your workspace; for relationship=workspace).",
        },
        status: {
          type: "array",
          items: { type: "string", enum: ["active", "queued", "idle", "closed"] },
          description: "Filter by lifecycle status (default: active, queued, idle).",
        },
        relationship: {
          type: "string",
          enum: ["children", "descendants", "workspace"],
          description: "Scope: children (default), descendants, or workspace.",
        },
        query: {
          type: "string",
          description: "Case-insensitive substring filter over title/conversation id.",
        },
        limit: {
          type: "number",
          description: "Maximum number of agents to return (bounded).",
        },
      },
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content: "Error [invalid-input]: list_agents requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as {
        workspaceId?: unknown;
        status?: unknown;
        relationship?: unknown;
        query?: unknown;
        limit?: unknown;
      } | null;

      const status = Array.isArray(input?.status)
        ? input.status.filter((s): s is ConversationStatus =>
            typeof s === "string" && VALID_STATUSES.includes(s as ConversationStatus),
          )
        : undefined;
      const relationship =
        input?.relationship === "children" ||
        input?.relationship === "descendants" ||
        input?.relationship === "workspace"
          ? input.relationship
          : undefined;

      const result = await service.list({
        callerConversationId,
        ...(typeof input?.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
        ...(status !== undefined && status.length > 0 ? { status } : {}),
        ...(relationship !== undefined ? { relationship } : {}),
        ...(typeof input?.query === "string" ? { query: input.query } : {}),
        ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatListAgentsResult(result.value) };
    },
  };
}
