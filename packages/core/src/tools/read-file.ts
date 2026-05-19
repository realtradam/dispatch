import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export function createReadFileTool(workingDirectory: string): ToolDefinition {
	return {
		name: "read_file",
		description: "Read the contents of a file relative to the working directory.",
		parameters: z.object({
			path: z.string().describe("Path to the file, relative to the working directory"),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const filePath = args.path as string;
			const absolutePath = resolve(join(workingDirectory, filePath));
			const absoluteWorkDir = resolve(workingDirectory);

			if (!absolutePath.startsWith(`${absoluteWorkDir}/`) && absolutePath !== absoluteWorkDir) {
				return `Error: Path "${filePath}" is outside the working directory.`;
			}

			try {
				return await readFile(absolutePath, "utf8");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return `Error: File "${filePath}" not found.`;
				}
				return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
