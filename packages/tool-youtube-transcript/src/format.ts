/**
 * Pure formatters for the youtube_transcript tool — input → output, no I/O.
 *
 * These mirror the proven opencode youtube-subtitles tool's formatting,
 * isolated (not imported) per the isolation-over-DRY rule. Tested directly
 * with zero mocks.
 *
 * NOTE: `formatQueued` renders the estimated-available-at time as an ISO 8601
 * string derived from the injected `now()`, rather than `toLocaleTimeString`.
 * The opencode tool uses `toLocaleTimeString`, which reads ambient locale +
 * timezone (hidden state) — a violation of the pure-core rule. ISO is fully
 * deterministic from the injected `now` and is a valid `{time}` rendering.
 */

/** A single timestamped segment from a completed transcript. */
export interface TranscriptSegment {
	readonly text: string;
	readonly start: number;
	readonly duration: number;
}

/** `status: "completed"` response from the transcriber service. */
export interface CompletedResponse {
	readonly status: "completed";
	readonly video_id: string;
	readonly full_text: string;
	readonly segments: readonly TranscriptSegment[];
}

/** `status: "queued" | "processing"` response from the transcriber service. */
export interface QueuedResponse {
	readonly status: "queued" | "processing";
	readonly video_id: string;
	readonly position: number;
	readonly estimated_seconds: number;
}

/** `status: "failed"` response from the transcriber service. */
export interface FailedResponse {
	readonly status: "failed";
	readonly video_id: string;
	readonly error: string;
	readonly error_type: string;
}

/** Discriminated union of all transcriber response shapes. */
export type TranscriptResponse = CompletedResponse | QueuedResponse | FailedResponse;

/**
 * Format a segment start offset (seconds) as `m:ss` (e.g. `1:05`, `12:03`).
 * Minutes are not capped — durations over an hour render as `61:40` etc.
 */
export function formatTimestamp(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Format a completed transcript as markdown: header, video id, full text, then
 * timestamped segment lines `[m:ss] text`. Mirrors the opencode tool's layout.
 */
export function formatCompleted(url: string, data: CompletedResponse): string {
	const lines: string[] = [];
	lines.push(`## Transcript for ${url}`);
	lines.push(`**Video ID:** ${data.video_id}`);
	lines.push("");
	lines.push("### Full text");
	lines.push("");
	lines.push(data.full_text);
	lines.push("");
	lines.push("### Timestamped segments");
	lines.push("");
	for (const segment of data.segments) {
		lines.push(`[${formatTimestamp(segment.start)}] ${segment.text}`);
	}
	return lines.join("\n");
}

/**
 * Format a queued/processing response: status, queue position, the estimated
 * available-at time (ISO, derived from the injected `now`), and the
 * `.youtube_subtitles_pending` append instruction the model must follow.
 */
export function formatQueued(url: string, data: QueuedResponse, now: () => number): string {
	const availableAt = new Date(now() + data.estimated_seconds * 1000);
	const timeStr = availableAt.toISOString();
	return (
		`Transcript not yet available (status: ${data.status}, queue position: ${data.position}).\n` +
		`Estimated available at: ${timeStr} (in ~${Math.ceil(data.estimated_seconds)}s).\n` +
		`You must append this video URL to .youtube_subtitles_pending in the current ` +
		`working directory: ${url}`
	);
}

/** Format a failed response: error type + details. Mirrors the opencode tool. */
export function formatFailed(data: FailedResponse): string {
	return `Transcript fetch failed. Error type: ${data.error_type}. Details: ${data.error}`;
}

/**
 * Truncate output to `cap` characters with a trailing notice, identical in
 * spirit to tool-web-search. Duplication across features is the intended trade
 * (isolation over DRY).
 */
export function truncateOutput(output: string, cap: number): string {
	if (output.length <= cap) {
		return output;
	}
	const truncated = output.slice(0, cap);
	return `${truncated}\n\n[Output truncated: exceeded ${cap} characters]`;
}
