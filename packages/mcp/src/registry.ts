/**
 * Tool name namespacing + ToolContract adapter.
 *
 * Namespaces each MCP tool as <serverId>__<toolName> (double underscore).
 * Adapts an MCP tool definition into a Dispatch ToolContract whose execute()
 * proxies to the MCP server via the injected McpToolCaller (client.callTool()).
 *
 * PURE: depends only on the McpToolCaller port — never on the concrete client.
 */

import type {
  ToolContract,
  ToolExecuteContext,
  ToolParameterSchema,
  ToolResult,
} from "@dispatch/kernel";
import type { McpContentItem, McpToolAnnotations, McpToolCaller, McpToolInfo } from "./types.js";

const NAMESPACE_SEP = "__";

/**
 * Map MCP tool annotations to the kernel's `concurrencySafe` flag.
 *
 * Safe ONLY when the server explicitly claims `readOnlyHint: true` AND does
 * not contradict itself with `destructiveHint: true`. Missing/false hints are
 * UNSAFE (the conservative default): hints are untrusted, and a mutating
 * server-side tool must never run concurrently with anything else.
 */
export function isConcurrencySafe(annotations: McpToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}

export function namespace(serverId: string, toolName: string): string {
  return `${serverId}${NAMESPACE_SEP}${toolName}`;
}

export function adaptTool(
  serverId: string,
  mcpTool: McpToolInfo,
  caller: McpToolCaller,
): ToolContract {
  const parameters: ToolParameterSchema = {
    type: "object",
    ...(mcpTool.inputSchema.properties !== undefined && {
      properties: mcpTool.inputSchema.properties,
    }),
    ...(mcpTool.inputSchema.required !== undefined && {
      required: mcpTool.inputSchema.required,
    }),
    ...(mcpTool.inputSchema.additionalProperties !== undefined && {
      additionalProperties: mcpTool.inputSchema.additionalProperties,
    }),
  };

  return {
    name: namespace(serverId, mcpTool.name),
    description: `[${serverId}] ${mcpTool.description}`,
    parameters,
    concurrencySafe: isConcurrencySafe(mcpTool.annotations),
    execute: async (args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> => {
      const result = await caller.callTool(mcpTool.name, args, ctx.signal);
      const toolResult: ToolResult = {
        content: flattenContent(result.content),
      };
      if (result.isError !== undefined) {
        (toolResult as { isError?: boolean }).isError = result.isError;
      }
      return toolResult;
    },
  };
}

export function flattenContent(content: readonly McpContentItem[]): string {
  if (content.length === 0) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && item.text !== undefined) {
      parts.push(item.text);
    } else if (item.type === "image" && item.mimeType !== undefined) {
      parts.push(`[image: ${item.mimeType}]`);
    } else if (item.type === "resource" && item.resource !== undefined) {
      if (item.resource.text !== undefined) {
        parts.push(item.resource.text);
      } else {
        parts.push(`[resource: ${item.resource.uri}]`);
      }
    }
  }
  return parts.join("\n");
}
