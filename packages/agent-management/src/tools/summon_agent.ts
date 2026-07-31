/**
 * summon_agent — starts a new subagent conversation and its first turn (plan §6.2).
 *
 * The schema is the NARROW surface exposed to models: it does NOT include
 * `systemPrompt` or `images` (those are service-level fields used by
 * `vision-handoff` for vision consultations). `open` defaults to `true`,
 * `wait` defaults to `false`, `toolAccess` defaults to `"all"`. Workspace,
 * working directory, and computer inherit the caller's effective context
 * unless explicitly overridden.
 */

import type { ReasoningEffort, ToolContract, ToolResult } from "@dispatch/kernel";
import { formatError, formatSummonResult } from "../pure.js";
import type { AgentManagementService } from "../service.js";

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function createSummonAgentTool(service: AgentManagementService): ToolContract {
  return {
    name: "summon_agent",
    description:
      "Start a new agent (subagent) conversation on a delegated task. Begins " +
      "its first turn immediately and returns the conversation id + status. By " +
      "default it inherits your workspace, working directory, and computer, " +
      "opens the new conversation in the frontend, and returns promptly (non-" +
      "blocking). Set wait=true to block until the subagent's first turn " +
      "settles and return its final reply text. Use list_agent_models to " +
      "discover a valid model name first.",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Exact model name (<credential>/<model>) from list_agent_models.",
        },
        task: {
          type: "string",
          description: "The task text for the subagent. Required.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Text files to read and fold into the task (like the CLI --file). " +
            "Resolved against the subagent's working directory; never attaches " +
            "images.",
        },
        cwd: {
          type: "string",
          description: "Working directory override (defaults to your effective cwd).",
        },
        workspaceId: {
          type: "string",
          description:
            "Workspace override (defaults to your workspace). Must reference an " +
            "EXISTING workspace — typo workspaces are not auto-created.",
        },
        computerId: {
          type: "string",
          description: "Computer (SSH alias) override (defaults to your effective computer).",
        },
        reasoningEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Reasoning effort level (omitted = orchestrator default).",
        },
        title: {
          type: "string",
          description: "Human-readable title for the new conversation tab.",
        },
        wait: {
          type: "boolean",
          description:
            "true = block until the first turn settles and return final reply " +
            "text (default false — return promptly). Stopping you cancels the " +
            "wait but leaves the subagent running.",
        },
        open: {
          type: "boolean",
          description: "true = open the new conversation in the frontend (default true).",
        },
        toolAccess: {
          type: "string",
          enum: ["all", "none"],
          description: "all = full tools (default); none = no tools (vision isolation).",
        },
      },
      required: ["model", "task"],
    },
    concurrencySafe: false,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const callerConversationId = ctx.conversationId;
      if (typeof callerConversationId !== "string" || callerConversationId.length === 0) {
        return {
          content: "Error [invalid-input]: summon_agent requires a caller conversation context.",
          isError: true,
        };
      }
      const input = args as {
        model?: unknown;
        task?: unknown;
        files?: unknown;
        cwd?: unknown;
        workspaceId?: unknown;
        computerId?: unknown;
        reasoningEffort?: unknown;
        title?: unknown;
        wait?: unknown;
        open?: unknown;
        toolAccess?: unknown;
      } | null;

      const files = Array.isArray(input?.files)
        ? input.files.filter((f): f is string => typeof f === "string")
        : undefined;

      const reasoningEffort =
        typeof input?.reasoningEffort === "string" &&
        REASONING_EFFORTS.includes(input.reasoningEffort as ReasoningEffort)
          ? (input.reasoningEffort as ReasoningEffort)
          : undefined;

      const result = await service.summon({
        callerConversationId,
        model: typeof input?.model === "string" ? input.model : "",
        task: typeof input?.task === "string" ? input.task : "",
        ...(files !== undefined && files.length > 0 ? { files } : {}),
        ...(typeof input?.cwd === "string" ? { cwd: input.cwd } : {}),
        ...(typeof input?.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
        ...(typeof input?.computerId === "string" ? { computerId: input.computerId } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(typeof input?.title === "string" ? { title: input.title } : {}),
        ...(typeof input?.wait === "boolean" ? { wait: input.wait } : {}),
        ...(typeof input?.open === "boolean" ? { open: input.open } : {}),
        ...(input?.toolAccess === "all" || input?.toolAccess === "none"
          ? { toolAccess: input.toolAccess }
          : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (!result.ok) return { content: formatError(result.error), isError: true };
      return { content: formatSummonResult(result.value) };
    },
  };
}
