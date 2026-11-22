import { stat } from "node:fs/promises";
import { posix } from "node:path";
import type { TextFileDiffLine, TextFileDiffStatus } from "@dispatch/transport-contract";
import {
  countDiffLines,
  type DiffPlan,
  type GitStatusSummary,
  parseGitStatus,
  parseUnifiedDiff,
  planTextFileDiff,
  textFileDiffVersion,
  uniformDiffLines,
} from "./text-file-diff-logic.js";
import { type GitRunOptions, type GitRunResult, runGit } from "./text-file-git.js";
import { decodeTextFile, type TextFileError, textFileSizeLimitError } from "./text-file-logic.js";
import { readTextFileBytes, statTextFileVersion } from "./text-file-reader.js";

/** Injected git runner (the real one spawns `git`). */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>;

/** Everything the diff (and its version) depends on, gathered without reading content. */
export interface TextFileDiffState {
  readonly version: string;
  readonly repoRoot: string | null;
  readonly workingExists: boolean;
  readonly plan: DiffPlan;
  /** Existing directory git runs in, and the literal pathspec relative to it. */
  readonly gitCwd: string;
  readonly pathspec: string;
}

const GIT_FAILED: TextFileError = { error: "Failed to run git", status: 500 };

/** Nearest existing directory at or above `dirname(path)` (a deleted file's dir may be gone). */
async function nearestDirectory(path: string): Promise<string> {
  let dir = posix.dirname(path);
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // Missing or not a directory: walk up.
    }
    const parent = posix.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/** Stat + `git rev-parse` + `git status` for ONE path. No content read, no diff. */
export async function loadTextFileDiffState(
  path: string,
  maxBytes: number,
  git: GitRunner = runGit,
): Promise<TextFileDiffState | TextFileError> {
  const file = await statTextFileVersion(path, maxBytes);
  if ("error" in file && file.status !== 404) return file;
  const fileVersion = "error" in file ? null : file.version;
  const gitCwd = await nearestDirectory(path);
  const pathspec = `:(literal)${posix.relative(gitCwd, path)}`;
  const top = await git(["rev-parse", "--show-toplevel"], {
    cwd: gitCwd,
    maxStdoutBytes: 65536,
  });
  if ("failure" in top) return GIT_FAILED;
  let repoRoot: string | null = null;
  let status: GitStatusSummary | null = null;
  if (top.exitCode === 0) {
    repoRoot = new TextDecoder().decode(top.stdout).replace(/\n$/u, "");
    const result = await git(
      [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--no-ahead-behind",
        "--ignored=matching",
        "--untracked-files=all",
        "--no-renames",
        "--",
        pathspec,
      ],
      { cwd: gitCwd, maxStdoutBytes: 1048576 },
    );
    if ("failure" in result || result.exitCode !== 0) return GIT_FAILED;
    const parsed = parseGitStatus(new TextDecoder().decode(result.stdout));
    if ("error" in parsed) return GIT_FAILED;
    status = parsed;
  }
  const workingExists = fileVersion !== null;
  const plan = planTextFileDiff({ inRepo: repoRoot !== null, workingExists, status });
  if (plan === null) return { error: "Text file not found", status: 404 };
  return {
    version: textFileDiffVersion({ fileVersion, repoRoot, status }),
    repoRoot,
    workingExists,
    plan,
    gitCwd,
    pathspec,
  };
}

export interface TextFileDiffResult {
  readonly status: TextFileDiffStatus;
  readonly lines: readonly TextFileDiffLine[];
  readonly added: number;
  readonly removed: number;
}

async function workingFileLines(
  path: string,
  maxBytes: number,
  kind: "context" | "added",
): Promise<TextFileDiffLine[] | TextFileError> {
  const read = await readTextFileBytes(path, maxBytes);
  if ("error" in read) return read;
  const decoded = decodeTextFile(read.bytes, maxBytes);
  if ("error" in decoded) return decoded;
  return uniformDiffLines(decoded.text, kind);
}

function result(status: TextFileDiffStatus, lines: readonly TextFileDiffLine[]) {
  return { status, lines, ...countDiffLines(lines) };
}

/** Compute the whole-file diff for a previously loaded state. */
export async function computeTextFileDiff(
  path: string,
  maxBytes: number,
  state: TextFileDiffState,
  git: GitRunner = runGit,
): Promise<TextFileDiffResult | TextFileError> {
  const { plan } = state;
  if (plan.source === "working-file") {
    const lines = await workingFileLines(path, maxBytes, plan.kind);
    return "error" in lines ? lines : result(plan.status, lines);
  }
  const output = await git(
    [
      "-c",
      "core.quotePath=off",
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--diff-algorithm=histogram",
      "-U2147483647",
      "HEAD",
      "--",
      state.pathspec,
    ],
    // Whole-file context: both sides plus one prefix byte per line (≤ 1.5× each side).
    { cwd: state.gitCwd, maxStdoutBytes: 3 * maxBytes + 65536 },
  );
  if ("failure" in output) {
    return output.failure === "overflow" ? textFileSizeLimitError(maxBytes) : GIT_FAILED;
  }
  if (output.exitCode !== 0) return GIT_FAILED;
  const parsed = parseUnifiedDiff(output.stdout, maxBytes);
  if ("error" in parsed) return parsed;
  if (!parsed.hasHunks && state.workingExists && plan.status === "modified") {
    // Index-only or mode-only differences: the content equals HEAD.
    const lines = await workingFileLines(path, maxBytes, "context");
    return "error" in lines ? lines : result("unmodified", lines);
  }
  return result(plan.status, parsed.lines);
}
