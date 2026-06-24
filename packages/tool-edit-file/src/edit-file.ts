import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

// --- Diagnostics hook ---

/**
 * Optional post-edit diagnostics hook. Returns formatted diagnostics string
 * (empty if none) + timing metadata. Injected by the extension from the LSP
 * service; absent when no LSP is available (graceful degradation).
 */
export type DiagnosticsHook = (opts: {
	readonly filePath: string;
	readonly text: string;
	readonly cwd: string;
}) => Promise<{
	readonly formatted: string;
	readonly slow: boolean;
	readonly timedOut: boolean;
}>;

// --- Shell / edge ---

/**
 * Factory: create an edit_file ToolContract bound to a working directory.
 * The working directory is injected so the tool is testable.
 * `diagnostics` is optional — when provided, errors+warnings from LSP servers
 * are appended to successful edit results (only when errors exist).
 */
export function createEditFileTool(
	workingDirectory: string,
	diagnostics?: DiagnosticsHook,
): ToolContract {
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

			const effectiveBase = ctx.cwd ? resolve(ctx.cwd) : workdir;
			const resolvedPath = resolve(effectiveBase, relPath);

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
			let baseContent = `Replaced ${result.count} occurrence${plural} in "${relPath}".`;

			// After a successful edit, query LSP diagnostics (if available).
			// Only append if there are actual errors/warnings (no noise on clean edits).
			if (diagnostics) {
				try {
					const cwd = ctx.cwd ?? process.cwd();
					const diag = await diagnostics({
						filePath: resolvedPath,
						text: result.content,
						cwd,
					});
					const suffix: string[] = [];
					if (diag.slow) {
						suffix.push(
							"⚠️ LSP is taking unusually long. If this happens more than once, raise it to the user.",
						);
					}
					if (diag.formatted) {
						suffix.push(diag.formatted);
					}
					if (suffix.length > 0) {
						baseContent += `\n\n${suffix.join("\n\n")}`;
					}
				} catch {
					// LSP diagnostics failure is non-fatal — the edit already succeeded.
				}
			}

			return { content: baseContent };
		},
	};
}
