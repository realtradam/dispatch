import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { canonicalize } from "./path-utils.js";

/**
 * Optional hook invoked AFTER a successful write, with the canonicalized
 * absolute path of the file just written. Its returned string (when non-empty)
 * is appended to the tool result. This is how LSP diagnostics are surfaced
 * back to the model on write without coupling `@dispatch/core`'s tools to the
 * API layer or the LSP manager — the host wires an implementation that touches
 * the file through the LSP and formats any diagnostics. Errors thrown here are
 * swallowed so a flaky LSP never fails the write itself.
 */
export type AfterWriteHook = (absolutePath: string) => Promise<string>;

export function createWriteFileTool(
	workingDirectory: string,
	onAfterWrite?: AfterWriteHook,
): ToolDefinition {
	return {
		name: "write_file",
		description: "Write content to a file relative to the working directory.",
		parameters: z.object({
			path: z.string().describe("Path to the file, relative to the working directory"),
			content: z.string().describe("Content to write to the file"),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const filePath = args.path as string;
			const content = args.content as string;
			// Canonicalize so a workdir-relative path that resolves through
			// symlinks to outside the workdir is detected and blocked. The
			// canonicalize walks up to the nearest existing ancestor when the
			// leaf doesn't exist (typical for write_file), so a path like
			// `workdir/escape-link/new-file.txt` where `escape-link` symlinks
			// to /etc still resolves through the symlink and is caught here.
			const absolutePath = await canonicalize(workingDirectory, filePath);
			const absoluteWorkDir = await canonicalize(workingDirectory);

			if (absolutePath !== absoluteWorkDir && !absolutePath.startsWith(`${absoluteWorkDir}/`)) {
				return `Error: Path "${filePath}" is outside the working directory.`;
			}

			try {
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, content, "utf8");
			} catch (err) {
				return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
			}

			let result = `Successfully wrote to "${filePath}".`;
			// Post-write hook (e.g. LSP diagnostics). Best-effort: never let a
			// hook failure turn a successful write into an error.
			if (onAfterWrite) {
				try {
					const extra = await onAfterWrite(absolutePath);
					if (extra) result += `\n\n${extra}`;
				} catch {
					/* ignore — diagnostics are advisory */
				}
			}
			return result;
		},
	};
}
