import { describe, expect, it } from "vitest";
import {
	computeTokenDeletion,
	findTokens,
	generateTokenId,
	intactTokenIds,
	makeAttachmentToken,
	markerFor,
	parseDraft,
	type StagedAttachment,
} from "../src/lib/attachment-tokens.js";

function img(id: string): StagedAttachment {
	return { id, kind: "image", mediaType: "image/png", data: "QQ==" };
}
function pdf(id: string): StagedAttachment {
	return { id, kind: "pdf", mediaType: "application/pdf", data: "QQ==", name: "doc.pdf" };
}

describe("token helpers", () => {
	it("round-trips make/find", () => {
		const tok = makeAttachmentToken("image", "abc123");
		expect(tok).toBe("【image:abc123】");
		const found = findTokens(`x ${tok} y`);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ id: "abc123", kind: "image", start: 2, end: 2 + tok.length });
	});

	it("generates 6-char lowercase-alnum ids", () => {
		for (let i = 0; i < 20; i++) {
			expect(generateTokenId()).toMatch(/^[a-z0-9]{6}$/);
		}
	});

	it("finds multiple tokens in order and reports intact ids", () => {
		const text = `a ${makeAttachmentToken("image", "aaaaaa")} b ${makeAttachmentToken("pdf", "bbbbbb")}`;
		const found = findTokens(text);
		expect(found.map((t) => t.id)).toEqual(["aaaaaa", "bbbbbb"]);
		expect(intactTokenIds(text)).toEqual(new Set(["aaaaaa", "bbbbbb"]));
	});

	it("does not treat a partially-broken token as intact", () => {
		// Missing closing bracket → not a valid token.
		expect(intactTokenIds("【image:aaaaaa").size).toBe(0);
	});
});

describe("computeTokenDeletion", () => {
	const tok = makeAttachmentToken("image", "abcabc");
	const text = `hi ${tok}!`; // token spans indices 3..3+len
	const tokStart = 3;
	const tokEnd = 3 + tok.length;

	it("returns null when no tokens exist", () => {
		expect(computeTokenDeletion("plain", 2, 2, "Backspace")).toBeNull();
	});

	it("Backspace just after a token removes the whole token atomically", () => {
		const res = computeTokenDeletion(text, tokEnd, tokEnd, "Backspace");
		expect(res).not.toBeNull();
		expect(res?.text).toBe("hi !");
		expect(res?.caret).toBe(tokStart);
		expect(res?.removedIds).toEqual(["abcabc"]);
	});

	it("Delete just before a token removes the whole token atomically", () => {
		const res = computeTokenDeletion(text, tokStart, tokStart, "Delete");
		expect(res?.text).toBe("hi !");
		expect(res?.caret).toBe(tokStart);
		expect(res?.removedIds).toEqual(["abcabc"]);
	});

	it("Backspace NOT adjacent to a token returns null (default editing)", () => {
		// Caret at index 2 (after "hi"), token is further along.
		expect(computeTokenDeletion(text, 2, 2, "Backspace")).toBeNull();
	});

	it("a selection overlapping a token expands to cover the whole token", () => {
		// Select from inside "hi " through the middle of the token.
		const res = computeTokenDeletion(text, 1, tokStart + 3, "Backspace");
		expect(res).not.toBeNull();
		// Deletion starts at min(selStart, tokStart)=1 and ends at tokEnd.
		expect(res?.text).toBe("h!");
		expect(res?.removedIds).toEqual(["abcabc"]);
	});

	it("a range selection touching no token returns null", () => {
		expect(computeTokenDeletion(text, 0, 2, "Backspace")).toBeNull();
	});
});

describe("parseDraft", () => {
	it("returns plain text + null content when there are no attachments", () => {
		const res = parseDraft("just text", new Map());
		expect(res.displayText).toBe("just text");
		expect(res.content).toBeNull();
	});

	it("interleaves text and attachment parts in order", () => {
		const a = img("aaaaaa");
		const b = pdf("bbbbbb");
		const map = new Map([
			[a.id, a],
			[b.id, b],
		]);
		const draft = `A: ${makeAttachmentToken("image", a.id)} B: ${makeAttachmentToken("pdf", b.id)} end`;
		const res = parseDraft(draft, map);

		// displayText swaps tokens for markers.
		expect(res.displayText).toBe(`A: ${markerFor("image")} B: ${markerFor("pdf")} end`);

		// content interleaves the surrounding text with the attachment parts.
		expect(res.content).toEqual([
			{ type: "text", text: "A: " },
			{ type: "attachment", mediaType: "image/png", data: "QQ==" },
			{ type: "text", text: " B: " },
			{ type: "attachment", mediaType: "application/pdf", data: "QQ==", name: "doc.pdf" },
			{ type: "text", text: " end" },
		]);
	});

	it("treats an orphan token (no staged attachment) as plain text", () => {
		// Token present in text but not in the attachments map.
		const draft = `x ${makeAttachmentToken("image", "zzzzzz")} y`;
		const res = parseDraft(draft, new Map());
		expect(res.displayText).toBe(`x ${markerFor("image")} y`);
		// No real attachment → null content (plain-text send).
		expect(res.content).toBeNull();
	});
});
