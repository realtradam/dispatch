import { z } from "zod";
import type { AgentDefinition, ToolDefinition } from "../types/index.js";

export interface SummonCallbacks {
	spawn(options: {
		task: string;
		tools: string[];
		workingDirectory?: string;
		/**
		 * Optional slug of an `AgentDefinition` (loaded from
		 * `~/.config/dispatch/agents/` or `<projectDir>/.dispatch/agents/`)
		 * to use as the basis for the spawned child. When provided,
		 * the definition's tools, models, and cwd override the
		 * `tools` and `workingDirectory` parameters passed alongside.
		 */
		agentSlug?: string;
	}): Promise<string>;
	getResult(
		agentId: string,
	): Promise<{ status: "done"; result: string } | { status: "error"; error: string }>;
}

/**
 * Summary of an agent definition surfaced to the calling LLM in the
 * summon tool's description. The shape is intentionally minimal — full
 * TOML inspection is done by reading the definition file directly,
 * which all agents are allowed to do by default.
 */
export interface AvailableAgent {
	slug: string;
	name: string;
	description: string;
	/** Filesystem path of the TOML the agent can read for full details. */
	path: string;
}

/**
 * Build the prose paragraph that lists available agent definitions plus
 * the disk locations where they live, injected into the summon tool's
 * description.
 *
 * Returns the empty string when no agents are visible — keeps the
 * description compact for environments where no definitions exist yet.
 */
function buildAgentsCatalog(agents: AvailableAgent[], agentDirs: string[]): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("Agent definitions live on disk and can be inspected with read_file/list_files:");
	for (const d of agentDirs) {
		lines.push(`  - ${d}`);
	}
	if (agents.length === 0) {
		lines.push("");
		lines.push("No agent definitions are currently defined.");
		return lines.join("\n");
	}
	lines.push("");
	lines.push("To summon a specific agent, pass its slug as the 'agent' parameter.");
	lines.push("When 'agent' is set, the child inherits that definition's tools, models,");
	lines.push("and working directory; the 'tools' parameter is ignored.");
	lines.push("");
	lines.push("Available agents:");
	for (const a of agents) {
		const desc = a.description ? ` — ${a.description}` : "";
		lines.push(`  - ${a.slug}: ${a.name}${desc}`);
	}
	return lines.join("\n");
}

/**
 * Factory for the `summon` tool. Accepts a snapshot of agent definitions
 * available at the time the tool is registered so the LLM's view of
 * which agents exist matches what `spawnChildAgent` can actually load.
 *
 * `agentDirs` is the list of filesystem paths the catalog references in
 * its description; this is information-only — the runtime resolves
 * slugs through `loadAgent` independently.
 */
export function createSummonTool(
	defaultWorkingDirectory: string,
	callbacks: SummonCallbacks,
	availableAgents: AvailableAgent[] = [],
	agentDirs: string[] = [],
): ToolDefinition {
	const catalog = buildAgentsCatalog(availableAgents, agentDirs);
	const agentSlugs = availableAgents.map((a) => a.slug);

	return {
		name: "summon",
		description: [
			"Spawn a new child agent to work on a task independently.",
			"",
			"By default, blocks until the child agent finishes and returns the result directly.",
			"Set background=true to return immediately with an agent_id instead — use retrieve to collect the result later.",
			"",
			"The child agent runs in its own tab visible to the user. Use the 'retrieve' tool with the returned agent_id to get the result when needed.",
			"",
			"Pattern for parallel work:",
			"  1. Call summon multiple times with background=true to start several agents",
			"  2. Do your own work or wait",
			"  3. Call retrieve for each agent_id to collect results",
			"",
			"The 'tools' parameter controls what the child can do. Available tool names:",
			"  - read_file: Read file contents",
			"  - list_files: List files and directories",
			"  - write_file: Write/edit files",
			"  - run_shell: Execute shell commands",
			"  - todo: Track work items",
			"  - summon: Spawn its own child agents (enables nesting)",
			"  - retrieve: Collect results from its children (required if summon is given)",
			"  - web_search: Search the web",
			"  - youtube_transcribe: Fetch YouTube video transcripts",
			"",
			"If tools is omitted (and no 'agent' is specified), the child gets read_file, list_files, and todo only (read-only by default).",
			catalog,
		].join("\n"),
		parameters: z.object({
			task: z
				.string()
				.describe(
					"Detailed instructions for the child agent. Be specific about what it should do and what it should return.",
				),
			agent: z
				.string()
				.optional()
				.describe(
					[
						"Slug of an agent definition to use as the basis for the child agent.",
						"When provided, the child inherits the definition's tools, models, and",
						"working directory; the 'tools' parameter is ignored. Inspect the agent",
						"directories listed above to discover which slugs are available and what",
						"each one does.",
						agentSlugs.length > 0 ? `Available slugs: ${agentSlugs.join(", ")}.` : "",
					]
						.filter(Boolean)
						.join(" "),
				),
			tools: z
				.array(
					z.enum([
						"read_file",
						"list_files",
						"write_file",
						"run_shell",
						"todo",
						"summon",
						"retrieve",
						"web_search",
						"youtube_transcribe",
					]),
				)
				.optional()
				.describe(
					'Tool names to give the child. Defaults to ["read_file", "list_files", "todo"]. Include "summon" and "retrieve" to allow nesting. Ignored when "agent" is set.',
				),
			working_directory: z
				.string()
				.optional()
				.describe(
					"Absolute path for the child to work in. Defaults to the current working directory. When 'agent' is set and its definition has a cwd, that takes precedence.",
				),
			background: z
				.boolean()
				.optional()
				.describe(
					"If true, returns immediately with an agent_id for later retrieval. If false (default), blocks until the child agent finishes and returns the result directly.",
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const task = args.task as string;
			const agentSlug = args.agent as string | undefined;
			const tools = (args.tools as string[] | undefined) ?? ["read_file", "list_files", "todo"];
			const workingDirectory =
				(args.working_directory as string | undefined) ?? defaultWorkingDirectory;
			const background = (args.background as boolean | undefined) ?? false;

			try {
				const agentId = await callbacks.spawn({
					task,
					tools,
					workingDirectory,
					...(agentSlug ? { agentSlug } : {}),
				});

				if (!background) {
					// Block until the child agent completes
					const result = await callbacks.getResult(agentId);
					if (result.status === "done") {
						return result.result;
					}
					return `Error from child agent: ${result.error}`;
				}

				return [
					`Agent spawned successfully.`,
					`agent_id: ${agentId}`,
					``,
					`The child agent is now working on the task in its own tab.`,
					`Use the retrieve tool with this agent_id to get the result when ready.`,
				].join("\n");
			} catch (err) {
				return `Error spawning agent: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}

/**
 * Build the `AvailableAgent[]` projection from a list of full
 * `AgentDefinition` records. Each entry's `path` is derived from the
 * scope+slug so the agent can `read_file(path)` directly.
 */
export function toAvailableAgents(
	defs: AgentDefinition[],
	globalDir: string,
	projectDir: string | null,
): AvailableAgent[] {
	return defs.map((d) => {
		const baseDir =
			d.scope === "global"
				? globalDir
				: projectDir
					? `${projectDir.replace(/\/$/, "")}/.dispatch/agents`
					: globalDir;
		return {
			slug: d.slug,
			name: d.name,
			description: d.description,
			path: `${baseDir}/${d.slug}.toml`,
		};
	});
}
