/**
 * send_agent_message — sends a message to an existing conversation (except self)
 * (plan §6.5). There is NO delivery parameter: if the target is idle a new
 * turn starts; if it is active the message is queued for steering (the
 * orchestrator's existing behavior handles both). `wait` defaults false; when
 * the message starts a new turn, wait=true waits for that turn; when the
 * message is queued, wait=true is rejected. After delivery, the caller can use
 * read_agent only within its separate read scope (descendants and self).
 * `open` defaults false for follow-ups. The target's persisted workspace,
 * model, tool policy, and computer remain authoritative.
 */

import type { ToolContract, ToolResult } from "@dispatch/kernel";
import { formatError, formatSendAgentResult } from "../pure.js";
import type { AgentManagementService } from "../service.js";

export function createSendAgentMessageTool(service: AgentManagementService): ToolContract {
  return {
    name: "send_agent_message",
    description:
      "Send a message to an existing agent conversation. If the agent is idle a " +
      "new turn starts; if it is active the message is queued for steering " +
      "(automatic — no delivery mode to choose). Accepts a full id or globally unique prefix " +
      "(>=4 chars) across all existing conversations. Targets may be parents, siblings, " +
      "unrelated roots, or in other workspaces (not yourself). 'files' are text files " +
      "folded into the message (like --file). " +
      "wait=true waits only when a new turn starts (rejected when queued). " +
      "open=true opens the conversation in the frontend (default false).",
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description:
            "Full conversation id or globally unique prefix (>=4 chars), any workspace/lineage except self.",
        },
        message: {
          type: "string",
          description: "The message text to deliver. Required.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Text files to read and fold into the message (resolved against the target's cwd).",
        },
        wait: {
          type: "boolean",
          description:
            "true = wait for the started turn to settle and return final reply " +
            "(only when a new turn starts; rejected when queued). Default false.",
        },
        open: {
          type: "boolean",
          description: "true = open/focus the conversation in the frontend (default false).",
        },
      },
      required: ["conversationId", "message"],
    },
    concurrencySafe: false,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content:
            "Error [invalid-input]: send_agent_message requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as {
        conversationId?: unknown;
        message?: unknown;
        files?: unknown;
        wait?: unknown;
        open?: unknown;
      } | null;

      const files = Array.isArray(input?.files)
        ? input.files.filter((f): f is string => typeof f === "string")
        : undefined;

      const result = await service.send({
        callerConversationId,
        conversationId: typeof input?.conversationId === "string" ? input.conversationId : "",
        message: typeof input?.message === "string" ? input.message : "",
        ...(files !== undefined && files.length > 0 ? { files } : {}),
        ...(typeof input?.wait === "boolean" ? { wait: input.wait } : {}),
        ...(typeof input?.open === "boolean" ? { open: input.open } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatSendAgentResult(result.value) };
    },
  };
}
