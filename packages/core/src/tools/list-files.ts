import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export function createListFilesTool(workingDirectory: string): ToolDefinition {
	return {
		name: "list_files",
		description: "List files and directories at a path relative to the working directory.",
		parameters: z.object({
			path: z
				.string()
				.optional()
				.describe("Path to list, relative to the working directory. Defaults to '.'"),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const relPath = (args.path as string | undefined) ?? ".";
			const absolutePath = resolve(join(workingDirectory, relPath));
			const absoluteWorkDir = resolve(workingDirectory);

			if (!absolutePath.startsWith(`${absoluteWorkDir}/`) && absolutePath !== absoluteWorkDir) {
				return `Error: Path "${relPath}" is outside the working directory.`;
			}

			try {
				const entries = await readdir(absolutePath, { withFileTypes: true });
				if (entries.length === 0) {
					return "(empty directory)";
				}
				return entries
					.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
					.join("\n");
			} catch (err) {
				return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
