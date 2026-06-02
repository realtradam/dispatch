// Inline attachment tokens for the chat input.
//
// A pasted image/PDF is represented in the textarea draft as an inline TOKEN
// (e.g. `【image:a1b2c3】`). The token is ordinary text living inside the draft,
// so attachments have ORDER relative to typed text and to each other, and the
// user can reference them positionally ("here is image A: 【image:…】"). The
// token is also the ONLY handle on an attachment — deleting it (atomic delete,
// below) detaches the underlying file. There is no separate preview strip.
//
// This module is pure (no DOM, no Svelte) so it can be unit-tested directly.

import type { UserContentPart } from "@dispatch/core/src/types/index.js";

export type AttachmentKind = "image" | "pdf";

/** A staged attachment, keyed by its short token id. */
export interface StagedAttachment {
	id: string;
	kind: AttachmentKind;
	/** IANA media type, e.g. `image/png`, `application/pdf`. */
	mediaType: string;
	/** Base64 payload WITHOUT a `data:` URI prefix. */
	data: string;
	/** Optional original filename (used for PDFs). */
	name?: string;
}

/**
 * Token grammar: `【<kind>:<id>】` where kind ∈ {image,pdf} and id is 6
 * lowercase alphanumerics. The CJK corner brackets (U+3010/U+3011) are used as
 * delimiters because they're visually distinct and virtually never typed by
 * hand, so a token won't collide with normal prose.
 */
export const ATTACHMENT_TOKEN_RE = /【(image|pdf):([a-z0-9]{6})】/g;

/** Build the inline token string for a staged attachment id + kind. */
export function makeAttachmentToken(kind: AttachmentKind, id: string): string {
	return `【${kind}:${id}】`;
}

/** Generate a short, URL-safe token id (6 lowercase alphanumerics). */
export function generateTokenId(): string {
	let out = "";
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	// crypto.getRandomValues is available in browsers and modern Node/Bun.
	const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
	if (cryptoObj?.getRandomValues) {
		const buf = new Uint32Array(6);
		cryptoObj.getRandomValues(buf);
		for (let i = 0; i < 6; i++) out += alphabet[(buf[i] ?? 0) % alphabet.length];
		return out;
	}
	for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
}

export interface FoundToken {
	id: string;
	kind: AttachmentKind;
	/** Inclusive start index of the token within the text. */
	start: number;
	/** Exclusive end index of the token within the text. */
	end: number;
}

/** Find all attachment tokens in `text`, in order of appearance. */
export function findTokens(text: string): FoundToken[] {
	const out: FoundToken[] = [];
	// Fresh regex per call so `lastIndex` state never leaks between calls.
	const re = new RegExp(ATTACHMENT_TOKEN_RE.source, "g");
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		out.push({
			kind: m[1] as AttachmentKind,
			id: m[2] ?? "",
			start: m.index,
			end: m.index + m[0].length,
		});
		m = re.exec(text);
	}
	return out;
}

/** The set of attachment ids whose token is still intact in `text`. */
export function intactTokenIds(text: string): Set<string> {
	return new Set(findTokens(text).map((t) => t.id));
}

export interface DeletionResult {
	/** Text after the deletion. */
	text: string;
	/** New caret position (collapsed) after the deletion. */
	caret: number;
	/** Ids of attachments whose tokens were removed by this deletion. */
	removedIds: string[];
}

/**
 * Compute the result of a Backspace/Delete keystroke when it interacts with an
 * attachment token, so a token deletes ATOMICALLY (one keystroke removes the
 * whole `【…】`, never a single bracket). Returns `null` when the keystroke does
 * NOT touch a token — the caller should then let the browser's default editing
 * behaviour run.
 *
 * Rules:
 *  - Range selection (`selStart !== selEnd`): expand the range to fully cover
 *    any token it overlaps, then delete the expanded range. Only acts when at
 *    least one token actually overlaps (otherwise returns null).
 *  - Collapsed + Backspace: if a token ends exactly at the caret, delete it.
 *  - Collapsed + Delete: if a token starts exactly at the caret, delete it.
 */
export function computeTokenDeletion(
	text: string,
	selStart: number,
	selEnd: number,
	key: "Backspace" | "Delete",
): DeletionResult | null {
	const tokens = findTokens(text);
	if (tokens.length === 0) return null;

	if (selStart !== selEnd) {
		const lo = Math.min(selStart, selEnd);
		const hi = Math.max(selStart, selEnd);
		const overlapping = tokens.filter((t) => t.start < hi && t.end > lo);
		if (overlapping.length === 0) return null;
		const delStart = Math.min(lo, ...overlapping.map((t) => t.start));
		const delEnd = Math.max(hi, ...overlapping.map((t) => t.end));
		return {
			text: text.slice(0, delStart) + text.slice(delEnd),
			caret: delStart,
			removedIds: overlapping.map((t) => t.id),
		};
	}

	// Collapsed caret.
	if (key === "Backspace") {
		const tok = tokens.find((t) => t.end === selStart);
		if (!tok) return null;
		return {
			text: text.slice(0, tok.start) + text.slice(tok.end),
			caret: tok.start,
			removedIds: [tok.id],
		};
	}
	// Delete (forward).
	const tok = tokens.find((t) => t.start === selStart);
	if (!tok) return null;
	return {
		text: text.slice(0, tok.start) + text.slice(tok.end),
		caret: tok.start,
		removedIds: [tok.id],
	};
}

/** Human-readable marker that replaces a token in persisted/display text. */
export function markerFor(kind: AttachmentKind): string {
	return kind === "pdf" ? "[pdf]" : "[image]";
}

export interface ParsedDraft {
	/**
	 * Text-only projection of the draft with each attachment token replaced by a
	 * `[image]` / `[pdf]` marker. This is what gets persisted and rendered in the
	 * chat history (the raw bytes are never stored).
	 */
	displayText: string;
	/**
	 * Ordered multimodal content (interleaved text + attachment parts) to send to
	 * the model, or `null` when the draft has no intact attachment token (the
	 * caller then sends plain text).
	 */
	content: UserContentPart[] | null;
}

/**
 * Split a draft (text containing attachment tokens) plus the staged-attachment
 * map into:
 *  - `displayText`: tokens swapped for `[image]`/`[pdf]` markers, and
 *  - `content`: an ordered `UserContentPart[]` interleaving the surrounding text
 *    with the matching attachment parts.
 *
 * A token whose id has no matching staged attachment (e.g. a stray paste of the
 * token text, or a detached attachment) is treated as plain text in BOTH
 * outputs — its marker still appears in `displayText`, but it contributes no
 * attachment part. `content` is `null` when no attachment part is produced.
 */
export function parseDraft(draft: string, attachments: Map<string, StagedAttachment>): ParsedDraft {
	const tokens = findTokens(draft);
	let displayText = "";
	const content: UserContentPart[] = [];
	let textBuf = "";
	let cursor = 0;
	let producedAttachment = false;

	const flushText = () => {
		if (textBuf.length > 0) {
			content.push({ type: "text", text: textBuf });
			textBuf = "";
		}
	};

	for (const tok of tokens) {
		const between = draft.slice(cursor, tok.start);
		textBuf += between;
		displayText += between;
		const att = attachments.get(tok.id);
		if (att) {
			// displayText (persisted/rendered) gets a `[image]`/`[pdf]` marker;
			// the multimodal content gets the ACTUAL attachment part instead — no
			// marker text, since the part itself represents the file to the model.
			displayText += markerFor(tok.kind);
			flushText();
			content.push({
				type: "attachment",
				mediaType: att.mediaType,
				data: att.data,
				...(att.name ? { name: att.name } : {}),
			});
			producedAttachment = true;
		} else {
			// Orphan token (no staged attachment) → keep the marker as plain text
			// in BOTH outputs; it contributes no attachment part.
			displayText += markerFor(tok.kind);
			textBuf += markerFor(tok.kind);
		}
		cursor = tok.end;
	}
	const tail = draft.slice(cursor);
	textBuf += tail;
	displayText += tail;
	flushText();

	return { displayText, content: producedAttachment ? content : null };
}
