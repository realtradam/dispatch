import { posix } from "node:path";
import type { TextFileQuery, TextFileWriteRequest } from "@dispatch/transport-contract";

export const TEXT_FILE_MAX_BYTES = 262144;
export const EXCALIDRAW_MAX_BYTES = 16777216;

/** Excalidraw scenes (case-insensitive); the only writable text-file kind. */
export function isExcalidrawPath(path: string): boolean {
  return /\.excalidraw$/iu.test(path);
}

/** Per-path size cap: 16 MiB for Excalidraw scenes (embedded data URLs), else 256 KiB. */
export function textFileMaxBytes(path: string): number {
  return isExcalidrawPath(path) ? EXCALIDRAW_MAX_BYTES : TEXT_FILE_MAX_BYTES;
}

/** Human label for a cap, e.g. 16777216 -> "16 MiB", 262144 -> "256 KiB". */
export function textFileSizeLimitError(maxBytes: number): TextFileError {
  const label = maxBytes % 1048576 === 0 ? `${maxBytes / 1048576} MiB` : `${maxBytes / 1024} KiB`;
  return { error: `Text file exceeds the ${label} size limit`, status: 413 };
}

/** Stat fields that define a text file's version (from a bigint `fstat`). */
export interface TextFileStatVersion {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

/** Opaque version string: `${dev}-${ino}-${size}-${mtimeNs}` in decimal. Pure. */
export function textFileVersion(stat: TextFileStatVersion): string {
  return `${stat.dev}-${stat.ino}-${stat.size}-${stat.mtimeNs}`;
}

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

export function decodeTextFile(
  bytes: Uint8Array,
  maxBytes: number,
): { readonly text: string } | TextFileError {
  if (bytes.byteLength > maxBytes) return textFileSizeLimitError(maxBytes);
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

const WRITE_FIELDS = new Set([
  "path",
  "text",
  "expectedVersion",
  "expectedCwd",
  "expectedComputerId",
]);

export function parseTextFileWriteRequest(body: unknown): TextFileWriteRequest | TextFileError {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Text-file write body must be a JSON object", status: 400 };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !WRITE_FIELDS.has(key))) {
    return { error: "Unexpected text-file write field", status: 400 };
  }
  const path = record.path;
  if (typeof path !== "string" || !isSupportedTextFilePath(path)) {
    return { error: "Invalid text-file path", status: 400 };
  }
  const text = record.text;
  if (typeof text !== "string") {
    return { error: "Text-file write text must be a string", status: 400 };
  }
  const expectedVersion = record.expectedVersion;
  if (
    typeof expectedVersion !== "string" ||
    expectedVersion.length === 0 ||
    expectedVersion.length > 256
  ) {
    return { error: "Text-file write requires expectedVersion", status: 400 };
  }
  const expectedCwd = record.expectedCwd;
  const expectedComputerId = record.expectedComputerId;
  if (
    (expectedCwd !== undefined && typeof expectedCwd !== "string") ||
    (expectedComputerId !== undefined && typeof expectedComputerId !== "string")
  ) {
    return { error: "Invalid text-file context guard", status: 400 };
  }
  return {
    path,
    text,
    expectedVersion,
    ...(expectedCwd !== undefined ? { expectedCwd } : {}),
    ...(expectedComputerId !== undefined ? { expectedComputerId } : {}),
  };
}

/** Validates a whole-file Excalidraw serialization; order: surrogates, size, controls, JSON. */
export function validateExcalidrawText(
  text: string,
  maxBytes: number,
): { readonly bytes: Uint8Array } | TextFileError {
  if (/[\ud800-\udfff]/u.test(text)) {
    return { error: "Text file must be valid UTF-8", status: 400 };
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) return textFileSizeLimitError(maxBytes);
  if (hasControls(text, true)) {
    return { error: "Text file contains binary control characters", status: 400 };
  }
  let scene: unknown;
  try {
    scene = JSON.parse(text);
  } catch {
    return { error: "Text is not a valid Excalidraw scene", status: 400 };
  }
  if (
    scene === null ||
    typeof scene !== "object" ||
    Array.isArray(scene) ||
    (scene as { type?: unknown }).type !== "excalidraw" ||
    !Array.isArray((scene as { elements?: unknown }).elements)
  ) {
    return { error: "Text is not a valid Excalidraw scene", status: 400 };
  }
  return { bytes };
}
