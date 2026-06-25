import { resolve } from "node:path";
import type { ExecBackend, ExecBackendResolver, StatResult } from "@dispatch/exec-backend";
import type { ToolContract, ToolResult } from "@dispatch/kernel";

const DEFAULT_LIMIT = 500;
const HARD_CAP = 5000;

interface ValidatedArgs {
	readonly path: string;
	readonly offset: number;
	readonly limit: number;
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

	let offset = 1;
	if (obj.offset !== undefined) {
		const n = Number(obj.offset);
		if (!Number.isFinite(n) || n < 1) {
			return { error: 'Error: Invalid "offset" parameter (must be a positive integer).' };
		}
		offset = Math.floor(n);
	}

	let limit = DEFAULT_LIMIT;
	if (obj.limit !== undefined) {
		const n = Number(obj.limit);
		if (!Number.isFinite(n) || n < 1) {
			return { error: 'Error: Invalid "limit" parameter (must be a positive integer).' };
		}
		limit = Math.min(Math.floor(n), HARD_CAP);
	} else {
		limit = Math.min(limit, HARD_CAP);
	}

	return { path: rawPath, offset, limit };
}

/** Pure: slice lines from content (1-indexed offset). */
export function sliceLines(
	content: string,
	offset: number,
	limit: number,
): { readonly lines: readonly string[]; readonly totalLines: number } {
	const allLines = content.split("\n");
	const totalLines = allLines.length;
	const start = offset - 1; // convert to 0-indexed
	const sliced = allLines.slice(start, start + limit);
	return { lines: sliced, totalLines };
}

/** Pure: render lines into a string with line numbers. */
export function renderLines(lines: readonly string[], offset: number): string {
	return lines.map((line, i) => `${offset + i}: ${line}`).join("\n");
}

/** A directory entry with its type. */
export interface DirEntry {
	readonly name: string;
	readonly isDirectory: boolean;
}

/**
 * Pure: format directory entries into a sorted listing string.
 * Subdirectories get a trailing `/`. Empty input returns an empty-directory message.
 */
export function formatDirectoryEntries(entries: readonly DirEntry[], dirPath: string): string {
	if (entries.length === 0) {
		return `(empty directory: ${dirPath})`;
	}
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	return sorted.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join("\n");
}

/**
 * Factory: create a read_file ToolContract.
 *
 * `resolveBackend` is the injected seam: each `execute` resolves an
 * `ExecBackend` from `ctx.computerId` (undefined → local `node:fs`; a set
 * id → a remote SSH backend in a later wave). The tool programs against the
 * `ExecBackend` surface, never `node:fs` directly, so it is transport-agnostic.
 *
 * `workdir` is the fallback base directory when `ctx.cwd` is omitted. It is
 * injected so the tool is testable; `execute` prefers `ctx.cwd` when present.
 */
export function createReadFileTool(deps: {
	readonly resolveBackend: ExecBackendResolver;
	readonly workdir?: string;
}): ToolContract {
	const workdir = deps.workdir !== undefined ? resolve(deps.workdir) : undefined;

	return {
		name: "read_file",
		description:
			"Read the contents of a file or list a directory's contents. " +
			"For files, returns lines with 1-indexed line numbers. " +
			"Supports offset/limit for reading specific sections of large files. " +
			"For directories, returns sorted entries with subdirectories suffixed by /.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file, relative to the working directory.",
				},
				offset: {
					type: "number",
					description: "1-indexed start line number (default: 1).",
					default: 1,
				},
				limit: {
					type: "number",
					description: "Maximum number of lines to return (default: 500, hard cap: 5000).",
					default: 500,
				},
			},
			required: ["path"],
		},
		concurrencySafe: true,
		async execute(args: unknown, ctx): Promise<ToolResult> {
			const validated = validateArgs(args);
			if ("error" in validated) {
				return { content: validated.error, isError: true };
			}

			const { path: relPath, offset, limit } = validated;

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

			// Stat to determine if this is a file or directory.
			let pathStat: StatResult;
			try {
				pathStat = await backend.stat(resolvedPath);
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return { content: `Error: File "${relPath}" not found.`, isError: true };
				}
				return {
					content: `Error reading path: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			// Directory listing branch. backend.readdir already returns
			// {name, isDirectory}[] entries, so no per-entry collapse is needed.
			if (pathStat.isDirectory) {
				let entries: readonly DirEntry[];
				try {
					entries = await backend.readdir(resolvedPath);
				} catch (err: unknown) {
					return {
						content: `Error reading directory: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					};
				}
				return { content: formatDirectoryEntries(entries, relPath) };
			}

			// File branch — read the file.
			let content: string;
			try {
				content = await backend.readFile(resolvedPath);
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

			// Handle empty file.
			if (content.length === 0) {
				return { content: `(empty file: ${relPath})` };
			}

			// Apply offset/limit line slicing.
			const { lines, totalLines } = sliceLines(content, offset, limit);

			if (offset > totalLines) {
				return {
					content: `Error: offset ${offset} exceeds total lines (${totalLines}) in "${relPath}".`,
					isError: true,
				};
			}

			return { content: renderLines(lines, offset) };
		},
	};
}
