import type { Diagnostic } from "vscode-languageserver-types";

/**
 * Diagnostic formatting helpers. Ported from opencode's `lsp/diagnostic.ts`.
 *
 * LSP positions are 0-based on the wire; we render them 1-based (editor-style)
 * so they line up with what `read_file` shows and what editors report.
 */

/** Max diagnostics rendered per file before truncating with a "… and N more". */
const MAX_PER_FILE = 20;

const SEVERITY_LABEL: Record<number, string> = {
	1: "ERROR",
	2: "WARN",
	3: "INFO",
	4: "HINT",
};

/** Render a single diagnostic as `SEVERITY [line:col] message` (1-based). */
export function pretty(diagnostic: Diagnostic): string {
	const severity = SEVERITY_LABEL[diagnostic.severity ?? 1] ?? "ERROR";
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	return `${severity} [${line}:${col}] ${diagnostic.message}`;
}

/**
 * Build a `<diagnostics file="…">` block for a file's ERROR-severity
 * diagnostics, or `""` when there are none. Errors only — warnings/info/hints
 * are intentionally omitted so the model is nudged toward the things that
 * actually break the build (matching opencode's behavior).
 */
export function report(file: string, issues: Diagnostic[]): string {
	const errors = issues.filter((item) => item.severity === 1);
	if (errors.length === 0) return "";
	const limited = errors.slice(0, MAX_PER_FILE);
	const more = errors.length - MAX_PER_FILE;
	const suffix = more > 0 ? `\n... and ${more} more` : "";
	return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`;
}
