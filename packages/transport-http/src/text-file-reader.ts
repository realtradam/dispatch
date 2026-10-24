import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TEXT_FILE_MAX_BYTES, type TextFileError } from "./text-file-logic.js";

/** One descriptor from open through fstat/read: never reopen after validation. */
export async function readTextFileBytes(
  path: string,
): Promise<{ readonly bytes: Uint8Array } | TextFileError> {
  try {
    // NONBLOCK avoids hanging on FIFOs; NOCTTY avoids claiming terminals.
    // Reject final-component symlinks rather than racing a lstat/open pair.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) return { error: "Text file must be a regular file", status: 400 };
      if (info.size > TEXT_FILE_MAX_BYTES) {
        return { error: "Text file exceeds the 256 KiB size limit", status: 413 };
      }
      // Size is only an early check. Growth and size-zero pseudo-files still
      // cannot cause more than max+1 bytes of read work, allocation, or output.
      const bytes = new Uint8Array(TEXT_FILE_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > TEXT_FILE_MAX_BYTES || (await file.stat()).size > TEXT_FILE_MAX_BYTES) {
        return { error: "Text file exceeds the 256 KiB size limit", status: 413 };
      }
      return { bytes: bytes.subarray(0, length) };
    } finally {
      await file.close();
    }
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
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
}
