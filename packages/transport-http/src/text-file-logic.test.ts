import { describe, expect, it } from "vitest";
import {
  decodeTextFile,
  EXCALIDRAW_MAX_BYTES,
  isExcalidrawPath,
  isSupportedTextFilePath,
  parseTextFileQuery,
  parseTextFileWriteRequest,
  resolveTextFileContext,
  resolveTextFileRequest,
  TEXT_FILE_MAX_BYTES,
  textFileFormat,
  textFileMaxBytes,
  textFileSizeLimitError,
  textFileVersion,
  validateExcalidrawText,
} from "./text-file-logic.js";

describe("text-file pure policy", () => {
  it("formats a version and changes it when any stat field changes", () => {
    const stat = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
    expect(textFileVersion(stat)).toBe("1-2-3-4");
    for (const key of ["dev", "ino", "size", "mtimeNs"] as const) {
      expect(textFileVersion({ ...stat, [key]: stat[key] + 1n })).not.toBe(textFileVersion(stat));
    }
  });

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
    expect(decodeTextFile(new TextEncoder().encode(text), TEXT_FILE_MAX_BYTES)).toEqual({ text });
    expect(decodeTextFile(new Uint8Array(), TEXT_FILE_MAX_BYTES)).toEqual({ text: "" });
    expect(
      decodeTextFile(
        new TextEncoder().encode("a".repeat(TEXT_FILE_MAX_BYTES)),
        TEXT_FILE_MAX_BYTES,
      ),
    ).toEqual({
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
    expect(decodeTextFile(new Uint8Array(bytes), TEXT_FILE_MAX_BYTES)).toMatchObject({
      status: 400,
    });
  });

  it("rejects overflow, never truncates, and classifies Markdown by path only", () => {
    expect(
      decodeTextFile(new Uint8Array(TEXT_FILE_MAX_BYTES + 1), TEXT_FILE_MAX_BYTES),
    ).toMatchObject({ status: 413 });
    expect(textFileFormat("/a.MD")).toBe("markdown");
    expect(textFileFormat("/a.markdown")).toBe("markdown");
    expect(textFileFormat("/a.ts")).toBe("text");
    expect(textFileFormat("/a")).toBe("text");
  });
});

describe("per-path text-file size caps", () => {
  it("recognises Excalidraw paths case-insensitively and nothing else", () => {
    expect(isExcalidrawPath("/work/a.excalidraw")).toBe(true);
    expect(isExcalidrawPath("/work/A.EXCALIDRAW")).toBe(true);
    expect(isExcalidrawPath("/work/a.excalidraw.json")).toBe(false);
    expect(isExcalidrawPath("/work/a.md")).toBe(false);
    expect(isExcalidrawPath("/work/excalidraw")).toBe(false);
  });

  it("caps Excalidraw scenes at 16 MiB and every other path at 256 KiB", () => {
    expect(textFileMaxBytes("/a.excalidraw")).toBe(EXCALIDRAW_MAX_BYTES);
    expect(textFileMaxBytes("/A.Excalidraw")).toBe(16777216);
    expect(textFileMaxBytes("/a.md")).toBe(TEXT_FILE_MAX_BYTES);
    expect(textFileMaxBytes("/a.txt")).toBe(262144);
  });

  it("labels the size-limit error by cap", () => {
    expect(textFileSizeLimitError(EXCALIDRAW_MAX_BYTES)).toEqual({
      error: "Text file exceeds the 16 MiB size limit",
      status: 413,
    });
    expect(textFileSizeLimitError(TEXT_FILE_MAX_BYTES)).toEqual({
      error: "Text file exceeds the 256 KiB size limit",
      status: 413,
    });
  });
});

describe("text-file write request parsing", () => {
  const valid = { path: "scene.excalidraw", text: "{}", expectedVersion: "1-2-3-4" };

  it("accepts a minimal request and omits absent guards", () => {
    expect(parseTextFileWriteRequest(valid)).toEqual(valid);
  });

  it("accepts empty-string guards (asserting null) and keeps them", () => {
    expect(
      parseTextFileWriteRequest({ ...valid, expectedCwd: "", expectedComputerId: "" }),
    ).toEqual({ ...valid, expectedCwd: "", expectedComputerId: "" });
    expect(
      parseTextFileWriteRequest({ ...valid, expectedCwd: "/work", expectedComputerId: "ssh" }),
    ).toEqual({ ...valid, expectedCwd: "/work", expectedComputerId: "ssh" });
  });

  it.each([
    [null],
    [[]],
    ["body"],
    [42],
    [{ ...valid, extra: 1 }],
    [{}],
  ])("rejects non-object, array, string and unknown-field bodies %j", (body) => {
    expect(parseTextFileWriteRequest(body)).toMatchObject({ status: 400 });
  });

  it.each([
    "file:/tmp/a.excalidraw",
    "https://example.com/a.excalidraw",
    "~/a.excalidraw",
    "a\b.excalidraw",
    "a\u0000b.excalidraw",
    "",
  ])("rejects an unsupported literal path %j", (path) => {
    expect(parseTextFileWriteRequest({ ...valid, path })).toMatchObject({
      error: "Invalid text-file path",
      status: 400,
    });
  });

  it("rejects non-string text, missing/empty/oversized expectedVersion and non-string guards", () => {
    expect(parseTextFileWriteRequest({ ...valid, text: 1 })).toMatchObject({
      error: "Text-file write text must be a string",
    });
    expect(parseTextFileWriteRequest({ ...valid, expectedVersion: undefined })).toMatchObject({
      error: "Text-file write requires expectedVersion",
    });
    expect(parseTextFileWriteRequest({ ...valid, expectedVersion: "" })).toMatchObject({
      error: "Text-file write requires expectedVersion",
    });
    expect(parseTextFileWriteRequest({ ...valid, expectedVersion: "a".repeat(257) })).toMatchObject(
      { error: "Text-file write requires expectedVersion" },
    );
    expect(parseTextFileWriteRequest({ ...valid, expectedCwd: 1 })).toMatchObject({
      error: "Invalid text-file context guard",
    });
    expect(parseTextFileWriteRequest({ ...valid, expectedComputerId: null })).toMatchObject({
      error: "Invalid text-file context guard",
    });
  });
});

function scene(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [],
    appState: {},
    ...overrides,
  });
}

describe("Excalidraw text validation", () => {
  it("accepts a serialized scene and returns its UTF-8 bytes", () => {
    const text = scene({ elements: [{ id: "a" }] });
    const result = validateExcalidrawText(text, EXCALIDRAW_MAX_BYTES);
    expect(result).toEqual({ bytes: new TextEncoder().encode(text) });
  });

  it("rejects content over the cap before checking its shape", () => {
    const text = scene({ elements: [] });
    expect(validateExcalidrawText(text, 10)).toEqual(textFileSizeLimitError(10));
  });

  it("rejects lone surrogates as invalid UTF-8", () => {
    expect(
      validateExcalidrawText(`{"type":"excalidraw","elements":[],"x":"\ud800"}`, 1024),
    ).toMatchObject({ error: "Text file must be valid UTF-8", status: 400 });
  });

  it("rejects binary control characters", () => {
    expect(
      validateExcalidrawText(`{"type":"excalidraw","elements":[],"x":"\u0000"}`, 1024),
    ).toMatchObject({ error: "Text file contains binary control characters", status: 400 });
  });

  it.each([
    ["invalid JSON", "not json"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["the wrong type", JSON.stringify({ type: "other", elements: [] })],
    ["misshapen elements", JSON.stringify({ type: "excalidraw", elements: {} })],
  ])("rejects %s", (_label, text) => {
    expect(validateExcalidrawText(text, EXCALIDRAW_MAX_BYTES)).toMatchObject({
      error: "Text is not a valid Excalidraw scene",
      status: 400,
    });
  });
});
