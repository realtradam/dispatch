import { access, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
