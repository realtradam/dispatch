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
		/**
		 * When true, spawn the agent as an independent top-level "user
		 * agent" tab (no parent, persistent, fire-and-forget) instead of
		 * a subagent child tab. Only honoured when the spawning agent has
		 * the `perm_user_agent` permission.
		 */
		topLevel?: boolean;
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
 * Render a labelled list of agents. Returns an empty array when there
 * are no agents so callers can omit the group entirely.
 */
function renderAgentGroup(label: string, agents: AvailableAgent[]): string[] {
	if (agents.length === 0) return [];
	const lines: string[] = [label];
	for (const a of agents) {
		const desc = a.description ? ` — ${a.description}` : "";
		lines.push(`  - ${a.slug}: ${a.name}${desc}`);
	}
	return lines;
}

/**
 * Build the prose paragraph that lists available agent definitions plus
 * the disk locations where they live, injected into the summon tool's
 * description.
 *
 * When `userAgentEnabled` is false only subagents are shown (under the
 * generic "Available agents" heading). When it is true, subagents and
 * user agents are listed as two labelled groups so the LLM understands
 * which slugs require `top_level=true`.
 *
 * Returns a compact "no agents defined" notice when nothing is visible.
 */
function buildAgentsCatalog(
	subagents: AvailableAgent[],
	userAgents: AvailableAgent[],
	agentDirs: string[],
	userAgentEnabled: boolean,
): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("Agent definitions live on disk and can be inspected with read_file/list_files:");
	for (const d of agentDirs) {
		lines.push(`  - ${d}`);
	}

	const visibleUserAgents = userAgentEnabled ? userAgents : [];
	if (subagents.length === 0 && visibleUserAgents.length === 0) {
		lines.push("");
		lines.push("No agent definitions are currently defined.");
		return lines.join("\n");
	}

	lines.push("");
	lines.push("To summon a specific agent, pass its slug as the 'agent' parameter.");
	lines.push("When 'agent' is set, the child inherits that definition's tools, models,");
	lines.push("and working directory; the 'tools' parameter is ignored.");
	lines.push("");

	if (!userAgentEnabled) {
		lines.push(...renderAgentGroup("Available agents:", subagents));
		return lines.join("\n");
	}

	const subagentLines = renderAgentGroup("Subagents (spawned as child tabs):", subagents);
	const userAgentLines = renderAgentGroup(
		"User agents (spawned as independent top-level tabs, requires top_level=true):",
		visibleUserAgents,
	);
	if (subagentLines.length > 0) {
		lines.push(...subagentLines);
	}
	if (userAgentLines.length > 0) {
		if (subagentLines.length > 0) lines.push("");
		lines.push(...userAgentLines);
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
 *
 * `userAgentEnabled` controls whether the `top_level` parameter and the
 * user-agent catalog are surfaced to the LLM. It mirrors the
 * `perm_user_agent` permission.
 */
export function createSummonTool(
	_defaultWorkingDirectory: string,
	callbacks: SummonCallbacks,
	availableSubagents: AvailableAgent[] = [],
	availableUserAgents: AvailableAgent[] = [],
	agentDirs: string[] = [],
	userAgentEnabled = false,
): ToolDefinition {
	const catalog = buildAgentsCatalog(
		availableSubagents,
		availableUserAgents,
		agentDirs,
		userAgentEnabled,
	);
	const subagentSlugs = availableSubagents.map((a) => a.slug);
	const userAgentSlugs = availableUserAgents.map((a) => a.slug);
	const allSlugs = userAgentEnabled ? [...subagentSlugs, ...userAgentSlugs] : subagentSlugs;

	const description = [
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
		...(userAgentEnabled
			? [
					"",
					"Set top_level=true to spawn an independent user agent — a first-class",
					"top-level tab with no parent. User agents are fire-and-forget: you get",
					"an agent_id back but cannot retrieve their result. top_level requires an",
					"'agent' definition listed under 'User agents' below.",
				]
			: []),
		"",
		"The 'tools' parameter controls what the child can do. Available tool names:",
		"  - read_file: Read file contents",
		"  - read_file_slice: Read a character-range slice of a single line",
		"  - list_files: List files and directories",
		"  - write_file: Write/edit files",
		"  - run_shell: Execute shell commands",
		"  - todo: Track work items",
		"  - summon: Spawn its own child agents (enables nesting)",
		"  - retrieve: Collect results from its children (required if summon is given)",
		"  - web_search: Search the web",
		"  - youtube_transcribe: Fetch YouTube video transcripts",
		"",
		"The 'agent' parameter is required — every spawned agent must use a definition.",
		"Tools default to the agent definition's tools, intersected with your own tools (you can't grant capabilities you don't have).",
		catalog,
	].join("\n");

	const parametersShape = {
		task: z
			.string()
			.describe(
				"Detailed instructions for the child agent. Be specific about what it should do and what it should return.",
			),
		agent: z
			.string()
			.describe(
				[
					"Slug of an agent definition to use as the basis for the child agent.",
					"Required. The child inherits the definition's tools, models, and",
					"working directory; the 'tools' parameter only narrows them further.",
					"Inspect the agent directories listed above to discover which slugs",
					"are available and what each one does.",
					allSlugs.length > 0 ? `Available slugs: ${allSlugs.join(", ")}.` : "",
				]
					.filter(Boolean)
					.join(" "),
			),
		...(userAgentEnabled
			? {
					top_level: z
						.boolean()
						.optional()
						.describe(
							[
								"If true, spawn the agent as an independent top-level user agent tab",
								"instead of a child subagent. User agents have no parent, persist on",
								"their own, and are fire-and-forget (cannot be retrieved). Requires an",
								"'agent' definition listed under 'User agents'. The 'background' option",
								"is ignored when top_level is true.",
							].join(" "),
						),
				}
			: {}),
		tools: z
			.array(
				z.enum([
					"read_file",
					"read_file_slice",
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
				"Tool names to give the child. Defaults to the agent definition's tools. Intersected with the spawning agent's tools (you can't grant capabilities you don't have).",
			),
		working_directory: z
			.string()
			.optional()
			.describe(
				"Absolute path for the child to work in. Defaults to the agent definition's cwd (or the spawning agent's directory).",
			),
		background: z
			.boolean()
			.optional()
			.describe(
				"If true, returns immediately with an agent_id for later retrieval. If false (default), blocks until the child agent finishes and returns the result directly. Ignored when top_level is true.",
			),
	};

	return {
		name: "summon",
		description,
		parameters: z.object(parametersShape),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const task = args.task as string;
			const agentSlug = args.agent as string | undefined;
			const tools = args.tools as string[] | undefined;
			const workingDirectory = args.working_directory as string | undefined;
			const background = (args.background as boolean | undefined) ?? false;
			const topLevel = userAgentEnabled ? ((args.top_level as boolean | undefined) ?? false) : false;

			try {
				const agentId = await callbacks.spawn({
					task,
					tools: tools ?? [],
					...(workingDirectory ? { workingDirectory } : {}),
					...(agentSlug ? { agentSlug } : {}),
					...(topLevel ? { topLevel: true } : {}),
				});

				if (topLevel) {
					// User agents are always fire-and-forget — never block on a
					// result and make it explicit that retrieve won't work.
					return [
						`User agent spawned successfully.`,
						`agent_id: ${agentId}`,
						``,
						`The user agent is now working independently in its own top-level tab.`,
						`It is fire-and-forget — you cannot retrieve its result.`,
					].join("\n");
				}

				if (!background) {
					// Block until the child agent completes. Always prefix the
					// result with `agent_id: <uuid>` so the frontend's
					// ToolCallDisplay regex (`agent_id:\s*([a-f0-9-]+)`) can
					// surface the "Open Tab" button for foreground summons too —
					// not just background ones. The child's tab still exists and
					// holds the full conversation, so the user should always be
					// able to open it.
					const result = await callbacks.getResult(agentId);
					if (result.status === "done") {
						return `agent_id: ${agentId}\n\n${result.result}`;
					}
					return `agent_id: ${agentId}\n\nError from child agent: ${result.error}`;
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
 * Build the `AvailableAgent[]` projection of an `AgentDefinition` list,
 * deriving each entry's readable `path` from its scope+slug.
 */
function toAvailableAgents(
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

/**
 * Subagent definitions (`is_subagent === true`) — spawned as child tabs.
 */
export function toAvailableSubagents(
	defs: AgentDefinition[],
	globalDir: string,
	projectDir: string | null,
): AvailableAgent[] {
	return toAvailableAgents(
		defs.filter((d) => d.is_subagent),
		globalDir,
		projectDir,
	);
}

/**
 * User-agent definitions (`is_subagent !== true`) — spawnable as
 * independent top-level tabs when `perm_user_agent` is granted.
 */
export function toAvailableUserAgents(
	defs: AgentDefinition[],
	globalDir: string,
	projectDir: string | null,
): AvailableAgent[] {
	return toAvailableAgents(
		defs.filter((d) => d.is_subagent !== true),
		globalDir,
		projectDir,
	);
}
