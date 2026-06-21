import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import {
	isPathWithinDir,
	isValidSkillName,
	parseSkillMeta,
	type SkillEntry,
	stripLoadedBody,
} from "./pure.js";

export interface SkillsDeps {
	readonly homeDir: string;
	readonly workdir: string;
}

/**
 * Scan a .skills directory (recursively) and return discovered skill entries.
 * Subdirectories are traversed; `.md` files at any depth are included.
 * If two files share the same name, the first one found wins (top-level
 * before subdirs, alphabetical within a level).
 * Returns an empty array on any error (fail-open).
 */
export async function scanSkillsDir(dir: string): Promise<readonly SkillEntry[]> {
	async function scan(d: string): Promise<SkillEntry[]> {
		try {
			const entries = await readdir(d, { encoding: "utf8", withFileTypes: true });
			const skills: SkillEntry[] = [];
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const subSkills = await scan(join(d, entry.name));
					for (const sub of subSkills) {
						if (!skills.some((s) => s.name === sub.name)) {
							skills.push(sub);
						}
					}
				} else if (entry.isFile() && entry.name.endsWith(".md")) {
					const name = entry.name.slice(0, -3);
					if (skills.some((s) => s.name === name)) continue;
					try {
						const content = await readFile(join(d, entry.name), "utf8");
						const meta = parseSkillMeta(content);
						skills.push({ name, summary: meta.hasMeta ? meta.summary : undefined });
					} catch {
						skills.push({ name });
					}
				}
			}
			return skills;
		} catch {
			return [];
		}
	}
	return scan(dir);
}

/**
 * Recursively search a directory for a skill file by name.
 * Returns the full path of the first `{name}.md` found, or null if not found.
 * Top-level files are found before nested ones (readdir order within each level).
 */
async function findSkillFile(dir: string, name: string): Promise<string | null> {
	async function search(d: string): Promise<string | null> {
		try {
			const entries = await readdir(d, { encoding: "utf8", withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && entry.name === `${name}.md`) {
					return join(d, entry.name);
				}
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const found = await search(join(d, entry.name));
					if (found !== null) return found;
				}
			}
			return null;
		} catch {
			return null;
		}
	}
	return search(dir);
}

/**
 * Create the load_skill ToolContract.
 * The tool reads a skill file from disk on execute (uncached).
 */
export function createLoadSkillTool(deps: SkillsDeps): ToolContract {
	const { homeDir, workdir } = deps;

	return {
		name: "load_skill",
		description: "Load a skill by name. No skills are currently available.",
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "The name of the skill to load.",
				},
			},
			required: ["name"],
		},
		concurrencySafe: true,
		async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
			const obj = args as Record<string, unknown>;
			const rawName = obj?.name;

			if (typeof rawName !== "string") {
				return { content: 'Error: Missing or invalid "name" parameter.', isError: true };
			}

			if (!isValidSkillName(rawName)) {
				return {
					content: `Error: Invalid skill name "${rawName}". Name must not contain path separators or "..".`,
					isError: true,
				};
			}

			const effectiveBase = ctx.cwd ? resolve(ctx.cwd) : resolve(workdir);
			const cwdSkillsDir = join(effectiveBase, ".skills");
			const homeSkillsDir = join(resolve(homeDir), ".skills");

			let filePath: string | null = null;

			try {
				filePath = await findSkillFile(cwdSkillsDir, rawName);
			} catch {
				// Cwd miss — try home
			}

			if (filePath === null) {
				try {
					filePath = await findSkillFile(homeSkillsDir, rawName);
				} catch {
					// Both miss
				}
			}

			if (filePath === null) {
				return { content: `Error: unknown skill: ${rawName}`, isError: true };
			}

			const resolvedPath = resolve(filePath);
			if (
				!isPathWithinDir(resolvedPath, cwdSkillsDir) &&
				!isPathWithinDir(resolvedPath, homeSkillsDir)
			) {
				return { content: "Error: Invalid skill path.", isError: true };
			}

			let content: string;

			try {
				content = await readFile(resolvedPath, "utf8");
			} catch {
				return { content: `Error: unknown skill: ${rawName}`, isError: true };
			}

			const meta = parseSkillMeta(content);
			const body = stripLoadedBody(content, meta.hasMeta);

			return { content: body };
		},
	};
}
