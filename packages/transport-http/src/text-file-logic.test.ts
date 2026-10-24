import { describe, expect, it } from "vitest";
import {
  decodeTextFile,
  isSupportedTextFilePath,
  parseTextFileQuery,
  resolveTextFileContext,
  resolveTextFileRequest,
  TEXT_FILE_MAX_BYTES,
  textFileFormat,
} from "./text-file-logic.js";

describe("text-file pure policy", () => {
  it.each([
    "",
    "file:/tmp/plan.md",
    "https://example.com/x",
    "data:text/plain,a",
    "~/plan",
    "//server/file",
    "C:/windows",
    "a\\b",
    "a\u0000b",
    "a\nb",
    "a\u0085b",
    "\ud800",
  ])("rejects unsupported literal path %j", (path) => {
    expect(isSupportedTextFilePath(path)).toBe(false);
  });

  it("preserves spaces, literal percent sequences, Unicode and dot segments", () => {
    for (const path of ["/plans/a b%20.md", "../plan.md", "计划😀.md", "./a:b"])
      expect(isSupportedTextFilePath(path)).toBe(true);
    expect(parseTextFileQuery(new URLSearchParams({ path: "/a b%20%2F.md" }))).toEqual({
      path: "/a b%20%2F.md",
    });
  });

  it.each([
    "path=a&path=b",
    "path=a&cwd=/tmp",
    "path=a&expectedCwd=x",
    "path=a&expectedCwd=/a&expectedCwd=/a",
    "path=a&expectedComputerId=ssh%3Ahost",
    "path=a&expectedComputerId=a%0Ab",
  ])("rejects malformed query %s", (query) => {
    expect(parseTextFileQuery(new URLSearchParams(query))).toMatchObject({ status: 400 });
  });

  it("supports omitted and empty-null guards, mismatches, and remote refusal", () => {
    expect(
      parseTextFileQuery(new URLSearchParams("path=plan.md&expectedCwd=&expectedComputerId=")),
    ).toEqual({ path: "plan.md", expectedCwd: "", expectedComputerId: "" });
    expect(
      resolveTextFileRequest({ path: "../a.md" }, { cwd: "/work/sub", computerId: null }),
    ).toEqual({ path: "/work/a.md" });
    expect(
      resolveTextFileRequest({ path: "/a", expectedCwd: "" }, { cwd: null, computerId: null }),
    ).toEqual({ path: "/a" });
    expect(
      resolveTextFileRequest(
        { path: "/a", expectedComputerId: "" },
        { cwd: null, computerId: "ssh" },
      ),
    ).toMatchObject({ status: 409 });
    expect(
      resolveTextFileRequest(
        { path: "/a", expectedComputerId: "ssh" },
        { cwd: null, computerId: "ssh" },
      ),
    ).toMatchObject({ status: 422 });
    expect(resolveTextFileRequest({ path: "a" }, { cwd: null, computerId: null })).toMatchObject({
      status: 400,
    });
  });

  it("resolves only configured absolute cwd or relative cwd against absolute workspace cwd", () => {
    const base = { cwd: null, defaultCwd: null, computerId: null, defaultComputerId: null };
    expect(resolveTextFileContext(base)).toEqual({ cwd: null, computerId: null });
    expect(resolveTextFileContext({ ...base, cwd: "sub" })).toMatchObject({ status: 422 });
    expect(resolveTextFileContext({ ...base, defaultCwd: "relative" })).toMatchObject({
      status: 422,
    });
    expect(
      resolveTextFileContext({
        ...base,
        cwd: "sub/../plan",
        defaultCwd: "/work",
        defaultComputerId: "ssh",
      }),
    ).toEqual({ cwd: "/work/plan", computerId: "ssh" });
    expect(
      resolveTextFileContext({
        ...base,
        cwd: "/explicit",
        defaultCwd: "/work",
        computerId: "first",
        defaultComputerId: "second",
      }),
    ).toEqual({ cwd: "/explicit", computerId: "first" });
  });

  it("decodes complete strict UTF-8 without losing a BOM; accepts empty files and ordinary whitespace", () => {
    const text = "\ufeff计划\tline\r\n";
    expect(decodeTextFile(new TextEncoder().encode(text))).toEqual({ text });
    expect(decodeTextFile(new Uint8Array())).toEqual({ text: "" });
    expect(decodeTextFile(new TextEncoder().encode("a".repeat(TEXT_FILE_MAX_BYTES)))).toEqual({
      text: "a".repeat(TEXT_FILE_MAX_BYTES),
    });
  });

  it.each([
    [0],
    [27],
    [127],
    [194, 133],
    [255],
    [195],
    [192, 175],
  ])("rejects invalid UTF-8 or binary controls %j", (...bytes) => {
    expect(decodeTextFile(new Uint8Array(bytes))).toMatchObject({ status: 400 });
  });

  it("rejects overflow, never truncates, and classifies Markdown by path only", () => {
    expect(decodeTextFile(new Uint8Array(TEXT_FILE_MAX_BYTES + 1))).toMatchObject({ status: 413 });
    expect(textFileFormat("/a.MD")).toBe("markdown");
    expect(textFileFormat("/a.markdown")).toBe("markdown");
    expect(textFileFormat("/a.ts")).toBe("text");
    expect(textFileFormat("/a")).toBe("text");
  });
});
