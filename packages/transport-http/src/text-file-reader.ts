import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type TextFileError, textFileSizeLimitError, textFileVersion } from "./text-file-logic.js";

// NONBLOCK avoids hanging on FIFOs; NOCTTY avoids claiming terminals.
// Reject final-component symlinks rather than racing a lstat/open pair.
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY;

/** One descriptor from open through fstat/read: never reopen after validation. */
export async function readTextFileBytes(
  path: string,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly version: string } | TextFileError> {
  try {
    const file = await open(path, READ_FLAGS);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return { error: "Text file must be a regular file", status: 400 };
      if (info.size > BigInt(maxBytes)) return textFileSizeLimitError(maxBytes);
      const version = textFileVersion(info);
      // Size is only an early check. Growth and size-zero pseudo-files still
      // cannot cause more than max+1 bytes of read work, allocation, or output.
      const bytes = new Uint8Array(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes || (await file.stat()).size > maxBytes) {
        return textFileSizeLimitError(maxBytes);
      }
      return { bytes: bytes.subarray(0, length), version };
    } finally {
      await file.close();
    }
  } catch (error) {
    return mapTextFileError(error);
  }
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function mapTextFileError(error: unknown): TextFileError {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { error: "Text file not found", status: 404 };
  }
  if (code === "ELOOP") return { error: "Text-file symlinks are unsupported", status: 400 };
  if (code === "EACCES" || code === "EPERM") {
    return { error: "Text file is not readable", status: 403 };
  }
  if (code === "ENXIO" || code === "ENODEV") {
    return { error: "Text file must be a regular file", status: 400 };
  }
  return { error: "Failed to read text file", status: 500 };
}

export async function statTextFileVersion(
  path: string,
  maxBytes: number,
): Promise<{ readonly version: string } | TextFileError> {
  try {
    const file = await open(path, READ_FLAGS);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return { error: "Text file must be a regular file", status: 400 };
      if (info.size > BigInt(maxBytes)) return textFileSizeLimitError(maxBytes);
      return { version: textFileVersion(info) };
    } finally {
      await file.close();
    }
  } catch (error) {
    return mapTextFileError(error);
  }
}

/** A stale `expectedVersion` conflict, or an ordinary text-file error. */
export type TextFileWriteFailure =
  | TextFileError
  | { readonly conflict: true; readonly version: string };

function mapTextFileWriteError(error: unknown): TextFileError {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return { error: "Text file is not writable", status: 403 };
  }
  return { error: "Failed to write text file", status: 500 };
}

async function statTextFileForWrite(
  path: string,
): Promise<{ readonly version: string; readonly mode: number } | TextFileError> {
  try {
    const file = await open(path, READ_FLAGS);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return { error: "Text file must be a regular file", status: 400 };
      // An oversized existing file is fine here: it is being replaced, not read.
      return { version: textFileVersion(info), mode: Number(info.mode & 0o7777n) };
    } finally {
      await file.close();
    }
  } catch (error) {
    return mapTextFileError(error);
  }
}

/**
 * Conditionally and atomically replace an existing file: verify the version, write a
 * same-directory temp file with the original permission bits, flush, then rename over it.
 */
export async function writeTextFileAtomic(
  path: string,
  bytes: Uint8Array,
  expectedVersion: string,
): Promise<{ readonly version: string } | TextFileWriteFailure> {
  const current = await statTextFileForWrite(path);
  if ("error" in current) return current;
  if (current.version !== expectedVersion) return { conflict: true, version: current.version };
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.dispatch-tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      current.mode,
    );
    created = true;
    let written = 0;
    while (written < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        undefined,
      );
      if (bytesWritten <= 0) throw new Error("Text file write made no progress");
      written += bytesWritten;
    }
    await handle.sync();
    // O_CREAT applies the umask; restore the original bits exactly.
    await handle.chmod(current.mode);
    const version = textFileVersion(await handle.stat({ bigint: true }));
    await handle.close();
    handle = undefined;
    // Rename preserves dev/ino/size/mtime, so `version` is the live file's version.
    await rename(temp, path);
    return { version };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Best effort: the original failure is what matters.
      }
    }
    if (created) {
      try {
        await unlink(temp);
      } catch {
        // Best effort: the original failure is what matters.
      }
    }
    return mapTextFileWriteError(error);
  }
}
