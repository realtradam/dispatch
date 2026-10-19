/**
 * Pure "new issue" detection + notice formatting for background diagnostics.
 *
 * Issue identity is POSITION-INSENSITIVE: edits shift line numbers, so a
 * range-bearing key (like `diagnosticKey`) would make every shifted error look
 * new. Identity is `(severity, source, code, message)` and comparison is by
 * MULTISET COUNT — two copies of the same message on different lines are two
 * issues, and losing one of them is not "new".
 *
 * No I/O, no clocks, no mocks: this module is the strict-core half of the
 * feature (AGENTS.md testing rules).
 */

import { isAbsolute, relative } from "node:path";
import type { Diagnostic } from "./diagnostics.js";

/** Only errors (1) and warnings (2) participate (matches `minSeverity: 2`). */
const ERROR = 1;
const WARNING = 2;

/** Identity of an issue: `(severity, source, code, message)`, ranges excluded. */
export type IssueIdentity = string;

/**
 * Identity → number of copies currently observed (or announced).
 * A missing key means zero.
 */
export type IssueBaseline = ReadonlyMap<IssueIdentity, number>;

export interface NewIssuesResult {
  /** Issues present now whose count exceeds the baseline count, by severity. */
  readonly newErrors: number;
  readonly newWarnings: number;
  /**
   * The baseline LOWERED to what is still present: `min(baseline[id], current)`.
   * Assigning this keeps a fixed issue from staying "announced" forever (so it
   * counts as new again if it reappears). Callers that actually DELIVER a
   * notice must instead commit `baselineFromIssues(current)` — the whole
   * current multiset, including the newly announced copies.
   */
  readonly nextBaseline: IssueBaseline;
}

/** Count issues by identity, ignoring severities other than error/warning. */
export function issueCounts(issues: readonly Diagnostic[]): Map<IssueIdentity, number> {
  const counts = new Map<IssueIdentity, number>();
  for (const issue of issues) {
    if (!participates(issue.severity)) continue;
    const key = issueIdentity(issue);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The baseline a caller commits after DELIVERING the notice for `issues`. */
export function baselineFromIssues(issues: readonly Diagnostic[]): IssueBaseline {
  return issueCounts(issues);
}

/**
 * Count how many current errors/warnings the agent has not been told about.
 *
 * `baseline` is the "announced multiset": what the agent was TOLD is present.
 * For each identity, `new = max(0, current − baseline)`.
 */
export function diffNewIssues(
  baseline: IssueBaseline,
  issues: readonly Diagnostic[],
): NewIssuesResult {
  const current = issueCounts(issues);

  let newErrors = 0;
  let newWarnings = 0;
  for (const [key, currentCount] of current) {
    const extra = currentCount - (baseline.get(key) ?? 0);
    if (extra <= 0) continue;
    // The severity is the first element of the identity tuple.
    const severity = severityOf(key);
    if (severity === ERROR) newErrors += extra;
    else if (severity === WARNING) newWarnings += extra;
  }

  // Lower the baseline to what is still present. `issueCounts` only retains
  // participating severities, so this also drops vanished issues.
  const nextBaseline = new Map<IssueIdentity, number>();
  for (const [key, announced] of baseline) {
    const still = current.get(key) ?? 0;
    const kept = Math.min(announced, still);
    if (kept > 0) nextBaseline.set(key, kept);
  }

  return { newErrors, newWarnings, nextBaseline };
}

/** Per-file counts for a "new issues" notice. */
export interface FileIssueCounts {
  /** Absolute or cwd-relative path; rendered relative to `cwd` when inside it. */
  readonly filePath: string;
  readonly newErrors: number;
  readonly newWarnings: number;
}

/**
 * Format the agent-facing notice. Where and how many — never what:
 *
 * ```
 * [LSP] New issues detected:
 * - packages/foo/src/bar.ts: 2 new errors, 1 new warning
 * Call the `lsp` tool with operation "diagnostics" and the file path to read the full report.
 * ```
 *
 * Files with no new issues are omitted; zero counts are omitted; a single-file
 * and a multi-file list share the same shape (one bullet per file, sorted by
 * path for determinism). Returns `""` when nothing is new.
 */
export function formatNotice(files: readonly FileIssueCounts[], cwd: string): string {
  const bullets = files
    .filter((f) => f.newErrors > 0 || f.newWarnings > 0)
    .slice()
    .sort((a, b) => a.filePath.localeCompare(b.filePath))
    .map((f) => {
      const parts: string[] = [];
      if (f.newErrors > 0) parts.push(`${f.newErrors} new ${plural("error", f.newErrors)}`);
      if (f.newWarnings > 0) parts.push(`${f.newWarnings} new ${plural("warning", f.newWarnings)}`);
      return `- ${displayPath(f.filePath, cwd)}: ${parts.join(", ")}`;
    });

  if (bullets.length === 0) return "";

  return [
    "[LSP] New issues detected:",
    ...bullets,
    'Call the `lsp` tool with operation "diagnostics" and the file path to read the full report.',
  ].join("\n");
}

/** Render `filePath` relative to `cwd` when it is inside it, else as-is. */
export function displayPath(filePath: string, cwd: string): string {
  if (!isAbsolute(filePath) || !isAbsolute(cwd)) return filePath;
  const rel = relative(cwd, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return filePath;
  return rel;
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function participates(severity: number | undefined): boolean {
  return severity === ERROR || severity === WARNING;
}

/**
 * Stable identity for `(severity, source, code, message)`. JSON-encoded so a
 * message containing separators can never collide with another tuple.
 */
function issueIdentity(issue: Diagnostic): IssueIdentity {
  return JSON.stringify([
    issue.severity ?? 0,
    issue.source ?? "",
    issue.code === undefined ? "" : String(issue.code),
    issue.message,
  ]);
}

function severityOf(identity: IssueIdentity): number {
  const parsed: unknown = JSON.parse(identity);
  return Array.isArray(parsed) && typeof parsed[0] === "number" ? parsed[0] : 0;
}
