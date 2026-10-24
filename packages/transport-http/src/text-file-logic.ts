import { posix } from "node:path";
import type { TextFileQuery } from "@dispatch/transport-contract";

export const TEXT_FILE_MAX_BYTES = 262144;

export interface TextFileError {
  readonly error: string;
  readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 500;
}

export interface TextFileContext {
  readonly cwd: string | null;
  readonly computerId: string | null;
}

function hasControls(value: string, allowWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowWhitespace && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

/** Literal POSIX names only. Do not URL-decode here: URLSearchParams already did. */
export function isSupportedTextFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !hasControls(value) &&
    !value.includes("\\") &&
    !value.startsWith("~") &&
    !value.startsWith("//") &&
    !/^[a-z][a-z\d+.-]*:/iu.test(value) &&
    !/[\ud800-\udfff]/u.test(value)
  );
}

export function parseTextFileQuery(query: URLSearchParams): TextFileQuery | TextFileError {
  const allowed = new Set(["path", "expectedCwd", "expectedComputerId"]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) {
      return { error: "Unexpected or duplicate text-file query parameter", status: 400 };
    }
  }
  const path = query.get("path");
  if (path === null || !isSupportedTextFilePath(path)) {
    return { error: "A supported literal POSIX file path is required", status: 400 };
  }
  const expectedCwd = query.get("expectedCwd");
  if (
    expectedCwd !== null &&
    expectedCwd !== "" &&
    (!isSupportedTextFilePath(expectedCwd) || !posix.isAbsolute(expectedCwd))
  ) {
    return { error: "expectedCwd must be an absolute POSIX directory or empty", status: 400 };
  }
  const expectedComputerId = query.get("expectedComputerId");
  if (
    expectedComputerId !== null &&
    (expectedComputerId.length > 255 ||
      (expectedComputerId !== "" && !/^[a-z\d_.-]+$/iu.test(expectedComputerId)))
  ) {
    return { error: "expectedComputerId must be a computer alias or empty", status: 400 };
  }
  return {
    path,
    ...(expectedCwd !== null ? { expectedCwd } : {}),
    ...(expectedComputerId !== null ? { expectedComputerId } : {}),
  };
}

/** Deliberately NOT getEffectiveCwd: that contract has a process-cwd fallback. */
export function resolveTextFileContext(input: {
  readonly cwd: string | null;
  readonly defaultCwd: string | null;
  readonly computerId: string | null;
  readonly defaultComputerId: string | null;
}): TextFileContext | TextFileError {
  const computerId = input.computerId ?? input.defaultComputerId;
  const selected = input.cwd ?? input.defaultCwd;
  if (selected === null) return { cwd: null, computerId };
  if (!isSupportedTextFilePath(selected)) {
    return { error: "Conversation working directory is unsupported", status: 422 };
  }
  if (posix.isAbsolute(selected)) return { cwd: posix.normalize(selected), computerId };
  if (
    input.cwd !== null &&
    input.defaultCwd !== null &&
    isSupportedTextFilePath(input.defaultCwd) &&
    posix.isAbsolute(input.defaultCwd)
  ) {
    return { cwd: posix.resolve(input.defaultCwd, selected), computerId };
  }
  return { error: "Relative conversation cwd requires an absolute workspace cwd", status: 422 };
}

export function resolveTextFileRequest(
  query: TextFileQuery,
  context: TextFileContext,
): { readonly path: string } | TextFileError {
  if (
    (query.expectedCwd !== undefined && query.expectedCwd !== (context.cwd ?? "")) ||
    (query.expectedComputerId !== undefined &&
      query.expectedComputerId !== (context.computerId ?? ""))
  ) {
    return { error: "Conversation file context changed; refresh and retry", status: 409 };
  }
  if (context.computerId !== null) {
    return { error: "Text-file embeds do not support remote computers", status: 422 };
  }
  if (posix.isAbsolute(query.path)) return { path: posix.normalize(query.path) };
  if (context.cwd === null) {
    return { error: "Relative file paths require a configured conversation cwd", status: 400 };
  }
  return { path: posix.resolve(context.cwd, query.path) };
}

export function decodeTextFile(bytes: Uint8Array): { readonly text: string } | TextFileError {
  if (bytes.byteLength > TEXT_FILE_MAX_BYTES) {
    return { error: "Text file exceeds the 256 KiB size limit", status: 413 };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { error: "Text file must be valid UTF-8", status: 400 };
  }
  if (hasControls(text, true)) {
    return { error: "Text file contains binary control characters", status: 400 };
  }
  return { text };
}

export function textFileFormat(path: string): "markdown" | "text" {
  return /\.(md|markdown|mdown|mkd|mkdn)$/iu.test(path) ? "markdown" : "text";
}
