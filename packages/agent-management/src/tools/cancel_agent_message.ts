/**
 * cancel_agent_message — cancels one queued message previously returned by
 * `send_agent_message` (plan §6.6). Delegates to the existing message-queue
 * cancellation contract. Idempotent: returns cancelled=false when the message
 * was already delivered, cancelled, or never existed. Cannot retract steering
 * already injected into a turn.
 */

import type { ToolContract, ToolResult } from "@dispatch/kernel";
import { formatCancelAgentMessageResult, formatError } from "../pure.js";
import type { AgentManagementService } from "../service.js";

export function createCancelAgentMessageTool(service: AgentManagementService): ToolContract {
  return {
    name: "cancel_agent_message",
    description:
      "Cancel a single queued message (by its messageId from send_agent_message) " +
      "so it never runs. Only targets descendants. Idempotent: returns " +
      "cancelled=false if the message was already delivered, already cancelled, " +
      "or unknown. Cannot retract steering already injected into an in-flight turn.",
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Full conversation id or short-id prefix (>=4 chars) of a descendant.",
        },
        messageId: {
          type: "string",
          description: "The id of the queued message to cancel (from send_agent_message).",
        },
      },
      required: ["conversationId", "messageId"],
    },
    concurrencySafe: false,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content:
            "Error [invalid-input]: cancel_agent_message requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as { conversationId?: unknown; messageId?: unknown } | null;
      const result = await service.cancelMessage({
        callerConversationId,
        conversationId: typeof input?.conversationId === "string" ? input.conversationId : "",
        messageId: typeof input?.messageId === "string" ? input.messageId : "",
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatCancelAgentMessageResult(result.value) };
    },
  };
}
