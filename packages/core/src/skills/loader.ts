import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import chokidar from "chokidar";
import type { AgentSkillMapping, SkillDefinition, SkillScope } from "../types/index.js";
import { parseSkillFile } from "./parser.js";

// ─── Internal Helpers ────────────────────────────────────────────

/**
 * Recursively scan a directory for .md skill files.
 * The `directory` field on each skill is the relative path from `baseDir` to the file's parent.
 * Skips the `agents/` subdirectory (handled separately).
 */
function scanSkillsRecursive(baseDir: string, scope: SkillScope): SkillDefinition[] {
	if (!fs.existsSync(baseDir)) return [];

	const results: SkillDefinition[] = [];

	function walk(dir: string) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				// Skip agents/ at the top level (handled by loadAgentMappings)
				const relFromBase = path.relative(baseDir, fullPath);
				if (relFromBase === "agents") continue;
				walk(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const relDir = path.relative(baseDir, dir);
				// relDir is "" for root, "general" for general/, "general/webapps" for nested
				const directory = relDir === "." ? "" : relDir;
				try {
					const content = fs.readFileSync(fullPath, "utf-8");
					const skill = parseSkillFile(fullPath, content, scope, directory);
					results.push(skill);
				} catch {
					// Skip unreadable files
				}
			}
		}
	}

	walk(baseDir);
	return results;
}

function loadAgentMappings(agentsDir: string, scope: SkillScope): AgentSkillMapping[] {
	if (!fs.existsSync(agentsDir)) {
		return [];
	}

	const results: AgentSkillMapping[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".txt")) {
			continue;
		}

		const fileName = entry.name;
		let isOrchestrator = false;
		let agentType: string;

		if (fileName.endsWith(".o.txt")) {
			isOrchestrator = true;
			agentType = fileName.slice(0, -6); // remove ".o.txt"
		} else {
			agentType = fileName.slice(0, -4); // remove ".txt"
		}

		const filePath = path.join(agentsDir, fileName);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const skills = content
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("#"));

			results.push({ agentType, isOrchestrator, skills, scope });
		} catch {
			// Skip unreadable mapping files
		}
	}

	return results;
}

// ─── Public API ──────────────────────────────────────────────────

export function loadSkills(projectDir: string): {
	skills: SkillDefinition[];
	mappings: AgentSkillMapping[];
} {
	const globalBase = path.join(os.homedir(), ".skills");
	const projectBase = path.join(projectDir, ".skills");

	const skills: SkillDefinition[] = [];
	const mappings: AgentSkillMapping[] = [];

	// 1. Scan all global skills recursively (skipping agents/)
	skills.push(...scanSkillsRecursive(globalBase, "global"));

	// 2. Scan all project skills recursively (skipping agents/)
	skills.push(...scanSkillsRecursive(projectBase, "project"));

	// 3. Agent mappings — global then project
	mappings.push(...loadAgentMappings(path.join(globalBase, "agents"), "global"));
	mappings.push(...loadAgentMappings(path.join(projectBase, "agents"), "project"));

	return { skills, mappings };
}

export function resolveSkillsForAgent(
	agentType: string,
	isOrchestrator: boolean,
	skills: SkillDefinition[],
	mappings: AgentSkillMapping[],
): SkillDefinition[] {
	// Helper: project overrides global for same-named skills
	const dedupeByName = (list: SkillDefinition[]): SkillDefinition[] => {
		const seen = new Map<string, SkillDefinition>();
		for (const skill of list) {
			const existing = seen.get(skill.name);
			if (!existing || skill.scope === "project") {
				seen.set(skill.name, skill);
			}
		}
		return Array.from(seen.values());
	};

	// All default-directory skills (global first, then project — dedupe preserves project)
	const defaultSkills = skills.filter((s) => s.directory === "default");

	// Skills mapped to this agent type
	const relevantMappings = mappings.filter(
		(m) => m.agentType === agentType && m.isOrchestrator === isOrchestrator,
	);

	// Gather agent-specific skills in order: global mappings first, then project
	const globalMappings = relevantMappings.filter((m) => m.scope === "global");
	const projectMappings = relevantMappings.filter((m) => m.scope === "project");

	const agentSkillNames: string[] = [];
	for (const mapping of [...globalMappings, ...projectMappings]) {
		for (const skillFile of mapping.skills) {
			const skillName = path.basename(skillFile, path.extname(skillFile));
			agentSkillNames.push(skillName);
		}
	}

	const agentSpecificSkills = agentSkillNames
		.map((name) => getSkillByName(name, skills, "project"))
		.filter((s): s is SkillDefinition => s !== undefined);

	const combined = [...defaultSkills, ...agentSpecificSkills];
	return dedupeByName(combined);
}

export function getSkillByName(
	name: string,
	skills: SkillDefinition[],
	preferScope?: SkillScope,
): SkillDefinition | undefined {
	const matches = skills.filter((s) => s.name === name);
	if (matches.length === 0) {
		return undefined;
	}

	if (preferScope) {
		const preferred = matches.find((s) => s.scope === preferScope);
		if (preferred) {
			return preferred;
		}
	}

	// Default: project takes precedence
	const projectMatch = matches.find((s) => s.scope === "project");
	return projectMatch ?? matches[0];
}

export function createSkillsWatcher(
	projectDir: string,
	onChange: (result: { skills: SkillDefinition[]; mappings: AgentSkillMapping[] }) => void,
): { close(): void } {
	const globalBase = path.join(os.homedir(), ".skills");
	const projectBase = path.join(projectDir, ".skills");

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const reload = () => {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			const result = loadSkills(projectDir);
			onChange(result);
		}, 300);
	};

	const watchPaths = [globalBase, projectBase];

	const watcher = chokidar.watch(watchPaths, {
		ignoreInitial: true,
		persistent: true,
	});

	watcher.on("add", (filePath: string) => {
		if (filePath.endsWith(".md") || filePath.endsWith(".txt")) {
			reload();
		}
	});

	watcher.on("change", (filePath: string) => {
		if (filePath.endsWith(".md") || filePath.endsWith(".txt")) {
			reload();
		}
	});

	watcher.on("unlink", (filePath: string) => {
		if (filePath.endsWith(".md") || filePath.endsWith(".txt")) {
			reload();
		}
	});

	return {
		close() {
			if (debounceTimer !== null) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			watcher.close();
		},
	};
}
