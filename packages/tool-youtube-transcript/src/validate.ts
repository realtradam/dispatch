/**
 * Pure argument validation for the youtube_transcript tool — input → output, no I/O.
 *
 * Validates that args is an object with a non-empty `url` string. Does NOT
 * validate URL format — the transcriber service handles that (mirrors the
 * opencode youtube-subtitles tool's contract). Returns the URL string on
 * success or `{ error }` for invalid input, so the tool surfaces the message
 * verbatim as an `isError` result.
 */

export type ValidationError = { readonly error: string };

/**
 * Validate raw tool args. Returns the URL string, or `{ error }` for invalid
 * input — the tool surfaces the message verbatim.
 */
export function validateUrl(args: unknown): string | ValidationError {
	if (args === null || args === undefined || typeof args !== "object") {
		return { error: "Error: Arguments must be an object with a 'url' string." };
	}
	const obj = args as Record<string, unknown>;
	const raw = obj.url;
	if (typeof raw !== "string") {
		return { error: "Error: 'url' is required and must be a string." };
	}
	if (raw.trim().length === 0) {
		return { error: "Error: 'url' must not be empty." };
	}
	return raw;
}
