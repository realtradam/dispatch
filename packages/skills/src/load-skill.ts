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
 * Scan a .skills directory and return discovered skill entries.
 * Returns an empty array on any error (fail-open).
 */
export async function scanSkillsDir(dir: string): Promise<readonly SkillEntry[]> {
	try {
		const entries = await readdir(dir, { encoding: "utf8", withFileTypes: true });
		const skills: SkillEntry[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) {
				continue;
			}
			const name = entry.name.slice(0, -3);
			try {
				const content = await readFile(join(dir, entry.name), "utf8");
				const meta = parseSkillMeta(content);
				skills.push({ name, summary: meta.hasMeta ? meta.summary : undefined });
			} catch {
				skills.push({ name });
			}
		}
		return skills;
	} catch {
		return [];
	}
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

			const cwdPath = join(cwdSkillsDir, `${rawName}.md`);
			const homePath = join(homeSkillsDir, `${rawName}.md`);

			const resolvedCwdPath = resolve(cwdPath);
			const resolvedHomePath = resolve(homePath);

			if (!isPathWithinDir(resolvedCwdPath, cwdSkillsDir)) {
				return { content: "Error: Invalid skill path.", isError: true };
			}
			if (!isPathWithinDir(resolvedHomePath, homeSkillsDir)) {
				return { content: "Error: Invalid skill path.", isError: true };
			}

			let content: string | null = null;

			try {
				content = await readFile(resolvedCwdPath, "utf8");
			} catch {
				// Cwd miss — try home
			}

			if (content === null) {
				try {
					content = await readFile(resolvedHomePath, "utf8");
				} catch {
					// Both miss
				}
			}

			if (content === null) {
				return { content: `Error: unknown skill: ${rawName}`, isError: true };
			}

			const meta = parseSkillMeta(content);
			const body = stripLoadedBody(content, meta.hasMeta);

			return { content: body };
		},
	};
}
