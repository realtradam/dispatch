import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
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

/** Pure: check that a resolved absolute path is within the workdir (prefix check). */
export function isPathWithinWorkdir(resolvedPath: string, workdir: string): boolean {
	const normalizedWorkdir = workdir.endsWith(sep) ? workdir : workdir + sep;
	return resolvedPath === workdir || resolvedPath.startsWith(normalizedWorkdir);
}

/** Pure: render lines into a string with line numbers. */
export function renderLines(lines: readonly string[], offset: number): string {
	return lines.map((line, i) => `${offset + i}: ${line}`).join("\n");
}

/**
 * Factory: create a read_file ToolContract bound to a working directory.
 * The working directory is injected so the tool is testable.
 */
export function createReadFileTool(workingDirectory: string): ToolContract {
	const workdir = resolve(workingDirectory);

	return {
		name: "read_file",
		description:
			"Read the contents of a file. Returns lines with 1-indexed line numbers. " +
			"Supports offset/limit for reading specific sections of large files.",
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

			// Effective base: per-turn ctx.cwd overrides the baked workdir.
			const effectiveBase = ctx.cwd ? resolve(ctx.cwd) : workdir;

			// Resolve the requested path against the effective base.
			const resolvedPath = resolve(effectiveBase, relPath);

			// Basic prefix check (catches ".." and absolute paths outside effectiveBase).
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
					content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
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
