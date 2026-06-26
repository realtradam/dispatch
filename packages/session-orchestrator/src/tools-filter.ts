import { defineFilter, type FilterDescriptor, type ToolContract } from "@dispatch/kernel";

/** Per-turn tool-assembly value threaded through the `tools` filter chain. */
export interface ToolAssembly {
  /** The tool set resolved for this turn (the value filters transform). */
  readonly tools: readonly ToolContract[];
  /** This turn's working directory (verbatim from the request), for cwd-aware filters. */
  readonly cwd?: string;
  /**
   * The computer this turn executes on (SSH alias), for computer-aware
   * filters. Omitted/`undefined` = LOCAL (today's behavior). When set, the
   * turn is REMOTE — {@link filterRemoteIncompatibleTools} drops tools that
   * cannot run over SFTP (local-process servers). Mirrors `cwd?`.
   */
  readonly computerId?: string;
  /** The conversation this turn belongs to. */
  readonly conversationId: string;
}

/** Filter chain run once per turn to transform the tool set before it reaches runTurn. */
export const toolsFilter: FilterDescriptor<ToolAssembly> = defineFilter<ToolAssembly>(
  "session-orchestrator/tools",
);

/**
 * Remote-degradation rule (plan §6). When a turn is REMOTE
 * (`assembly.computerId !== undefined`), drop tools that cannot execute over
 * SFTP because they spawn local processes:
 *
 * - the tool named exactly `"lsp"` — its servers are local LSP processes that
 *   can't see remote files over SFTP, AND
 * - any tool whose name includes `"__"` — MCP-namespaced tools
 *   (`<serverId>__<toolName>`); MCP servers spawn local processes.
 *
 * When `assembly.computerId` is `undefined` (LOCAL), this is a passthrough —
 * nothing is dropped (byte-identical to today). Tool-name matching is DATA (the
 * kernel routes tool-calls by name — that is the sanctioned string-keyed
 * exception), so a name-based filter is correct here, not a string-keyed
 * cross-feature code lookup.
 *
 * Extracted from the filter handler so it is unit-testable without I/O. Mirrors
 * MCP's `filterMcpTools` extraction pattern.
 */
export function filterRemoteIncompatibleTools(assembly: ToolAssembly): ToolAssembly {
  // LOCAL — passthrough, byte-identical to today.
  if (assembly.computerId === undefined) return assembly;
  // REMOTE — drop lsp + MCP-namespaced tools (local-process servers).
  const filtered = assembly.tools.filter((tool) => {
    if (tool.name === "lsp") return false;
    if (tool.name.includes("__")) return false;
    return true;
  });
  return {
    tools: filtered,
    ...(assembly.cwd !== undefined ? { cwd: assembly.cwd } : {}),
    ...(assembly.computerId !== undefined ? { computerId: assembly.computerId } : {}),
    conversationId: assembly.conversationId,
  };
}
