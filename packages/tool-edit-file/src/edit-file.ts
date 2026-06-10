import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ToolContract, ToolResult } from "@dispatch/kernel";

// --- Pure types ---

interface ValidatedArgs {
	readonly path: string;
	readonly oldString: string;
	readonly newString: string;
	readonly replaceAll: boolean;
}

export type ReplacementError =
	| { readonly kind: "identical" }
	| { readonly kind: "notFound" }
	| { readonly kind: "notUnique"; readonly count: number };

export interface ReplacementSuccess {
	readonly content: string;
	readonly count: number;
}

// --- Pure functions ---

/** Pure: validate and coerce args from the model. */
export function validateArgs(args: unknown): ValidatedArgs | { readonly error: string } {
	if (args === null || args === undefined || typeof args !== "object") {
		return { error: "Error: Arguments must be an object." };
	}
	const obj = args as Record<string, unknown>;

	const rawPath = obj.path;
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return { error: 'Error: Missing or invalid "path" parameter (must be a non-empty string).' };
	}

	const rawOld = obj.oldString;
	if (typeof rawOld !== "string" || rawOld.length === 0) {
		return {
			error: 'Error: Missing or invalid "oldString" parameter (must be a non-empty string).',
		};
	}

	const rawNew = obj.newString;
	if (typeof rawNew !== "string") {
		return {
			error: 'Error: Missing or invalid "newString" parameter (must be a string).',
		};
	}

	const rawReplaceAll = obj.replaceAll;
	const replaceAll = rawReplaceAll === true;

	return { path: rawPath, oldString: rawOld, newString: rawNew, replaceAll };
}

/** Pure: compute the replacement result given file content + params. */
export function computeReplacement(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): ReplacementSuccess | ReplacementError {
	if (oldString === newString) {
		return { kind: "identical" };
	}

	if (oldString === "") {
		return { kind: "notFound" };
	}

	if (!content.includes(oldString)) {
		return { kind: "notFound" };
	}

	if (replaceAll) {
		const parts = content.split(oldString);
		const count = parts.length - 1;
		return { content: parts.join(newString), count };
	}

	// Single replacement — check uniqueness.
	const firstIndex = content.indexOf(oldString);
	const secondIndex = content.indexOf(oldString, firstIndex + oldString.length);
	if (secondIndex !== -1) {
		// Count total occurrences.
		let count = 0;
		let idx = 0;
		while (true) {
			idx = content.indexOf(oldString, idx);
			if (idx === -1) break;
			count++;
			idx += oldString.length;
		}
		return { kind: "notUnique", count };
	}

	return {
		content:
			content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length),
		count: 1,
	};
}

/** Pure: check that a resolved absolute path is within the workdir (prefix check). */
export function isPathWithinWorkdir(resolvedPath: string, workdir: string): boolean {
	const normalizedWorkdir = workdir.endsWith(sep) ? workdir : workdir + sep;
	return resolvedPath === workdir || resolvedPath.startsWith(normalizedWorkdir);
}

// --- Shell / edge ---

/**
 * Factory: create an edit_file ToolContract bound to a working directory.
 * The working directory is injected so the tool is testable.
 */
export function createEditFileTool(workingDirectory: string): ToolContract {
	const workdir = resolve(workingDirectory);

	return {
		name: "edit_file",
		description:
			"Perform an exact string replacement in an existing file. " +
			"Provide oldString (the text to find) and newString (the replacement). " +
			"By default replaces a single occurrence; set replaceAll to replace every match.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file, relative to the working directory.",
				},
				oldString: {
					type: "string",
					description: "The exact string to find and replace.",
				},
				newString: {
					type: "string",
					description: "The string to replace oldString with.",
				},
				replaceAll: {
					type: "boolean",
					description: "Replace all occurrences (default: false).",
					default: false,
				},
			},
			required: ["path", "oldString", "newString"],
		},
		concurrencySafe: false,
		async execute(args: unknown, ctx): Promise<ToolResult> {
			const validated = validateArgs(args);
			if ("error" in validated) {
				return { content: validated.error, isError: true };
			}

			const { path: relPath, oldString, newString, replaceAll } = validated;

			// Effective base: per-turn ctx.cwd overrides the baked workdir.
			const effectiveBase = ctx.cwd ? resolve(ctx.cwd) : workdir;

			// Resolve the requested path against the effective base.
			const resolvedPath = resolve(effectiveBase, relPath);

			// Basic prefix check.
			if (!isPathWithinWorkdir(resolvedPath, effectiveBase)) {
				return {
					content: `Error: Path "${relPath}" is outside the working directory.`,
					isError: true,
				};
			}

			// Symlink hardening: realpath both and re-check containment.
			let realResolved: string;
			let realBase: string;
			try {
				[realResolved, realBase] = await Promise.all([
					realpath(resolvedPath),
					realpath(effectiveBase),
				]);
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return { content: `Error: File "${relPath}" not found.`, isError: true };
				}
				return {
					content: `Error accessing file: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			if (!isPathWithinWorkdir(realResolved, realBase)) {
				return {
					content: `Error: Path "${relPath}" is outside the working directory.`,
					isError: true,
				};
			}

			// Read the file.
			let content: string;
			try {
				content = await readFile(resolvedPath, "utf8");
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return { content: `Error: File "${relPath}" not found.`, isError: true };
				}
				return {
					content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			// Pure replacement decision.
			const result = computeReplacement(content, oldString, newString, replaceAll);

			if ("kind" in result) {
				switch (result.kind) {
					case "identical":
						return {
							content: "Error: newString must differ from oldString.",
							isError: true,
						};
					case "notFound":
						return {
							content: `Error: oldString not found in content of "${relPath}".`,
							isError: true,
						};
					case "notUnique":
						return {
							content: `Error: Found ${result.count} matches for oldString in "${relPath}"; provide more surrounding context to make it unique, or set replaceAll.`,
							isError: true,
						};
				}
			}

			// Write the modified content back.
			try {
				await writeFile(resolvedPath, result.content, "utf8");
			} catch (err: unknown) {
				return {
					content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			const plural = result.count === 1 ? "" : "s";
			return { content: `Replaced ${result.count} occurrence${plural} in "${relPath}".` };
		},
	};
}
