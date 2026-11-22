import { describe, expect, it } from "vitest";
import {
  countDiffLines,
  type GitStatusSummary,
  parseGitStatus,
  parseUnifiedDiff,
  planTextFileDiff,
  splitTextLines,
  textFileDiffVersion,
  uniformDiffLines,
} from "./text-file-diff-logic.js";

const HEAD = "0fbeb3a70473abb02fc77fc4f282235c28a6d0b6";
const OID = "71ac1b5791204c80666ab1a4f9886b79e982739c";
const ZERO = "0000000000000000000000000000000000000000";
const bytes = (text: string) => new TextEncoder().encode(text);
function entryOf(output: string) {
  const parsed = parseGitStatus(output);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.entry;
}

describe("parseGitStatus", () => {
  it("keeps only branch.oid among headers and reads a clean path as no entry", () => {
    expect(
      parseGitStatus(
        `# branch.oid ${HEAD}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\0`,
      ),
    ).toEqual({ headCommit: HEAD, entry: null });
  });

  it("reads an unborn branch as a null head commit", () => {
    expect(parseGitStatus("# branch.oid (initial)\0# branch.head main\0? a.txt\0")).toEqual({
      headCommit: null,
      entry: { kind: "untracked", raw: "? a.txt" },
    });
  });

  it("classifies tracked entries by their HEAD object", () => {
    const modified = `1 .M N... 100644 100644 100644 ${OID} ${OID} f.txt`;
    const added = `1 A. N... 000000 100644 100644 ${ZERO} ${OID} new file.txt`;
    expect(entryOf(`${modified}\0`)).toEqual({
      kind: "tracked",
      inHead: true,
      raw: modified,
    });
    expect(entryOf(`${added}\0`)).toEqual({
      kind: "tracked",
      inHead: false,
      raw: added,
    });
  });

  it("treats a conflict as tracked-in-HEAD and an ignored path as ignored", () => {
    const unmerged = `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} f.txt`;
    expect(entryOf(`${unmerged}\0`)).toEqual({
      kind: "tracked",
      inHead: true,
      raw: unmerged,
    });
    expect(entryOf("! node_modules/\0")).toEqual({
      kind: "ignored",
      raw: "! node_modules/",
    });
  });

  it("rejects multiple, unsupported and malformed entries", () => {
    expect(parseGitStatus("? a\0? b\0")).toEqual({ error: expect.any(String) });
    expect(parseGitStatus("2 R. N... 100644 100644 100644 a b R100 x\0y\0")).toEqual({
      error: expect.any(String),
    });
    expect(parseGitStatus("1 .M N...\0")).toEqual({ error: expect.any(String) });
  });
});

describe("planTextFileDiff", () => {
  const status = (entry: GitStatusSummary["entry"], headCommit: string | null = HEAD) => ({
    headCommit,
    entry,
  });
  const tracked = (inHead: boolean) => ({ kind: "tracked" as const, inHead, raw: "1" });

  it("reads files outside a repository as context, or 404 when missing", () => {
    expect(planTextFileDiff({ inRepo: false, workingExists: true, status: null })).toEqual({
      source: "working-file",
      status: "not-in-repo",
      kind: "context",
    });
    expect(planTextFileDiff({ inRepo: false, workingExists: false, status: null })).toBeNull();
  });

  it("maps clean, ignored and untracked paths to working-file reads", () => {
    const plan = (entry: GitStatusSummary["entry"], workingExists = true) =>
      planTextFileDiff({ inRepo: true, workingExists, status: status(entry) });
    expect(plan(null)).toEqual({ source: "working-file", status: "unmodified", kind: "context" });
    expect(plan({ kind: "ignored", raw: "!" })).toEqual({
      source: "working-file",
      status: "ignored",
      kind: "context",
    });
    expect(plan({ kind: "untracked", raw: "?" })).toEqual({
      source: "working-file",
      status: "untracked",
      kind: "added",
    });
    expect(plan(null, false)).toBeNull();
    expect(plan({ kind: "ignored", raw: "!" }, false)).toBeNull();
    expect(plan({ kind: "untracked", raw: "?" }, false)).toBeNull();
  });

  it("diffs tracked paths against HEAD", () => {
    const plan = (inHead: boolean, workingExists: boolean, head: string | null = HEAD) =>
      planTextFileDiff({ inRepo: true, workingExists, status: status(tracked(inHead), head) });
    expect(plan(true, true)).toEqual({ source: "git-diff", status: "modified" });
    expect(plan(true, false)).toEqual({ source: "git-diff", status: "deleted" });
    expect(plan(false, true)).toEqual({ source: "git-diff", status: "added" });
    expect(plan(false, false)).toBeNull();
    expect(plan(false, true, null)).toEqual({
      source: "working-file",
      status: "added",
      kind: "added",
    });
    expect(plan(false, false, null)).toBeNull();
  });
});

describe("textFileDiffVersion", () => {
  it("changes with each input and is stable otherwise", () => {
    const base = {
      fileVersion: "1-2-3-4",
      repoRoot: "/repo",
      status: { headCommit: HEAD, entry: null },
    };
    const version = textFileDiffVersion(base);
    expect(textFileDiffVersion({ ...base })).toBe(version);
    expect(textFileDiffVersion({ ...base, fileVersion: null })).not.toBe(version);
    expect(textFileDiffVersion({ ...base, repoRoot: null, status: null })).not.toBe(version);
    expect(textFileDiffVersion({ ...base, status: { headCommit: OID, entry: null } })).not.toBe(
      version,
    );
    expect(
      textFileDiffVersion({ ...base, status: { headCommit: HEAD, entry: tracked() } }),
    ).not.toBe(version);
  });
  function tracked() {
    return { kind: "tracked" as const, inHead: true, raw: "1 .M" };
  }
});

describe("line helpers", () => {
  it("splits on newline terminators only, keeping CR and a final unterminated line", () => {
    expect(splitTextLines("")).toEqual([]);
    expect(splitTextLines("\n")).toEqual([""]);
    expect(splitTextLines("a\r\nb")).toEqual(["a\r", "b"]);
    expect(splitTextLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("numbers uniform lines per kind and counts changes", () => {
    const context = uniformDiffLines("a\nb\n", "context");
    expect(context).toEqual([
      { kind: "context", text: "a", oldLine: 1, newLine: 1 },
      { kind: "context", text: "b", oldLine: 2, newLine: 2 },
    ]);
    const added = uniformDiffLines("a", "added");
    expect(added).toEqual([{ kind: "added", text: "a", oldLine: null, newLine: 1 }]);
    expect(countDiffLines([...context, ...added])).toEqual({ added: 1, removed: 0 });
    expect(countDiffLines([{ kind: "removed", text: "x", oldLine: 1, newLine: null }])).toEqual({
      added: 0,
      removed: 1,
    });
  });
});

describe("parseUnifiedDiff", () => {
  const header = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n";

  it("parses a whole-file hunk with replaced and appended lines", () => {
    const parsed = parseUnifiedDiff(bytes(`${header}@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n`), 100);
    expect(parsed).toEqual({
      hasHunks: true,
      oldBytes: 6,
      lines: [
        { kind: "context", text: "a", oldLine: 1, newLine: 1 },
        { kind: "removed", text: "b", oldLine: 2, newLine: null },
        { kind: "added", text: "B", oldLine: null, newLine: 2 },
        { kind: "context", text: "c", oldLine: 3, newLine: 3 },
        { kind: "added", text: "d", oldLine: null, newLine: 4 },
      ],
    });
  });

  it("keeps header-looking content lines, skips no-newline markers and handles empty sides", () => {
    const body =
      "@@ -1,2 +0,0 @@\n---- a\n-+++ b\n\\ No newline at end of file\n" +
      "diff --git a/g b/g\n@@ -0,0 +1 @@\n+@@ -1 +1 @@\n";
    const parsed = parseUnifiedDiff(bytes(`${header}${body}`), 100);
    expect(parsed).toMatchObject({
      hasHunks: true,
      lines: [
        { kind: "removed", text: "--- a", oldLine: 1, newLine: null },
        { kind: "removed", text: "+++ b", oldLine: 2, newLine: null },
        { kind: "added", text: "@@ -1 +1 @@", oldLine: null, newLine: 1 },
      ],
    });
  });

  it("reports no hunks for header-only or empty output", () => {
    expect(parseUnifiedDiff(bytes(""), 10)).toEqual({ lines: [], oldBytes: 0, hasHunks: false });
    expect(parseUnifiedDiff(bytes("diff --git a/f b/f\nold mode 100644\n"), 10)).toEqual({
      lines: [],
      oldBytes: 0,
      hasHunks: false,
    });
  });

  it("rejects binary, invalid UTF-8, control characters, malformed and truncated diffs", () => {
    expect(parseUnifiedDiff(bytes(`${header}Binary files a/f and b/f differ\n`), 100)).toEqual({
      error: expect.any(String),
      status: 400,
    });
    expect(parseUnifiedDiff(bytes("GIT binary patch\n"), 100)).toMatchObject({ status: 400 });
    expect(parseUnifiedDiff(new Uint8Array([0x40, 0xff]), 100)).toMatchObject({ status: 400 });
    expect(parseUnifiedDiff(bytes("@@ -1 +1 @@\n-a\u0000\n+b\n"), 100)).toMatchObject({
      status: 400,
    });
    expect(parseUnifiedDiff(bytes("@@ -1 +1 @@\n?a\n"), 100)).toMatchObject({ status: 400 });
    expect(parseUnifiedDiff(bytes("@@ -1 +1 @@\n+a\n+b\n"), 100)).toMatchObject({ status: 400 });
    expect(parseUnifiedDiff(bytes("@@ -1,2 +1,2 @@\n a\n"), 100)).toMatchObject({ status: 400 });
  });

  it("caps the HEAD side at maxBytes, tolerating a missing final newline", () => {
    const diff = bytes("@@ -1,2 +0,0 @@\n-abcd\n-efgh\n\\ No newline at end of file\n");
    expect(parseUnifiedDiff(diff, 9)).toMatchObject({ hasHunks: true });
    expect(parseUnifiedDiff(diff, 8)).toMatchObject({ status: 413 });
  });
});
