import { resolve } from "node:path";
import type { ExecBackend, ExecBackendResolver } from "@dispatch/exec-backend";
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
 * Factory: create a write_file ToolContract.
 *
 * `resolveBackend` is the injected seam: each `execute` resolves an
 * `ExecBackend` from `ctx.computerId` (undefined → local `node:fs`; a set
 * id → a remote SSH backend in a later wave). The tool programs against the
 * `ExecBackend` surface, never `node:fs` directly, so it is transport-agnostic.
 *
 * `workdir` is the fallback base directory when `ctx.cwd` is omitted. It is
 * injected so the tool is testable; `execute` prefers `ctx.cwd` when present.
 */
export function createWriteFileTool(deps: {
	readonly resolveBackend: ExecBackendResolver;
	readonly workdir?: string;
}): ToolContract {
	const workdir = deps.workdir !== undefined ? resolve(deps.workdir) : undefined;

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
			if (effectiveBase === undefined) {
				return {
					content:
						"Error: No working directory (neither ctx.cwd nor a baked workdir was provided).",
					isError: true,
				};
			}
			const resolvedPath = resolve(effectiveBase, relPath);

			const backend: ExecBackend = deps.resolveBackend(ctx.computerId);

			// Check existence. `backend.exists` never throws — it returns false
			// when the path is missing — so the old try/catch around `access`
			// collapses to a single boolean read.
			const fileExists = await backend.exists(resolvedPath);

			// Pure decision.
			const decision = decideOverwrite(fileExists, overwrite);
			if (typeof decision === "object") {
				return { content: decision.error, isError: true };
			}

			// Verify it's not a directory. `backend.stat` returns a
			// `{ isFile, isDirectory }` result; only reached when the file
			// exists, so an ENOENT here is a lost race left to propagate
			// (same as the prior uncaught `stat` call).
			if (fileExists) {
				const pathStat = await backend.stat(resolvedPath);
				if (pathStat.isDirectory) {
					return {
						content: `Error: "${relPath}" is a directory, not a file.`,
						isError: true,
					};
				}
			}

			// Write the file. LocalExecBackend throws node:fs-style errors
			// carrying a `.code` (e.g. ENOENT when the parent dir is missing);
			// the catch surfaces the message verbatim.
			try {
				await backend.writeFile(resolvedPath, content);
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
