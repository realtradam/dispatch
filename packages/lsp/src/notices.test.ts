import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import {
  baselineFromIssues,
  diffNewIssues,
  displayPath,
  formatNotice,
  issueCounts,
} from "./notices.js";

function diag(overrides: Partial<Diagnostic> & { message: string }): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    ...overrides,
  };
}

describe("issueCounts", () => {
  it("counts by (severity, source, code, message), ignoring ranges", () => {
    const a = diag({
      message: "boom",
      severity: 1,
      source: "ts",
      code: 2322,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    });
    // Same issue, shifted two lines down: must count as the SAME identity.
    const b = diag({
      message: "boom",
      severity: 1,
      source: "ts",
      code: 2322,
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
    });
    const counts = issueCounts([a, b]);
    expect(counts.size).toBe(1);
    expect([...counts.values()]).toEqual([2]);
  });

  it("ignores info (3) and hint (4) severities", () => {
    const counts = issueCounts([
      diag({ message: "info", severity: 3 }),
      diag({ message: "hint", severity: 4 }),
      diag({ message: "err", severity: 1 }),
    ]);
    expect(counts.size).toBe(1);
  });

  it("distinguishes issues differing only by source, code, or message", () => {
    const counts = issueCounts([
      diag({ message: "m", source: "a" }),
      diag({ message: "m", source: "b" }),
      diag({ message: "m", source: "a", code: "X" }),
      diag({ message: "n", source: "a" }),
    ]);
    expect(counts.size).toBe(4);
  });
});

describe("diffNewIssues", () => {
  it("first check of a file: every error/warning is new", () => {
    const result = diffNewIssues(new Map(), [
      diag({ message: "e1", severity: 1 }),
      diag({ message: "e2", severity: 1 }),
      diag({ message: "w1", severity: 2 }),
      diag({ message: "i1", severity: 3 }),
    ]);
    expect(result.newErrors).toBe(2);
    expect(result.newWarnings).toBe(1);
    // Nothing was announced yet, so the lowered baseline stays empty; the
    // caller commits `baselineFromIssues` only once the notice is delivered.
    expect(result.nextBaseline.size).toBe(0);
    expect(baselineFromIssues([diag({ message: "e1" })]).size).toBe(1);
  });

  it("same issues after a line shift are NOT new", () => {
    const before = [
      diag({
        message: "Cannot find name 'x'.",
        severity: 1,
        source: "typescript",
        code: 2304,
      }),
    ];
    const baseline = baselineFromIssues(before);
    const after = [
      diag({
        message: "Cannot find name 'x'.",
        severity: 1,
        source: "typescript",
        code: 2304,
        range: { start: { line: 40, character: 2 }, end: { line: 40, character: 3 } },
      }),
    ];
    const result = diffNewIssues(baseline, after);
    expect(result.newErrors).toBe(0);
    expect(result.newWarnings).toBe(0);
    expect(result.nextBaseline.get([...baseline.keys()][0] as string)).toBe(1);
  });

  it("one extra copy of an existing message is exactly one new issue", () => {
    const baseline = baselineFromIssues([diag({ message: "same" })]);
    const result = diffNewIssues(baseline, [diag({ message: "same" }), diag({ message: "same" })]);
    expect(result.newErrors).toBe(1);
    expect(result.nextBaseline.get([...baseline.keys()][0] as string)).toBe(1);
  });

  it("an issue that disappears lowers the baseline; when it comes back it is new again", () => {
    const baseline = baselineFromIssues([diag({ message: "comes and goes" })]);

    // The check that sees it gone reports nothing new and empties the baseline.
    const gone = diffNewIssues(baseline, []);
    expect(gone.newErrors).toBe(0);
    expect(gone.nextBaseline.size).toBe(0);

    // Reappearing after a check without it counts as new.
    const back = diffNewIssues(gone.nextBaseline, [diag({ message: "comes and goes" })]);
    expect(back.newErrors).toBe(1);
  });

  it("losing one of two identical copies reports nothing new", () => {
    const baseline = baselineFromIssues([diag({ message: "dup" }), diag({ message: "dup" })]);
    const result = diffNewIssues(baseline, [diag({ message: "dup" })]);
    expect(result.newErrors).toBe(0);
    // The baseline is lowered to the surviving copy.
    expect([...result.nextBaseline.values()]).toEqual([1]);
  });

  it("info/hint issues never count as new and never enter the baseline", () => {
    const result = diffNewIssues(new Map(), [
      diag({ message: "info", severity: 3 }),
      diag({ message: "hint", severity: 4 }),
    ]);
    expect(result.newErrors).toBe(0);
    expect(result.newWarnings).toBe(0);
    expect(result.nextBaseline.size).toBe(0);
  });

  it("warnings are counted separately from errors", () => {
    const result = diffNewIssues(new Map(), [
      diag({ message: "w", severity: 2 }),
      diag({ message: "w", severity: 2 }),
    ]);
    expect(result.newErrors).toBe(0);
    expect(result.newWarnings).toBe(2);
  });
});

describe("formatNotice", () => {
  it("formats counts, paths relative to cwd, and the pointer to the lsp tool", () => {
    const text = formatNotice(
      [{ filePath: "/proj/packages/foo/src/bar.ts", newErrors: 2, newWarnings: 1 }],
      "/proj",
    );
    expect(text).toBe(
      [
        "[LSP] New issues detected:",
        "- packages/foo/src/bar.ts: 2 new errors, 1 new warning",
        'Call the `lsp` tool with operation "diagnostics" and the file path to read the full report.',
      ].join("\n"),
    );
  });

  it("pluralizes one vs many and omits zero categories", () => {
    expect(formatNotice([{ filePath: "/p/a.ts", newErrors: 1, newWarnings: 0 }], "/p")).toContain(
      "- a.ts: 1 new error",
    );
    expect(formatNotice([{ filePath: "/p/a.ts", newErrors: 0, newWarnings: 3 }], "/p")).toContain(
      "- a.ts: 3 new warnings",
    );
  });

  it("lists multiple files sorted by path, skipping files with nothing new", () => {
    const text = formatNotice(
      [
        { filePath: "/p/z.ts", newErrors: 1, newWarnings: 0 },
        { filePath: "/p/a.ts", newErrors: 0, newWarnings: 2 },
        { filePath: "/p/clean.ts", newErrors: 0, newWarnings: 0 },
      ],
      "/p",
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe("- a.ts: 2 new warnings");
    expect(lines[2]).toBe("- z.ts: 1 new error");
    expect(text).not.toContain("clean.ts");
  });

  it("renders a path outside cwd as-is", () => {
    expect(
      formatNotice([{ filePath: "/other/x.ts", newErrors: 1, newWarnings: 0 }], "/p"),
    ).toContain("- /other/x.ts: 1 new error");
  });

  it("returns an empty string when nothing is new", () => {
    expect(formatNotice([], "/p")).toBe("");
    expect(formatNotice([{ filePath: "/p/a.ts", newErrors: 0, newWarnings: 0 }], "/p")).toBe("");
  });
});

describe("displayPath", () => {
  it("relativizes a path inside cwd", () => {
    expect(displayPath("/p/src/a.ts", "/p")).toBe("src/a.ts");
  });

  it("leaves a path outside cwd absolute", () => {
    expect(displayPath("/q/a.ts", "/p")).toBe("/q/a.ts");
  });

  it("passes through relative inputs unchanged", () => {
    expect(displayPath("src/a.ts", "/p")).toBe("src/a.ts");
  });
});
