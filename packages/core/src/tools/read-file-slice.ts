import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { canonicalize } from "./path-utils.js";
import { SPILL_ROOT } from "./truncate.js";

const DEFAULT_LENGTH = 5000;

export function createReadFileSliceTool(workingDirectory: string): ToolDefinition {
	return {
		name: "read_file_slice",
		description:
			"Read a character-range slice of a single line in a file. Use this when read_file returns a truncated line marker like '[line N truncated, total X chars; use read_file_slice ...]', or when you need precise byte-ish access into a minified file (huge JSON, base64 blob, etc.). For normal line-oriented reading use read_file with offset/limit instead.",
		parameters: z.object({
			path: z.string().describe("Path to the file, relative to the working directory."),
			line: z.number().int().min(1).describe("1-indexed line number to slice into."),
			charOffset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("0-indexed character offset within the line. Default: 0 (start of line)."),
			charLength: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					`Max characters to return from the slice. Default: ${DEFAULT_LENGTH}. The universal tool-output truncator will still spill if the result is huge.`,
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const filePath = args.path as string;
			const lineNumber = args.line as number;
			const charOffset =
				typeof args.charOffset === "number" ? Math.max(0, Math.floor(args.charOffset)) : 0;
			const charLength =
				typeof args.charLength === "number"
					? Math.max(1, Math.floor(args.charLength))
					: DEFAULT_LENGTH;

			// Canonicalize all three so symlink-in-workdir escapes are detected.
			// See `canonicalize` in ./path-utils.ts for the resolution semantics.
			const absolutePath = await canonicalize(workingDirectory, filePath);
			const absoluteWorkDir = await canonicalize(workingDirectory);
			const absoluteSpillRoot = await canonicalize(SPILL_ROOT);
			const isUnderWorkdir =
				absolutePath === absoluteWorkDir || absolutePath.startsWith(`${absoluteWorkDir}/`);
			const isSpillFile =
				absolutePath === absoluteSpillRoot || absolutePath.startsWith(`${absoluteSpillRoot}/`);

			if (!isUnderWorkdir && !isSpillFile) {
				return `Error: Path "${filePath}" is outside the working directory.`;
			}

			let raw: string;
			try {
				raw = await readFile(absolutePath, "utf8");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return `Error: File "${filePath}" not found.`;
				}
				return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
			}

			const lines = raw.split("\n");
			const trailingNewline = raw.endsWith("\n");
			const totalLines = trailingNewline ? lines.length - 1 : lines.length;

			if (lineNumber > totalLines) {
				return `Error: line ${lineNumber} exceeds file length (${totalLines} lines).`;
			}

			const line = lines[lineNumber - 1] ?? "";
			const lineLength = line.length;

			if (charOffset >= lineLength) {
				return `Error: charOffset ${charOffset} exceeds line length (${lineLength} chars).`;
			}

			const sliceEnd = Math.min(charOffset + charLength, lineLength);
			const slice = line.slice(charOffset, sliceEnd);
			const remaining = lineLength - sliceEnd;

			const header = `[file: ${filePath} — line ${lineNumber}, chars ${charOffset}-${sliceEnd} of ${lineLength}${remaining > 0 ? ` (${remaining.toLocaleString()} chars remain after this slice)` : ""}]`;
			return `${header}\n${slice}`;
		},
	};
}
