import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export function createWriteFileTool(workingDirectory: string): ToolDefinition {
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
			const absolutePath = resolve(join(workingDirectory, filePath));
			const absoluteWorkDir = resolve(workingDirectory);

			if (!absolutePath.startsWith(`${absoluteWorkDir}/`) && absolutePath !== absoluteWorkDir) {
				return `Error: Path "${filePath}" is outside the working directory.`;
			}

			try {
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, content, "utf8");
				return `Successfully wrote to "${filePath}".`;
			} catch (err) {
				return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
