import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as BashArity from "./bash-arity.js";

// Commands that touch files — triggers external_directory check.
// Includes any command that takes file paths as arguments and could leak
// information about external directories.
//
// Known gaps (not currently checked):
//   - Redirections: `echo x > /etc/file` — the redirect target is not inspected
//   - `cd` state changes: we don't track cwd mutations across pipeline stages
//   - Interpreter escapes: `python -c "open('/etc/passwd')"`, `node -e "..."` bypass this entirely
const FILE_COMMANDS = new Set([
	"rm", "cp", "mv", "mkdir", "touch", "chmod", "chown",
	"cat", "ls", "find", "grep",
	"head", "tail", "less", "more", "wc", "diff", "file", "stat", "du", "df",
]);

// Lazy-initialized parser
let parserPromise: Promise<Parsers> | null = null;

interface Parsers {
	bash: import("web-tree-sitter").Parser;
}

async function getParser(): Promise<Parsers> {
	if (parserPromise) return parserPromise;
	parserPromise = initParser();
	return parserPromise;
}

async function initParser(): Promise<Parsers> {
	const { Parser, Language } = await import("web-tree-sitter");

	// Load the main WASM binary from node_modules
	const require = createRequire(import.meta.url);
	const webTreeSitterPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
	const wasmBinary = await readFile(webTreeSitterPath);
	await Parser.init({ wasmBinary });

	const bashWasmPath = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
	const bashLang = await Language.load(bashWasmPath);

	const bash = new Parser();
	bash.setLanguage(bashLang);

	return { bash };
}

// Analyze a shell command and return permission patterns
export async function analyzeCommand(
	command: string,
	workingDirectory: string,
): Promise<{ dirs: string[]; patterns: string[]; always: string[] }> {
	try {
		const parsers = await getParser();
		const tree = parsers.bash.parse(command);
		if (!tree) return { dirs: [], patterns: [command], always: [] };

		return collect(tree.rootNode, command, workingDirectory);
	} catch {
		// Parse failure — return basic patterns
		return { dirs: [], patterns: [command], always: [] };
	}
}

function collect(
	node: import("web-tree-sitter").Node,
	_source: string,
	wd: string,
): { dirs: string[]; patterns: string[]; always: string[] } {
	const dirs: string[] = [];
	const patterns: string[] = [];
	const always: string[] = [];

	// Walk all command nodes
	const commands = node.descendantsOfType("command");

	for (const cmd of commands) {
		const parts = extractParts(cmd);
		const name = parts[0]?.toLowerCase();
		if (!name) continue;

		// Get the command source text
		const cmdText = cmd.text;
		patterns.push(cmdText);

		// Normalize to always pattern
		always.push(`${BashArity.prefix(parts).join(" ")} *`);

		// Check if this is a file-touching command
		if (FILE_COMMANDS.has(name)) {
			// Extract path arguments (skip flags starting with -)
			const pathArgs = parts.slice(1).filter((a) => !a.startsWith("-"));
			for (const arg of pathArgs) {
				const resolved = resolvePath(arg, wd);
				if (resolved && !isInsideWorkspace(resolved, wd)) {
					const parent = dirname(resolved);
					dirs.push(parent);
				}
			}
		}
	}

	return {
		dirs: [...new Set(dirs)],
		patterns: [...new Set(patterns)],
		always: [...new Set(always)],
	};
}

// Helper to extract command parts from a command AST node
function extractParts(cmd: import("web-tree-sitter").Node): string[] {
	const parts: string[] = [];
	for (const child of cmd.children) {
		if (
			child.type === "command_name" ||
			child.type === "word" ||
			child.type === "string" ||
			child.type === "raw_string"
		) {
			const text = child.text.replace(/^['"]|['"]$/g, "");
			if (text) parts.push(text);
		}
	}
	return parts;
}

function resolvePath(arg: string, wd: string): string | null {
	try {
		if (isAbsolute(arg)) return arg;
		return resolve(wd, arg);
	} catch {
		return null;
	}
}

function isInsideWorkspace(filePath: string, wd: string): boolean {
	const normalizedWd = resolve(wd);
	const rel = relative(normalizedWd, filePath);
	// rel === "" means filePath IS the workspace root — that is inside.
	// If relative path starts with "../" or is ".." exactly, or is an absolute path
	// (on Windows when drives differ), the file is outside the workspace.
	const isOutside = rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel === ".." || isAbsolute(rel);
	return !isOutside;
}
