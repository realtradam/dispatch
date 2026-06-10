import { defineFilter, type FilterDescriptor, type ToolContract } from "@dispatch/kernel";

/** Per-turn tool-assembly value threaded through the `tools` filter chain. */
export interface ToolAssembly {
	/** The tool set resolved for this turn (the value filters transform). */
	readonly tools: readonly ToolContract[];
	/** This turn's working directory (verbatim from the request), for cwd-aware filters. */
	readonly cwd?: string;
	/** The conversation this turn belongs to. */
	readonly conversationId: string;
}

/** Filter chain run once per turn to transform the tool set before it reaches runTurn. */
export const toolsFilter: FilterDescriptor<ToolAssembly> = defineFilter<ToolAssembly>(
	"session-orchestrator/tools",
);
