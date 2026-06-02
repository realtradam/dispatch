import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { canonicalize } from "./path-utils.js";

// Resolve the `cs` binary: an explicit override wins, otherwise rely on PATH.
// The deployed images build a patched, statically-linked `cs` into
// /usr/local/bin/cs (see Dockerfile); local dev can point DISPATCH_CS_BIN at a
// custom build. Read at call time so the environment can change at runtime
// (and so tests can point it at a stub or temp build).
function resolveCsBin(): string {
	return process.env.DISPATCH_CS_BIN || "cs";
}

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const MAX_CONTEXT = 20;
const MIN_SNIPPET_LENGTH = 50;
const MAX_SNIPPET_LENGTH = 2000;
const TIMEOUT_MS = 30_000;

/** Maps the `only` enum to the corresponding cs flag. */
const ONLY_FLAGS: Record<string, string> = {
	code: "--only-code",
	comments: "--only-comments",
	strings: "--only-strings",
	declarations: "--only-declarations",
	usages: "--only-usages",
};

/** One line within a cs JSON match result. */
interface CsLine {
	line_number: number;
	content: string;
	match_positions?: Array<[number, number]>;
}

/** A single file result in cs `-f json` output. */
interface CsResult {
	filename: string;
	location: string;
	score: number;
	lines: CsLine[];
	language?: string;
	total_lines?: number;
}

export function createSearchCodeTool(workingDirectory: string): ToolDefinition {
	return {
		name: "search_code",
		description:
			"Search the codebase by query using `cs` (code spelunker) — a fast, relevance-ranked code search engine. " +
			"Prefer this over grep/find for EXPLORATORY 'where is X / how does Y work' searches: it ranks the most " +
			"relevant files first and returns matching snippets with line numbers, so you spend fewer turns and tokens. " +
			"It respects .gitignore and skips hidden/binary files. " +
			'Query syntax: space-separated terms are AND\'d; supports OR, NOT, "exact phrases", fuzzy~1, /regex/, and ' +
			"metadata filters like lang:Go, file:test, path:src. " +
			"It is a ranked text search, NOT a semantic/LSP index: it won't resolve types or imports. For an EXHAUSTIVE " +
			"list of every exact match (e.g. before a rename), use run_shell with ripgrep (rg) instead.",
		parameters: z.object({
			query: z
				.string()
				.describe(
					'The search query. Terms are AND\'d by default. Supports OR, NOT, "phrases", fuzzy~1, /regex/, and filters like lang:Go, file:test, path:src.',
				),
			path: z
				.string()
				.optional()
				.describe(
					"Subdirectory to scope the search to, relative to the working directory. Defaults to the whole working directory.",
				),
			case_sensitive: z
				.boolean()
				.optional()
				.describe("Make the search case-sensitive. Default: false (case-insensitive)."),
			include_ext: z
				.string()
				.optional()
				.describe(
					'Comma-separated list of file extensions to limit the search to (case-sensitive), e.g. "go,ts,lua".',
				),
			exclude_pattern: z
				.string()
				.optional()
				.describe(
					'Comma-separated list of path patterns to exclude (case-sensitive), e.g. "vendor,_test.go".',
				),
			context: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(`Lines of context to show around each match (0-${MAX_CONTEXT}).`),
			result_limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					`Maximum number of file results to return. Default: ${DEFAULT_RESULT_LIMIT}, max: ${MAX_RESULT_LIMIT}.`,
				),
			snippet_length: z
				.number()
				.int()
				.min(MIN_SNIPPET_LENGTH)
				.optional()
				.describe(
					`Size in bytes of each snippet shown (${MIN_SNIPPET_LENGTH}-${MAX_SNIPPET_LENGTH}). Larger = more context per match.`,
				),
			only: z
				.enum(["code", "comments", "strings", "declarations", "usages"])
				.optional()
				.describe(
					"Restrict matches structurally: code, comments, strings, declarations (definitions like func/class/type), " +
						"or usages (call sites). Best-effort and language-dependent — strong for Go/TypeScript/Python/Lua/Luau, " +
						"unavailable for unsupported languages (which fall back to plain text ranking).",
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const query = args.query as string;
			if (typeof query !== "string" || query.trim() === "") {
				return "Error: query is required.";
			}

			// Resolve and contain the optional search path within the workdir.
			// Canonicalize so a symlink-in-workdir pointing outside is detected,
			// matching the containment semantics of list_files / read_file.
			const relPath = (args.path as string | undefined) ?? ".";
			const absoluteWorkDir = await canonicalize(workingDirectory);
			const searchDir = await canonicalize(workingDirectory, relPath);
			if (searchDir !== absoluteWorkDir && !searchDir.startsWith(`${absoluteWorkDir}/`)) {
				return `Error: Path "${relPath}" is outside the working directory.`;
			}

			const flags = buildFlags(args, searchDir);
			// `--` terminates cs flag parsing so a query that begins with "-"
			// (e.g. "-hello" or "--foo") is treated as the positional search term
			// rather than parsed as a (possibly invalid) cs flag.
			const spawnArgs = [...flags, "--", query];

			let stdout = "";
			let stderr = "";
			const result = await new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
				error?: string;
				errorCode?: string;
			}>((resolve) => {
				const child = spawn(resolveCsBin(), spawnArgs, {
					cwd: workingDirectory,
					env: process.env,
					timeout: TIMEOUT_MS,
					stdio: ["ignore", "pipe", "pipe"],
				});
				child.stdout?.on("data", (d: Buffer) => {
					stdout += d.toString();
				});
				child.stderr?.on("data", (d: Buffer) => {
					stderr += d.toString();
				});
				child.on("close", (code, signal) => resolve({ code, signal }));
				child.on("error", (err) =>
					resolve({
						code: null,
						signal: null,
						error: err.message,
						errorCode: (err as NodeJS.ErrnoException).code,
					}),
				);
			});

			if (result.error) {
				// The binary is missing or not executable — give an actionable hint.
				if (result.errorCode === "ENOENT" || result.error.includes("ENOENT")) {
					return missingBinaryError();
				}
				return `Error: failed to run cs: ${result.error}`;
			}

			// A signal kill (e.g. SIGTERM from the spawn timeout) or a non-zero
			// exit means cs failed — surface it (with stderr) instead of silently
			// reporting "No matches found". cs exits 0 even when there are no
			// matches, so a clean exit always falls through to the parsing below.
			if (result.signal) {
				const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
				if (result.signal === "SIGTERM") {
					return `Error: cs search timed out after ${TIMEOUT_MS / 1000}s. Try a narrower query or a smaller path.${detail}`;
				}
				return `Error: cs was terminated by signal ${result.signal}.${detail}`;
			}
			if (result.code !== 0) {
				const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
				return `Error: cs exited with code ${result.code}.${detail}`;
			}

			// cs prints `null` (and exit 0) when there are no matches.
			const trimmed = stdout.trim();
			if (trimmed === "" || trimmed === "null") {
				return "No matches found.";
			}

			let parsed: CsResult[];
			try {
				parsed = JSON.parse(trimmed) as CsResult[];
			} catch {
				// Couldn't parse — surface what cs produced so the caller isn't blind.
				const detail = stderr.trim() ? `\nstderr: ${stderr.trim()}` : "";
				return `Error: could not parse cs output as JSON.${detail}\n\nRaw output:\n${trimmed.slice(0, 2000)}`;
			}

			if (!Array.isArray(parsed) || parsed.length === 0) {
				return "No matches found.";
			}

			return formatResults(parsed, absoluteWorkDir);
		},
	};
}

/** Build the cs CLI flags (everything except the trailing query). */
function buildFlags(args: Record<string, unknown>, searchDir: string): string[] {
	const flags: string[] = ["-f", "json", "--dir", searchDir];

	if (args.case_sensitive === true) flags.push("-c");

	const includeExt = args.include_ext as string | undefined;
	if (includeExt?.trim()) flags.push("-i", includeExt.trim());

	const excludePattern = args.exclude_pattern as string | undefined;
	if (excludePattern?.trim()) flags.push("-x", excludePattern.trim());

	if (typeof args.context === "number") {
		const context = clamp(Math.floor(args.context), 0, MAX_CONTEXT);
		flags.push("-C", String(context));
	}

	const requestedLimit =
		typeof args.result_limit === "number"
			? clamp(Math.floor(args.result_limit), 1, MAX_RESULT_LIMIT)
			: DEFAULT_RESULT_LIMIT;
	flags.push("--result-limit", String(requestedLimit));

	if (typeof args.snippet_length === "number") {
		const snippet = clamp(Math.floor(args.snippet_length), MIN_SNIPPET_LENGTH, MAX_SNIPPET_LENGTH);
		flags.push("-n", String(snippet));
	}

	const only = args.only as string | undefined;
	if (only && ONLY_FLAGS[only]) flags.push(ONLY_FLAGS[only]);

	return flags;
}

/** Render cs JSON results into compact, readable per-file blocks. */
function formatResults(results: CsResult[], absoluteWorkDir: string): string {
	const blocks: string[] = [];
	// Match the workdir only at a path boundary so a sibling dir that merely
	// shares the prefix (e.g. workdir "/app" vs "/app-secrets") isn't treated
	// as nested and rendered as a "../app-secrets/..." relative path.
	const workdirPrefix = absoluteWorkDir.endsWith(sep) ? absoluteWorkDir : absoluteWorkDir + sep;
	for (const r of results) {
		// Present paths relative to the workdir so output is portable and compact.
		const insideWorkdir = r.location === absoluteWorkDir || r.location.startsWith(workdirPrefix);
		const rel = insideWorkdir ? relative(absoluteWorkDir, r.location) || r.filename : r.location;
		const lang = r.language ? ` [${r.language}]` : "";
		const score = typeof r.score === "number" ? ` (score ${r.score.toFixed(2)})` : "";
		const header = `${rel}${lang}${score}`;

		const lines = (r.lines ?? []).map((l) => {
			const marker = l.match_positions && l.match_positions.length > 0 ? ">" : " ";
			return `  ${marker} ${l.line_number}: ${l.content}`;
		});

		blocks.push([header, ...lines].join("\n"));
	}

	const count = results.length;
	const heading = `Found matches in ${count} file${count === 1 ? "" : "s"} (ranked by relevance):`;
	return [heading, "", blocks.join("\n\n")].join("\n");
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function missingBinaryError(): string {
	return [
		"Error: search_code requires the 'cs' (code spelunker) binary, which was not found.",
		"Install it with: go install github.com/boyter/cs/v3@v3.1.0",
		"or set the DISPATCH_CS_BIN environment variable to the path of a cs binary.",
		"(In the official Docker images cs is bundled at /usr/local/bin/cs.)",
	].join("\n");
}
