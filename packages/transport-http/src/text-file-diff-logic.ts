import type { TextFileDiffLine, TextFileDiffStatus } from "@dispatch/transport-contract";
import { type TextFileError, textFileSizeLimitError } from "./text-file-logic.js";

/** One parsed `git status --porcelain=v2` entry for the single requested path. */
export type GitStatusEntry =
  /** Tracked (staged and/or unstaged changes); `inHead` = the path exists in HEAD. */
  | { readonly kind: "tracked"; readonly inHead: boolean; readonly raw: string }
  | { readonly kind: "untracked"; readonly raw: string }
  | { readonly kind: "ignored"; readonly raw: string };

/** The parts of `git status --porcelain=v2 -z --branch` the diff depends on. */
export interface GitStatusSummary {
  /** HEAD commit oid, or null on an unborn branch (`(initial)`). */
  readonly headCommit: string | null;
  /** The path's entry, or null when it is clean-and-tracked or absent. */
  readonly entry: GitStatusEntry | null;
}

const ZERO_OID = /^0+$/u;

/**
 * Parse `git status --porcelain=v2 -z --branch` output limited to ONE pathspec. Only the
 * `# branch.oid` header is kept (ahead/behind and upstream headers are deliberately ignored so
 * fetches never perturb the diff version). Pure.
 */
export function parseGitStatus(output: string): GitStatusSummary | { readonly error: string } {
  let headCommit: string | null = null;
  let entry: GitStatusEntry | null = null;
  for (const record of output.split("\0")) {
    if (record === "") continue;
    if (record.startsWith("# ")) {
      const match = /^# branch\.oid (\S+)$/u.exec(record);
      if (match?.[1] !== undefined) headCommit = match[1] === "(initial)" ? null : match[1];
      continue;
    }
    if (entry !== null) return { error: "Unexpected multiple git status entries" };
    const type = record[0];
    if (type === "?") entry = { kind: "untracked", raw: record };
    else if (type === "!") entry = { kind: "ignored", raw: record };
    else if (type === "1") {
      // 1 XY sub mH mI mW hH hI path
      const hH = record.split(" ")[6];
      if (hH === undefined) return { error: "Malformed git status entry" };
      entry = { kind: "tracked", inHead: !ZERO_OID.test(hH), raw: record };
    } else if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path — a merge conflict; diffed against HEAD as modified.
      entry = { kind: "tracked", inHead: true, raw: record };
    } else return { error: "Unsupported git status entry" };
  }
  return { headCommit, entry };
}

/** How the diff is produced for a classified file. */
export type DiffPlan =
  /** Run `git diff HEAD` (whole-file context) and parse it. */
  | { readonly source: "git-diff"; readonly status: "modified" | "added" | "deleted" }
  /** Read the working file; every line gets `kind`. */
  | {
      readonly source: "working-file";
      readonly status: TextFileDiffStatus;
      readonly kind: "context" | "added";
    };

/**
 * Decide status + diff source from the repo/status facts. `null` = the file exists neither in
 * the working tree nor in HEAD → 404. Pure.
 */
export function planTextFileDiff(input: {
  readonly inRepo: boolean;
  readonly workingExists: boolean;
  readonly status: GitStatusSummary | null;
}): DiffPlan | null {
  const { inRepo, workingExists, status } = input;
  if (!inRepo || status === null) {
    return workingExists
      ? { source: "working-file", status: "not-in-repo", kind: "context" }
      : null;
  }
  const entry = status.entry;
  if (entry === null) {
    return workingExists ? { source: "working-file", status: "unmodified", kind: "context" } : null;
  }
  if (entry.kind === "ignored") {
    return workingExists ? { source: "working-file", status: "ignored", kind: "context" } : null;
  }
  if (entry.kind === "untracked") {
    return workingExists ? { source: "working-file", status: "untracked", kind: "added" } : null;
  }
  if (status.headCommit === null || !entry.inHead) {
    // Unborn branch or a staged new file: the base is empty.
    if (!workingExists) return null;
    if (status.headCommit === null)
      return { source: "working-file", status: "added", kind: "added" };
    return { source: "git-diff", status: "added" };
  }
  return { source: "git-diff", status: workingExists ? "modified" : "deleted" };
}

/** Opaque diff version over every input the diff depends on. Pure. */
export function textFileDiffVersion(input: {
  readonly fileVersion: string | null;
  readonly repoRoot: string | null;
  readonly status: GitStatusSummary | null;
}): string {
  return JSON.stringify([
    input.fileVersion,
    input.repoRoot,
    input.status?.headCommit ?? null,
    input.status?.entry?.raw ?? null,
  ]);
}

function hasBinaryControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

/** Split text into lines, dropping only the `\n` terminators. Pure. */
export function splitTextLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Whole-file lines of a single kind (no git base, or an empty base). Pure. */
export function uniformDiffLines(text: string, kind: "context" | "added"): TextFileDiffLine[] {
  return splitTextLines(text).map((line, index) => ({
    kind,
    text: line,
    oldLine: kind === "context" ? index + 1 : null,
    newLine: index + 1,
  }));
}

export interface ParsedDiff {
  readonly lines: readonly TextFileDiffLine[];
  /** UTF-8 bytes of the HEAD side (with terminators), for the per-path cap. */
  readonly oldBytes: number;
  /** True when git printed at least one hunk. */
  readonly hasHunks: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Parse the unified diff of ONE file produced with whole-file context (`-U<huge>`). Hunk bodies
 * are consumed by their header counts, so content lines that look like headers are safe.
 * Binary diffs, invalid UTF-8 or binary control characters → 400; HEAD side over `maxBytes` →
 * 413. Pure.
 */
export function parseUnifiedDiff(bytes: Uint8Array, maxBytes: number): ParsedDiff | TextFileError {
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { error: "Text file must be valid UTF-8", status: 400 };
  }
  const raw = splitTextLines(output);
  const lines: TextFileDiffLine[] = [];
  const encoder = new TextEncoder();
  let oldBytes = 0;
  let hasHunks = false;
  let index = 0;
  while (index < raw.length) {
    const line = raw[index] as string;
    index += 1;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      return { error: "Text file is binary", status: 400 };
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue; // diff --git / index / --- / +++ / mode lines
    hasHunks = true;
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    // `-0,0` / `+0,0` name the line BEFORE an empty side; numbering starts after it.
    if (oldLeft === 0) oldLine += 1;
    if (newLeft === 0) newLine += 1;
    while (oldLeft > 0 || newLeft > 0) {
      const body = raw[index];
      if (body === undefined) return { error: "Truncated git diff", status: 400 };
      index += 1;
      const prefix = body[0];
      const text = body.slice(1);
      if (prefix === "\\") continue; // "\ No newline at end of file"
      if (hasBinaryControls(text)) {
        return { error: "Text file contains binary control characters", status: 400 };
      }
      if (prefix === " " && oldLeft > 0 && newLeft > 0) {
        lines.push({ kind: "context", text, oldLine, newLine });
        oldBytes += encoder.encode(text).byteLength + 1;
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else if (prefix === "-" && oldLeft > 0) {
        lines.push({ kind: "removed", text, oldLine, newLine: null });
        oldBytes += encoder.encode(text).byteLength + 1;
        oldLine += 1;
        oldLeft -= 1;
      } else if (prefix === "+" && newLeft > 0) {
        lines.push({ kind: "added", text, oldLine: null, newLine });
        newLine += 1;
        newLeft -= 1;
      } else return { error: "Malformed git diff", status: 400 };
    }
  }
  // The final line may lack a newline; the +1 per line can overcount by one byte.
  if (oldBytes - 1 > maxBytes) return textFileSizeLimitError(maxBytes);
  return { lines, oldBytes, hasHunks };
}

/** Count added/removed lines. Pure. */
export function countDiffLines(lines: readonly TextFileDiffLine[]): {
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}
