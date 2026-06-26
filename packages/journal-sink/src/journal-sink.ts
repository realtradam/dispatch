import { closeSync, fsyncSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import type { LogRecord, LogSink } from "@dispatch/kernel";

// --- Pure core (no I/O) ---

/**
 * Serialize a LogRecord to exactly one NDJSON line (record JSON + newline).
 * Pure function — no I/O, no side effects.
 */
export function serialize(record: LogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

// --- Imperative shell (fs edge) ---

/** Injectable fs operations — confined to the edge. */
export interface FsOps {
  readonly open: (path: string) => number;
  readonly write: (fd: number, data: string) => void;
  readonly close: (fd: number) => void;
  readonly rename: (oldPath: string, newPath: string) => void;
  readonly statSize: (path: string) => number;
  readonly fsync: (fd: number) => void;
}

/** Clock injection for fsync interval. */
export interface ClockOps {
  readonly now: () => number;
}

export interface JournalSinkOpts {
  readonly path: string;
  readonly maxBytes?: number;
  readonly fsync?: "periodic" | "none";
  readonly fs?: FsOps;
  readonly clock?: ClockOps;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const FSYNC_INTERVAL_MS = 5_000; // 5 seconds

/**
 * Create a LogSink that durably appends each record to the journal file
 * as one NDJSON line. Fail-safe: write errors drop + warn, never throw.
 * Rotates when file exceeds maxBytes (rename → .1, reopen fresh).
 */
export function createJournalSink(opts: JournalSinkOpts): LogSink {
  const filePath = opts.path;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const syncMode = opts.fsync ?? "periodic";
  const fs = opts.fs ?? createDefaultFsOps();
  const clock = opts.clock ?? { now: () => Date.now() };

  const NO_FD = -1;
  let fd: number;
  let bytesWritten: number;
  try {
    fd = fs.open(filePath);
    bytesWritten = fs.statSize(filePath);
  } catch {
    fd = NO_FD;
    bytesWritten = 0;
  }
  let lastFsyncAt = clock.now();

  function tryOpen(): boolean {
    if (fd !== NO_FD) return true;
    try {
      fd = fs.open(filePath);
      bytesWritten = 0;
      return true;
    } catch {
      return false;
    }
  }

  function rotate(): void {
    if (fd !== NO_FD) {
      try {
        fs.close(fd);
      } catch {
        // Ignore close errors during rotation.
      }
    }
    const rotatedPath = `${filePath}.1`;
    try {
      fs.rename(filePath, rotatedPath);
    } catch {
      // If rename fails, just truncate by reopening.
    }
    try {
      fd = fs.open(filePath);
    } catch {
      fd = NO_FD;
    }
    bytesWritten = 0;
  }

  function maybeFsync(): void {
    if (syncMode !== "periodic" || fd === NO_FD) return;
    const now = clock.now();
    if (now - lastFsyncAt >= FSYNC_INTERVAL_MS) {
      try {
        fs.fsync(fd);
      } catch {
        // Swallow — fail-safe.
      }
      lastFsyncAt = now;
    }
  }

  const sink: LogSink = {
    emit(record: LogRecord): void {
      try {
        if (!tryOpen()) {
          console.warn("[journal-sink] cannot open journal, dropping record");
          return;
        }

        const line = serialize(record);
        const lineBytes = Buffer.byteLength(line, "utf8");

        if (bytesWritten + lineBytes > maxBytes) {
          rotate();
          if (fd === NO_FD) {
            console.warn("[journal-sink] rotation failed, dropping record");
            return;
          }
        }

        fs.write(fd, line);
        bytesWritten += lineBytes;
        maybeFsync();
      } catch (err) {
        // Fail-safe: drop + warn, never throw to the caller (D3/D7).
        console.warn("[journal-sink] write failed, dropping record:", err);
      }
    },
  };

  return sink;
}

// --- Default fs ops (real Bun/Node I/O) ---

function createDefaultFsOps(): FsOps {
  return {
    open(path: string): number {
      return openSync(path, "a");
    },
    write(fd: number, data: string): void {
      writeSync(fd, data);
    },
    close(fd: number): void {
      closeSync(fd);
    },
    rename(oldPath: string, newPath: string): void {
      renameSync(oldPath, newPath);
    },
    statSize(path: string): number {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    },
    fsync(fd: number): void {
      fsyncSync(fd);
    },
  };
}
