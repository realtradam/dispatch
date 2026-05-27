import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { canonicalize } from "./path-utils.js";
import { MAX_LINES, SPILL_ROOT } from "./truncate.js";

// Per-line truncation: any single line longer than MAX_LINE_CHARS is cut and
// replaced with a marker indicating the total length. This protects against
// minified files / base64 blobs / massive single-line JSON. The AI can use
// `read_file_slice` to inspect a specific char range within a long line.
const MAX_LINE_CHARS = 2000;

// Aligned with the universal truncator's MAX_LINES so a default-args read
// returns a response that fits under the truncator's line ceiling. Without
// this alignment, every default read of a >500-line file got returned by
// the tool and then immediately spilled by the truncator — wasted work.
// Char-dense files can still spill via MAX_CHARS, but that's content-
// dependent rather than guaranteed.
const DEFAULT_LIMIT = MAX_LINES;
// Hard cap on lines per request even if `limit` is larger or omitted.
// Prevents a `read_file(huge.log)` with no params from returning a million
// lines. The universal truncator at the agent level will spill anything
// over its own threshold, but this is a tighter first line of defense
// scoped to the read tool itself.
const HARD_LIMIT = 5000;

export function createReadFileTool(workingDirectory: string): ToolDefinition {
	return {
		name: "read_file",
		description:
			"Read a file relative to the working directory. Returns up to `limit` lines starting at line `offset` (1-indexed). Lines longer than 2000 chars are truncated mid-line with a marker showing the total length — use the `read_file_slice` tool to read a specific char range within a long line. If the response is still too large, the dispatch tool-output truncator may spill the full content to /tmp/dispatch/tool-results/.",
		parameters: z.object({
			path: z.string().describe("Path to the file, relative to the working directory"),
			offset: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("1-indexed start line. Default: 1 (start of file)."),
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					`Max lines to return. Default: ${DEFAULT_LIMIT}. Hard cap: ${HARD_LIMIT}. Use a small limit when exploring a large file.`,
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const filePath = args.path as string;
			const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
			const requestedLimit =
				typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : DEFAULT_LIMIT;
			const limit = Math.min(requestedLimit, HARD_LIMIT);

			// Canonicalize all three so symlink-in-workdir escapes are detected:
			// a workdir-relative path that resolves through symlinks to /etc must
			// fail the containment check below.
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

			// A truly empty file (0 bytes) would otherwise slip through the
			// line-counting below: `"".split("\n")` is `[""]` and there's no
			// trailing newline, yielding a spurious `totalLines === 1`.
			if (raw === "") {
				return `(empty file: ${filePath})`;
			}

			const allLines = raw.split("\n");
			// `split("\n")` produces an extra empty entry when the file ends with a
			// newline. The total line count we report to the caller should match
			// the human-visible line count (lines that have content or terminate
			// with \n).
			const trailingNewline = raw.endsWith("\n");
			const totalLines = trailingNewline ? allLines.length - 1 : allLines.length;

			if (totalLines === 0) {
				return `(empty file: ${filePath})`;
			}

			if (offset > totalLines) {
				return `Error: offset ${offset} exceeds file length (${totalLines} lines).`;
			}

			const startIdx = offset - 1; // 0-indexed
			const endIdx = Math.min(startIdx + limit, totalLines);
			const slice = allLines.slice(startIdx, endIdx);

			// Apply per-line truncation. We tag truncated lines with the line
			// number and total chars so the AI knows how to call read_file_slice.
			const rendered: string[] = [];
			for (let i = 0; i < slice.length; i++) {
				const lineNumber = startIdx + i + 1;
				const line = slice[i] ?? "";
				if (line.length > MAX_LINE_CHARS) {
					const visible = line.slice(0, MAX_LINE_CHARS);
					rendered.push(
						`${visible}...[line ${lineNumber} truncated, total ${line.length.toLocaleString()} chars; use read_file_slice with path="${filePath}" line=${lineNumber} to read more]`,
					);
				} else {
					rendered.push(line);
				}
			}

			const header = `[file: ${filePath} — lines ${offset}-${endIdx} of ${totalLines}]`;
			return `${header}\n${rendered.join("\n")}`;
		},
	};
}
