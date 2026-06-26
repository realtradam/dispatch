import type { LogRecord } from "@dispatch/kernel";
import type { TraceStore } from "@dispatch/trace-store";

// --- Pure core (no I/O) ---

export function shouldPrune(now: number, lastPruneAt: number, intervalMs: number): boolean {
  return now - lastPruneAt >= intervalMs;
}

export interface Logger {
  readonly info: (...args: readonly unknown[]) => void;
  readonly debug: (...args: readonly unknown[]) => void;
}

export function splitLines(buffer: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === "\n") {
      lines.push(buffer.slice(start, i));
      start = i + 1;
    }
  }

  const remainder = buffer.slice(start);
  return { lines, remainder };
}

// --- Drain step (the unit of work) ---

export interface DrainOpts {
  readonly journalPath: string;
  readonly offset: number;
  readonly store: TraceStore;
}

export interface DrainResult {
  readonly newOffset: number;
}

/**
 * Read bytes from offset to EOF, split into NDJSON lines, parse each
 * complete line into a LogRecord, skip + warn on malformed lines,
 * insert the batch into the store, return the new offset past the
 * consumed complete lines (excluding any held remainder).
 */
export function drainOnce(opts: DrainOpts): DrainResult {
  const { journalPath, offset, store } = opts;

  let content: string;
  try {
    content = readFileFromOffset(journalPath, offset);
  } catch {
    return { newOffset: offset };
  }

  if (content.length === 0) {
    return { newOffset: offset };
  }

  const { lines } = splitLines(content);

  if (lines.length === 0) {
    return { newOffset: offset };
  }

  const records: LogRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: LogRecord = JSON.parse(trimmed);
      records.push(parsed);
    } catch (err) {
      console.warn("[observability-collector] skipping malformed line:", err);
    }
  }

  if (records.length > 0) {
    store.insertRecords(records);
  }

  const consumedBytes = Buffer.byteLength(
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    "utf8",
  );
  return { newOffset: offset + consumedBytes };
}

// --- Offset persistence ---

/**
 * Read the resume offset from a sidecar file. Returns 0 if missing.
 */
export function readOffset(sidecarPath: string): number {
  try {
    const content = readFileUtf8(sidecarPath).trim();
    const parsed = Number(content);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist the resume offset to a sidecar file.
 */
export function writeOffset(sidecarPath: string, offset: number): void {
  writeFileUtf8(sidecarPath, String(offset));
}

// --- I/O abstraction (injected at edges, default = real fs) ---

export interface FsOps {
  readonly readFileFromOffset: (path: string, offset: number) => string;
  readonly readFileUtf8: (path: string) => string;
  readonly writeFileUtf8: (path: string, data: string) => void;
}

let fsOps: FsOps = createDefaultFsOps();

export function setFsOps(ops: FsOps): void {
  fsOps = ops;
}

export function resetFsOps(): void {
  fsOps = createDefaultFsOps();
}

function readFileFromOffset(path: string, offset: number): string {
  return fsOps.readFileFromOffset(path, offset);
}

function readFileUtf8(path: string): string {
  return fsOps.readFileUtf8(path);
}

function writeFileUtf8(path: string, data: string): void {
  fsOps.writeFileUtf8(path, data);
}

function createDefaultFsOps(): FsOps {
  const fs = require("node:fs") as typeof import("node:fs");
  return {
    readFileFromOffset(path: string, offset: number): string {
      const fd = fs.openSync(path, "r");
      try {
        const stat = fs.fstatSync(fd);
        const bytesToRead = stat.size - offset;
        if (bytesToRead <= 0) return "";
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, offset);
        return buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    },
    readFileUtf8(path: string): string {
      return fs.readFileSync(path, "utf8");
    },
    writeFileUtf8(path: string, data: string): void {
      fs.writeFileSync(path, data, "utf8");
    },
  };
}
