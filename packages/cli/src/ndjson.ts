/**
 * Pure NDJSON line splitter — zero I/O.
 *
 * Splits a buffer on newlines, keeping an incomplete trailing line in `rest`.
 * Does NOT parse JSON — that is the caller's job.
 */

export interface SplitResult {
	readonly lines: readonly string[];
	readonly rest: string;
}

export function splitNdjsonLines(buffer: string): SplitResult {
	const parts = buffer.split("\n");
	const rest = parts[parts.length - 1] ?? "";
	const lines = parts.slice(0, -1).filter((l) => l.length > 0);
	return { lines, rest };
}
