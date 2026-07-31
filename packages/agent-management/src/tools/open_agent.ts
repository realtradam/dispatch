/**
 * open_agent — signals connected frontends to open/focus a managed conversation
 * (plan §6.7). The service resolves the conversation's persisted workspace
 * before emitting the typed `conversationOpened` hook. The backend signals;
 * the frontend decides how to render/focus it.
 */

import type { ToolContract, ToolResult } from "@dispatch/kernel";
import type { AgentManagementService } from "../service.js";
import { formatError, formatOpenAgentResult } from "../pure.js";

export function createOpenAgentTool(service: AgentManagementService): ToolContract {
  return {
    name: "open_agent",
    description:
      "Open or focus an agent conversation in the connected frontend. Accepts " +
      "a full id or short-id prefix (>=4 chars). Resolves the conversation's " +
      "workspace and emits an open signal; the frontend decides how to render " +
      "or focus it. Allowed on your descendants and your own conversation.",
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Full conversation id or short-id prefix (>=4 chars).",
        },
      },
      required: ["conversationId"],
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content: "Error [invalid-input]: open_agent requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as { conversationId?: unknown } | null;
      const result = await service.open({
        callerConversationId,
        conversationId: typeof input?.conversationId === "string" ? input.conversationId : "",
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatOpenAgentResult(result.value) };
    },
  };
}
