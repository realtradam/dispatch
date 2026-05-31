import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import type { AgentDefinition, AgentModelEntry } from "../types/index.js";

// ─── Helpers ─────────────────────────────────────────────────────

/** Sanitize a slug to prevent path traversal */
function sanitizeSlug(slug: string): string {
	// Strip directory components and ensure only safe characters
	const base = path.basename(slug);
	const clean = base
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!clean) throw new Error("Invalid agent slug");
	return clean;
}

// ─── Constants ───────────────────────────────────────────────────

export const GLOBAL_AGENTS_DIR = path.join(os.homedir(), ".config", "dispatch", "agents");

export function getProjectAgentsDir(projectDir: string): string {
	return path.join(projectDir, ".dispatch", "agents");
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Returns the agent directories that exist or could exist.
 * Always includes global. Includes project dir if projectDir is provided.
 */
export function getAgentDirs(
	projectDir?: string,
): Array<{ label: string; path: string; scope: string }> {
	const dirs: Array<{ label: string; path: string; scope: string }> = [
		{ label: "Global (~/.config/dispatch/agents)", path: GLOBAL_AGENTS_DIR, scope: "global" },
	];
	if (projectDir) {
		dirs.push({
			label: `.dispatch/agents (${path.basename(projectDir)})`,
			path: getProjectAgentsDir(projectDir),
			scope: projectDir,
		});
	}
	return dirs;
}

/**
 * Return just the absolute filesystem paths of the agent directories.
 * Used by the agent's permission gate to grant read-only access to
 * these locations by default (so any agent can list/read agent
 * definitions without prompting the user).
 */
export function getAgentDirPaths(projectDir?: string): string[] {
	const paths = [GLOBAL_AGENTS_DIR];
	if (projectDir) paths.push(getProjectAgentsDir(projectDir));
	return paths;
}

/**
 * Load a single agent definition by slug. Searches the project-scoped
 * directory first (if `projectDir` is provided), then falls back to
 * the global directory. Returns `null` if no match is found.
 *
 * Slug matching is exact and case-sensitive; sanitization mirrors
 * `saveAgent` to keep loader and writer symmetric.
 */
export function loadAgent(slug: string, projectDir?: string): AgentDefinition | null {
	const safeSlug = sanitizeSlug(slug);
	const agents = loadAgents(projectDir);
	return agents.find((a) => a.slug === safeSlug) ?? null;
}

/**
 * Translate the short permission-group names used by `AgentDefinition.tools`
 * (e.g. `"read"`, `"edit"`, `"bash"`) into the concrete tool-implementation
 * names registered with the agent runtime (e.g. `"read_file"`,
 * `"list_files"`, `"write_file"`, `"run_shell"`).
 *
 * The mapping mirrors the per-permission tool-creation paths in
 * `AgentManager.getOrCreateAgentForTab` so a subagent summoned with a
 * given agent definition ends up with the exact same set of registered
 * tools as a top-level tab using that definition. Tool names that aren't
 * group aliases (`summon`, `retrieve`, `web_search`, `youtube_transcribe`,
 * `todo`) are passed through unchanged.
 *
 * `"todo"` is auto-included so the summoned agent always has its task list
 * available, matching the parent-agent path which always registers `todo`.
 */
export function expandAgentToolNames(tools: string[]): string[] {
	const expanded = new Set<string>();
	for (const t of tools) {
		switch (t) {
			case "read":
				expanded.add("read_file");
				expanded.add("read_file_slice");
				expanded.add("list_files");
				break;
			case "edit":
				expanded.add("write_file");
				break;
			case "bash":
				expanded.add("run_shell");
				break;
			default:
				// Pass through tool names that aren't permission-group
				// aliases (summon, retrieve, web_search, youtube_transcribe,
				// send_to_tab, read_tab, todo, and the granular file tools
				// themselves if a user hand-wrote them in a TOML).
				expanded.add(t);
		}
	}
	// Always include `todo` — every agent should be able to track its work,
	// and the parent-agent path adds it unconditionally.
	expanded.add("todo");
	return Array.from(expanded);
}

/**
 * Ensure the default global agent exists. Creates it if missing.
 */
function ensureDefaultAgent(): void {
	const filePath = path.join(GLOBAL_AGENTS_DIR, "default.toml");
	if (fs.existsSync(filePath)) return;

	const defaultAgent: AgentDefinition = {
		name: "Default",
		description: "Default agent with all tools enabled",
		skills: [],
		tools: ["read", "edit", "bash", "summon"],
		models: [],
		scope: "global",
		slug: "default",
	};
	saveAgent(defaultAgent);
}

/**
 * Load all agent definitions from global + project directories.
 * Auto-generates the default global agent if it doesn't exist.
 */
export function loadAgents(projectDir?: string): AgentDefinition[] {
	ensureDefaultAgent();

	const agents: AgentDefinition[] = [];

	// Global agents
	agents.push(...loadAgentsFromDir(GLOBAL_AGENTS_DIR, "global"));

	// Project-scoped agents
	if (projectDir) {
		agents.push(...loadAgentsFromDir(getProjectAgentsDir(projectDir), projectDir));
	}

	return agents;
}

/**
 * Save (create or update) an agent definition to a TOML file.
 * The scope determines which directory:
 *   - "global" -> ~/.config/dispatch/agents/
 *   - any other string -> that directory path + /.dispatch/agents/
 */
export function saveAgent(agent: AgentDefinition): void {
	if (agent.scope !== "global" && agent.scope.includes("..")) {
		throw new Error("Invalid agent scope");
	}
	const dir = agent.scope === "global" ? GLOBAL_AGENTS_DIR : getProjectAgentsDir(agent.scope);

	fs.mkdirSync(dir, { recursive: true });

	const tomlContent: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
		skills: agent.skills,
		tools: agent.tools,
	};

	if (agent.cwd) {
		tomlContent.cwd = agent.cwd;
	}

	if (agent.is_subagent) {
		tomlContent.is_subagent = true;
	}

	// smol-toml handles [[models]] array-of-tables
	if (agent.models.length > 0) {
		tomlContent.models = agent.models.map((m) => ({
			key_id: m.key_id,
			model_id: m.model_id,
		}));
	}

	const content = stringifyTOML(tomlContent);
	const safeSlug = sanitizeSlug(agent.slug);
	const filePath = path.join(dir, `${safeSlug}.toml`);
	fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Delete an agent TOML file.
 */
export function deleteAgent(slug: string, scope: string): boolean {
	if (scope !== "global" && scope.includes("..")) {
		throw new Error("Invalid agent scope");
	}
	const dir = scope === "global" ? GLOBAL_AGENTS_DIR : getProjectAgentsDir(scope);

	const safeSlug = sanitizeSlug(slug);
	const filePath = path.join(dir, `${safeSlug}.toml`);
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
		return true;
	}
	return false;
}

// ─── Internal ────────────────────────────────────────────────────

function loadAgentsFromDir(dir: string, scope: string): AgentDefinition[] {
	if (!fs.existsSync(dir)) return [];

	const results: AgentDefinition[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;

		const filePath = path.join(dir, entry.name);
		const slug = entry.name.slice(0, -5); // remove .toml

		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const parsed = parseTOML(raw);

			const models: AgentModelEntry[] = [];
			if (Array.isArray(parsed.models)) {
				for (const m of parsed.models) {
					if (m && typeof m === "object" && "key_id" in m && "model_id" in m) {
						models.push({
							key_id: String((m as Record<string, unknown>).key_id),
							model_id: String((m as Record<string, unknown>).model_id),
						});
					}
				}
			}

			const skills: string[] = [];
			if (Array.isArray(parsed.skills)) {
				for (const s of parsed.skills) {
					if (typeof s === "string") skills.push(s);
				}
			}

			const tools: string[] = [];
			if (Array.isArray(parsed.tools)) {
				for (const t of parsed.tools) {
					if (typeof t === "string") tools.push(t);
				}
			}

			results.push({
				name: typeof parsed.name === "string" ? parsed.name : slug,
				description: typeof parsed.description === "string" ? parsed.description : "",
				skills,
				tools,
				models,
				scope,
				slug,
				...(typeof parsed.cwd === "string" && parsed.cwd ? { cwd: parsed.cwd } : {}),
				...(parsed.is_subagent === true ? { is_subagent: true } : {}),
			});
		} catch {
			// Skip unparseable files
		}
	}

	return results;
}
