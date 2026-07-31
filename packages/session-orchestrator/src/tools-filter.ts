import {
  type ConversationToolPolicy,
  defineFilter,
  type FilterDescriptor,
  type ToolContract,
} from "@dispatch/kernel";

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
  /**
   * The resolved model name for this turn (per-turn override → persisted →
   * undefined), for model-aware filters (e.g. vision-handoff hiding
   * `consult_vision` from vision-capable models). Omitted/`undefined` when no
   * model resolved (the default-provider fallthrough); model-aware filters
   * treat absence as "unknown metadata". Threaded into the assembly so every
   * filter in the chain sees the same model the provider will stream with.
   */
  readonly modelName?: string;
  /**
   * The turn's abort signal, threaded through the filter chain so a filter that
   * awaits slow I/O (e.g. the MCP tools filter connecting to MCP servers) can be
   * interrupted by `POST /conversations/:id/stop` instead of blocking the turn
   * until its own timeout fires. Optional: omitted by paths that have no turn
   * controller (e.g. the cache-warm probe), in which case filters fall back to
   * their own timeouts. Filters that return a fresh assembly MUST preserve it.
   */
  readonly signal?: AbortSignal;
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
    ...(assembly.modelName !== undefined ? { modelName: assembly.modelName } : {}),
    ...(assembly.signal !== undefined ? { signal: assembly.signal } : {}),
  };
}

// ── Durable conversation tool policy ────────────────────────────────────────
//
// Pure enforcement of a persisted per-conversation tool policy. Applied by the
// orchestrator AFTER the entire `toolsFilter` chain runs, so NO extension
// filter can reintroduce a tool into a restricted conversation (plan §10.2/§17
// Wave 2 Unit C). Reading the policy from the store is an injected I/O effect
// (the orchestrator does it); this function is the pure decision (input →
// filtered assembly, no I/O), extracted so it is unit-testable without a store.

/**
 * Apply a persisted {@link ConversationToolPolicy} to an assembled tool set.
 * Runs LAST in tool assembly (after the `toolsFilter` chain) so a later
 * extension filter cannot re-add a tool into a restricted conversation.
 *
 * - `mode: "none"` — returns an empty tool set (vision consultations, etc.).
 * - `mode: "all"` — passes everything through (the default / ordinary case).
 * - `mode: "allow"` — keeps ONLY tools whose name is in `names` (intersection).
 * - `mode: "deny"` — removes tools whose name is in `names`.
 *
 * Tool-name matching is DATA (the kernel routes tool-calls by name — that is
 * the sanctioned string-keyed exception), so a name-based policy is correct
 * here, not a string-keyed cross-feature code lookup. The assembly's other
 * fields (`cwd`, `computerId`, `modelName`, `conversationId`, `signal`) are
 * preserved verbatim — the policy only narrows the tool set. Pure (no I/O).
 */
export function applyToolPolicy(
  assembly: ToolAssembly,
  policy: ConversationToolPolicy,
): ToolAssembly {
  switch (policy.mode) {
    case "all":
      return assembly;
    case "none":
      return stripTools(assembly, []);
    case "allow": {
      const allowed = new Set(policy.names);
      return stripTools(
        assembly,
        assembly.tools.filter((t) => allowed.has(t.name)),
      );
    }
    case "deny": {
      const denied = new Set(policy.names);
      return stripTools(
        assembly,
        assembly.tools.filter((t) => !denied.has(t.name)),
      );
    }
  }
}

/**
 * Rebuild an assembly carrying the given (filtered) tool set, preserving every
 * non-tool field verbatim. Extracted so both the `none` (empty) and `allow`
 * (intersected) paths share one assembly-reconstruction site — no field is
 * silently dropped when the policy narrows the tool set.
 */
function stripTools(assembly: ToolAssembly, tools: readonly ToolContract[]): ToolAssembly {
  return {
    tools,
    ...(assembly.cwd !== undefined ? { cwd: assembly.cwd } : {}),
    ...(assembly.computerId !== undefined ? { computerId: assembly.computerId } : {}),
    conversationId: assembly.conversationId,
    ...(assembly.modelName !== undefined ? { modelName: assembly.modelName } : {}),
    ...(assembly.signal !== undefined ? { signal: assembly.signal } : {}),
  };
}
