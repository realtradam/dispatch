import { access, lstat, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ToolContract, ToolResult } from "@dispatch/kernel";

interface ValidatedArgs {
	readonly path: string;
	readonly content: string;
	readonly overwrite: boolean;
}

export type OverwriteDecision = "create" | "overwrite" | { readonly error: string };

/** Pure: decide the action based on file existence and the overwrite flag. */
export function decideOverwrite(fileExists: boolean, overwrite: boolean): OverwriteDecision {
	if (!fileExists && !overwrite) return "create";
	if (fileExists && !overwrite) {
		return { error: "Error: File already exists; set overwrite: true to replace it." };
	}
	if (fileExists && overwrite) return "overwrite";
	return { error: "Error: overwrite: true but the file does not exist." };
}

/** Pure: check that a resolved absolute path is within the workdir (prefix check). */
export function isPathWithinWorkdir(resolvedPath: string, workdir: string): boolean {
	const normalizedWorkdir = workdir.endsWith(sep) ? workdir : workdir + sep;
	return resolvedPath === workdir || resolvedPath.startsWith(normalizedWorkdir);
}

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

	const rawContent = obj.content;
	if (typeof rawContent !== "string") {
		return {
			error: 'Error: Missing or invalid "content" parameter (must be a string).',
		};
	}

	let overwrite = false;
	if (obj.overwrite !== undefined) {
		if (typeof obj.overwrite !== "boolean") {
			return { error: 'Error: Invalid "overwrite" parameter (must be a boolean).' };
		}
		overwrite = obj.overwrite;
	}

	return { path: rawPath, content: rawContent, overwrite };
}

/**
 * Factory: create a write_file ToolContract bound to a working directory.
 * The working directory is injected so the tool is testable.
 */
export function createWriteFileTool(workingDirectory: string): ToolContract {
	const workdir = resolve(workingDirectory);

	return {
		name: "write_file",
		description:
			"Write a whole file to disk. " +
			"By default, creates a new file; errors if it already exists. " +
			"Set overwrite: true to replace an existing file (errors if the file does not exist). " +
			"Parent directories are NOT auto-created — the parent must already exist.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file, relative to the working directory.",
				},
				content: {
					type: "string",
					description: "The full content to write to the file.",
				},
				overwrite: {
					type: "boolean",
					description:
						"When false/unset: creates a new file (errors if it already exists). " +
						"When true: replaces an existing file (errors if it does not exist).",
					default: false,
				},
			},
			required: ["path", "content"],
		},
		concurrencySafe: false,
		async execute(args: unknown, ctx): Promise<ToolResult> {
			const validated = validateArgs(args);
			if ("error" in validated) {
				return { content: validated.error, isError: true };
			}

			const { path: relPath, content, overwrite } = validated;

			const effectiveBase = ctx.cwd ? resolve(ctx.cwd) : workdir;
			const resolvedPath = resolve(effectiveBase, relPath);

			if (!isPathWithinWorkdir(resolvedPath, effectiveBase)) {
				return {
					content: `Error: Path "${relPath}" is outside the working directory.`,
					isError: true,
				};
			}

			// Symlink hardening: realpath the parent directory and the base, then re-check.
			let realParent: string;
			let realBase: string;
			try {
				const parentDir = dirname(resolvedPath);
				[realParent, realBase] = await Promise.all([realpath(parentDir), realpath(effectiveBase)]);
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return {
						content: `Error: Parent directory for "${relPath}" does not exist.`,
						isError: true,
					};
				}
				return {
					content: `Error resolving path: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			const realResolvedPath = realParent + sep + resolvedPath.split(sep).at(-1);
			if (!isPathWithinWorkdir(realResolvedPath, realBase)) {
				return {
					content: `Error: Path "${relPath}" is outside the working directory.`,
					isError: true,
				};
			}

			// If the resolved path itself is a symlink, verify the target is contained.
			try {
				const linkStat = await lstat(resolvedPath);
				if (linkStat.isSymbolicLink()) {
					const linkTarget = await readlink(resolvedPath);
					const resolvedTarget = resolve(dirname(resolvedPath), linkTarget);
					if (!isPathWithinWorkdir(resolvedTarget, realBase)) {
						return {
							content: `Error: Path "${relPath}" is outside the working directory.`,
							isError: true,
						};
					}
				}
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					return {
						content: `Error checking path: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					};
				}
			}

			// Check existence.
			let fileExists = false;
			try {
				await access(resolvedPath);
				fileExists = true;
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					return {
						content: `Error checking file: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					};
				}
			}

			// Pure decision.
			const decision = decideOverwrite(fileExists, overwrite);
			if (typeof decision === "object") {
				return { content: decision.error, isError: true };
			}

			// Verify it's not a directory.
			if (fileExists) {
				const pathStat = await stat(resolvedPath);
				if (pathStat.isDirectory()) {
					return {
						content: `Error: "${relPath}" is a directory, not a file.`,
						isError: true,
					};
				}
			}

			// Write the file.
			try {
				await writeFile(resolvedPath, content, "utf8");
			} catch (err: unknown) {
				return {
					content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			const action = decision === "create" ? "Created" : "Overwrote";
			return { content: `${action} "${relPath}" (${content.length} bytes).` };
		},
	};
}
