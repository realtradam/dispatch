// Validation + limits for multimodal user attachments (images / PDFs).
//
// Kept dependency-free (no DB / `bun:sqlite` import) so both the API layer
// (`/chat` request validation) and any future caller can share the exact same
// allowlist and size/count ceilings. The limits mirror Anthropic's documented
// vision/PDF API constraints (the only image-capable providers Dispatch maps),
// so a request that passes here won't be rejected by the provider for size.

import type { UserAttachmentPart, UserContentPart } from "../types/index.js";

/** Accepted image media types. */
export const ACCEPTED_IMAGE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

/** Accepted document media types. */
export const ACCEPTED_PDF_MEDIA_TYPE = "application/pdf";

/** Every media type we accept as an attachment. */
export const ACCEPTED_ATTACHMENT_MEDIA_TYPES = [
	...ACCEPTED_IMAGE_MEDIA_TYPES,
	ACCEPTED_PDF_MEDIA_TYPE,
] as const;

/** Per-image byte ceiling (Anthropic: 5 MB/image). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Per-PDF byte ceiling (Anthropic: 32 MB/PDF). */
export const MAX_PDF_BYTES = 32 * 1024 * 1024;

/** Max attachments per message (Anthropic: 20 images/request). */
export const MAX_ATTACHMENTS = 20;

/**
 * Total attachment payload ceiling for a single request (decoded bytes). Bounds
 * the overall request size even when each individual file is within its limit.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Whether a media type is an accepted image type. */
export function isImageMediaType(mediaType: string): boolean {
	return (ACCEPTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** Whether a media type is the accepted PDF type. */
export function isPdfMediaType(mediaType: string): boolean {
	return mediaType === ACCEPTED_PDF_MEDIA_TYPE;
}

/** Whether a media type is an accepted attachment type at all. */
export function isAcceptedAttachmentMediaType(mediaType: string): boolean {
	return (ACCEPTED_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/**
 * Decoded byte length of a base64 string, computed WITHOUT allocating the
 * decoded buffer. Tolerates an optional `data:<mediaType>;base64,` prefix and
 * any embedded whitespace/newlines. Returns 0 for an empty/whitespace string.
 */
export function base64ByteLength(b64: string): number {
	// Strip a data-URI prefix if present.
	const comma = b64.indexOf(",");
	const body = b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
	let len = 0;
	let pad = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body.charCodeAt(i);
		// Skip whitespace (space, \t, \n, \r).
		if (ch === 32 || ch === 9 || ch === 10 || ch === 13) continue;
		len++;
		if (body[i] === "=") pad++;
	}
	if (len === 0) return 0;
	// 4 base64 chars → 3 bytes, minus padding.
	return Math.floor((len * 3) / 4) - pad;
}

export type AttachmentValidationError =
	| { code: "unsupported-type"; mediaType: string }
	| { code: "image-too-large"; mediaType: string; bytes: number; limit: number }
	| { code: "pdf-too-large"; bytes: number; limit: number }
	| { code: "too-many"; count: number; limit: number }
	| { code: "total-too-large"; bytes: number; limit: number }
	| { code: "empty"; mediaType: string };

export interface AttachmentValidationResult {
	ok: boolean;
	errors: AttachmentValidationError[];
}

/** Extract just the attachment parts from a mixed content list. */
function attachmentsOf(content: UserContentPart[]): UserAttachmentPart[] {
	return content.filter((p): p is UserAttachmentPart => p.type === "attachment");
}

/**
 * Validate the attachments in a multimodal user content list against the
 * media-type allowlist and the size/count ceilings. Pure: never throws,
 * collects every violation so the caller can report them all at once.
 *
 * Text parts are ignored (always valid). An empty content list is valid (it's
 * just a text-only message expressed as parts).
 */
export function validateUserContent(content: UserContentPart[]): AttachmentValidationResult {
	const errors: AttachmentValidationError[] = [];
	const attachments = attachmentsOf(content);

	if (attachments.length > MAX_ATTACHMENTS) {
		errors.push({ code: "too-many", count: attachments.length, limit: MAX_ATTACHMENTS });
	}

	let total = 0;
	for (const att of attachments) {
		if (!isAcceptedAttachmentMediaType(att.mediaType)) {
			errors.push({ code: "unsupported-type", mediaType: att.mediaType });
			continue;
		}
		const bytes = base64ByteLength(att.data);
		total += bytes;
		if (bytes === 0) {
			errors.push({ code: "empty", mediaType: att.mediaType });
			continue;
		}
		if (isPdfMediaType(att.mediaType)) {
			if (bytes > MAX_PDF_BYTES) {
				errors.push({ code: "pdf-too-large", bytes, limit: MAX_PDF_BYTES });
			}
		} else if (bytes > MAX_IMAGE_BYTES) {
			errors.push({
				code: "image-too-large",
				mediaType: att.mediaType,
				bytes,
				limit: MAX_IMAGE_BYTES,
			});
		}
	}

	if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
		errors.push({ code: "total-too-large", bytes: total, limit: MAX_TOTAL_ATTACHMENT_BYTES });
	}

	return { ok: errors.length === 0, errors };
}

/** Convenience: does the content list contain at least one attachment? */
export function hasAttachments(content: UserContentPart[] | undefined | null): boolean {
	return !!content && content.some((p) => p.type === "attachment");
}
