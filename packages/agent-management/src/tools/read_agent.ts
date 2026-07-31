/**
 * read_agent — reads an agent's latest response or status without replaying
 * its full stream (plan §6.4). Short-ID prefixes (>=4 chars) are resolved only
 * within the caller's authorized scope. `wait: true` waits (event-driven, no
 * polling) until the active turn settles or the parent turn is cancelled.
 * Never returns private reasoning — only `type === "text"` chunks are selected.
 */

import type { ToolContract, ToolResult } from "@dispatch/kernel";
import { formatError, formatReadAgentResult } from "../pure.js";
import type { AgentManagementService } from "../service.js";

export function createReadAgentTool(service: AgentManagementService): ToolContract {
  return {
    name: "read_agent",
    description:
      "Read an agent's latest assistant reply and status without replaying its " +
      "full stream. Accepts a full conversation id or a short-id prefix (at " +
      "least 4 characters) resolved within your manageable scope. Ambiguous " +
      "prefixes return candidates. Returns only assistant text — never private " +
      "reasoning. Set wait=true to block until the agent's active turn settles " +
      "(stopping you cancels the wait but leaves the agent running).",
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Full conversation id or short-id prefix (>=4 chars).",
        },
        wait: {
          type: "boolean",
          description: "true = wait until the active turn settles (default false).",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters of reply text to return (bounded).",
        },
      },
      required: ["conversationId"],
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content: "Error [invalid-input]: read_agent requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as { conversationId?: unknown; wait?: unknown; maxChars?: unknown } | null;
      const result = await service.read({
        callerConversationId,
        conversationId: typeof input?.conversationId === "string" ? input.conversationId : "",
        ...(typeof input?.wait === "boolean" ? { wait: input.wait } : {}),
        ...(typeof input?.maxChars === "number" ? { maxChars: input.maxChars } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatReadAgentResult(result.value) };
    },
  };
}
