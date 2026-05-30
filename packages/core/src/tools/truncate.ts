import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────
//
// A tool result that exceeds *either* MAX_CHARS or MAX_LINES is treated
// as oversized: the full content is written to a spill file under
// /tmp/dispatch/tool-results/<tabId>/<callId>.txt and the model receives
// HEAD_CHARS from the start + TAIL_CHARS from the end with a notice
// in between. These are deliberate hardcoded defaults — see the design
// discussion in notes/plan.md for the rationale.

export const MAX_CHARS = 10_000;
export const MAX_LINES = 500;
export const HEAD_CHARS = 1500;
export const TAIL_CHARS = 1500;

/** Base directory for all tool-result spill files. Per-tab subdirectories live inside. */
export const SPILL_ROOT = "/tmp/dispatch/tool-results";

// ─── Public API ──────────────────────────────────────────────────

export interface TruncationContext {
	/** Tab the tool call belongs to. Used to scope the spill directory. */
	tabId: string;
	/** Tool call ID, used as the spill file basename. */
	callId: string;
	/** Tool name, included in the truncation notice for human-readable hints. */
	toolName: string;
}

export interface TruncationResult {
	/** Final string sent to the model. Either the original (when under threshold) or the head+notice+tail excerpt. */
	displayResult: string;
	/** When truncation happened, the absolute path the full output was spilled to. Undefined otherwise. */
	spillPath?: string;
}

/**
 * Apply universal truncation to a tool result string.
 *
 * If the result is under both the character and line caps, returns it
 * unchanged with no side effects.
 *
 * If the result exceeds either cap:
 *  1. Writes the full content to `<SPILL_ROOT>/<tabId>/<callId>.txt`.
 *  2. Builds a display string consisting of HEAD_CHARS from the start,
 *     a multi-line truncation notice that includes the spill path, and
 *     TAIL_CHARS from the end.
 *
 * The notice instructs the model to use `read_file` (with offset/limit)
 * or `read_file_slice` to inspect the full content. Every tool result
 * flows through this function via `Agent.executeToolWithStreaming`, so
 * any new tool that returns a string automatically gets the protection.
 */
export function applyTruncation(result: string, ctx: TruncationContext): TruncationResult {
	const totalChars = result.length;
	const totalLines = countLines(result);

	if (totalChars <= MAX_CHARS && totalLines <= MAX_LINES) {
		return { displayResult: result };
	}

	const spillPath = join(SPILL_ROOT, ctx.tabId, `${ctx.callId}.txt`);
	try {
		mkdirSync(dirname(spillPath), { recursive: true, mode: 0o700 });
		writeFileSync(spillPath, result, { encoding: "utf-8", mode: 0o600 });
	} catch (err) {
		// If we can't spill (disk full, perms, etc.) fall back to hard-truncating
		// the head + tail without a spill path reference. The model loses the
		// ability to inspect the middle but won't be blocked outright.
		const message = err instanceof Error ? err.message : String(err);
		return {
			displayResult: buildExcerpt(result, totalChars, totalLines, ctx, {
				spillPath: null,
				spillError: message,
			}),
		};
	}

	return {
		displayResult: buildExcerpt(result, totalChars, totalLines, ctx, {
			spillPath,
			spillError: null,
		}),
		spillPath,
	};
}

/** Delete the entire spill directory for a tab. Best-effort, errors swallowed. */
export function clearSpillForTab(tabId: string): void {
	const dir = join(SPILL_ROOT, tabId);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Ignore — tab close should not fail on cleanup errors
	}
}

// ─── Internal helpers ────────────────────────────────────────────

function countLines(s: string): number {
	if (s.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) === 10 /* \n */) count++;
	}
	return count;
}

function buildExcerpt(
	result: string,
	totalChars: number,
	totalLines: number,
	ctx: TruncationContext,
	spill: { spillPath: string | null; spillError: string | null },
): string {
	// Guard against pathological case where HEAD+TAIL overlap. If the result
	// is between MAX_CHARS and HEAD+TAIL (rare), slice cleanly so we don't
	// emit overlapping content.
	const head = result.slice(0, HEAD_CHARS);
	const tailStart = Math.max(HEAD_CHARS, totalChars - TAIL_CHARS);
	const tail = result.slice(tailStart);

	const omittedChars = Math.max(0, totalChars - head.length - tail.length);

	const notice: string[] = [
		"",
		`[output truncated by dispatch — tool=${ctx.toolName}, total ${totalChars.toLocaleString()} chars / ${totalLines.toLocaleString()} lines; showing first ${head.length.toLocaleString()} and last ${tail.length.toLocaleString()}, ${omittedChars.toLocaleString()} omitted]`,
	];
	if (spill.spillPath) {
		notice.push(
			`[full output saved to: ${spill.spillPath}]`,
			`[use read_file with offset/limit (lines), or read_file_slice (chars within a single line), to inspect specific sections]`,
		);
	} else if (spill.spillError) {
		notice.push(`[failed to spill full output to disk: ${spill.spillError}]`);
	}
	notice.push("");

	return `${head}${notice.join("\n")}${tail}`;
}
