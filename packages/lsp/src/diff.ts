/**
 * Pure diff utilities for computing LSP text document change ranges.
 * Language-agnostic — works for any text content from any language server.
 *
 * Uses longest-common-prefix/suffix matching to find the minimal changed
 * region between two versions of a file. O(n) in text length.
 */

export interface Position {
	readonly line: number; // 0-based
	readonly character: number; // 0-based
}

export interface TextDocumentContentChangeEvent {
	readonly range: {
		readonly start: Position;
		readonly end: Position;
	};
	readonly text: string;
}

/**
 * Compute the minimal change range that transforms `oldText` into `newText`.
 * Returns a single `TextDocumentContentChangeEvent` suitable for
 * `textDocument/didChange` with incremental sync (change: 2).
 *
 * Algorithm: find the longest common prefix and suffix of the two strings.
 * The region between them is the changed range. The replacement text is
 * the portion of `newText` between the prefix and suffix.
 */
export function computeChangeRange(
	oldText: string,
	newText: string,
): TextDocumentContentChangeEvent {
	const minLen = Math.min(oldText.length, newText.length);

	// Longest common prefix
	let prefixLen = 0;
	while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
		prefixLen++;
	}

	// Longest common suffix (must not overlap with prefix)
	const oldRemaining = oldText.length - prefixLen;
	const newRemaining = newText.length - prefixLen;
	const maxSuffix = Math.min(oldRemaining, newRemaining);
	let suffixLen = 0;
	while (
		suffixLen < maxSuffix &&
		oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const startOffset = prefixLen;
	const endOffset = oldText.length - suffixLen;
	const replacementText = newText.slice(prefixLen, newText.length - suffixLen);

	return {
		range: {
			start: offsetToPosition(oldText, startOffset),
			end: offsetToPosition(oldText, endOffset),
		},
		text: replacementText,
	};
}

/**
 * Convert a 0-based character offset into a text string to an LSP Position
 * (0-based line and character). Scans for newlines up to the offset.
 */
export function offsetToPosition(text: string, offset: number): Position {
	let line = 0;
	let character = 0;
	const limit = Math.min(offset, text.length);
	for (let i = 0; i < limit; i++) {
		if (text[i] === "\n") {
			line++;
			character = 0;
		} else {
			character++;
		}
	}
	return { line, character };
}
