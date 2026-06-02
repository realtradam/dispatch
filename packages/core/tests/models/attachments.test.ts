import { describe, expect, it } from "vitest";
import {
	base64ByteLength,
	isAcceptedAttachmentMediaType,
	isImageMediaType,
	isPdfMediaType,
	MAX_ATTACHMENTS,
	MAX_IMAGE_BYTES,
	MAX_PDF_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES,
	validateUserContent,
} from "../../src/models/attachments.js";
import type { UserContentPart } from "../../src/types/index.js";

/** A base64 string that decodes to exactly `bytes` bytes (no padding chars). */
function base64OfBytes(bytes: number): string {
	// 4 base64 chars → 3 bytes. Use a multiple of 3 for clean (unpadded) output.
	const groups = Math.ceil(bytes / 3);
	return "A".repeat(groups * 4);
}

function imagePart(data: string, mediaType = "image/png"): UserContentPart {
	return { type: "attachment", mediaType, data };
}

describe("media-type predicates", () => {
	it("classifies image types", () => {
		expect(isImageMediaType("image/png")).toBe(true);
		expect(isImageMediaType("image/jpeg")).toBe(true);
		expect(isImageMediaType("image/webp")).toBe(true);
		expect(isImageMediaType("image/gif")).toBe(true);
		expect(isImageMediaType("application/pdf")).toBe(false);
		expect(isImageMediaType("image/svg+xml")).toBe(false);
	});

	it("classifies pdf + accepted types", () => {
		expect(isPdfMediaType("application/pdf")).toBe(true);
		expect(isPdfMediaType("image/png")).toBe(false);
		expect(isAcceptedAttachmentMediaType("image/gif")).toBe(true);
		expect(isAcceptedAttachmentMediaType("application/pdf")).toBe(true);
		expect(isAcceptedAttachmentMediaType("text/plain")).toBe(false);
	});
});

describe("base64ByteLength", () => {
	it("computes decoded length without padding", () => {
		// "AAAA" → 3 bytes.
		expect(base64ByteLength("AAAA")).toBe(3);
	});

	it("accounts for padding", () => {
		// "QQ==" → 1 byte ("A").
		expect(base64ByteLength("QQ==")).toBe(1);
		// "QUI=" → 2 bytes ("AB").
		expect(base64ByteLength("QUI=")).toBe(2);
	});

	it("tolerates a data: URI prefix and whitespace", () => {
		expect(base64ByteLength("data:image/png;base64,AAAA")).toBe(3);
		expect(base64ByteLength("AA\nAA")).toBe(3);
	});

	it("returns 0 for empty input", () => {
		expect(base64ByteLength("")).toBe(0);
		expect(base64ByteLength("   ")).toBe(0);
	});
});

describe("validateUserContent", () => {
	it("accepts a small image and ignores text parts", () => {
		const content: UserContentPart[] = [
			{ type: "text", text: "hi" },
			imagePart(base64OfBytes(1024)),
		];
		expect(validateUserContent(content)).toEqual({ ok: true, errors: [] });
	});

	it("accepts an empty / text-only content list", () => {
		expect(validateUserContent([]).ok).toBe(true);
		expect(validateUserContent([{ type: "text", text: "no files" }]).ok).toBe(true);
	});

	it("rejects an unsupported media type", () => {
		const res = validateUserContent([imagePart(base64OfBytes(10), "image/svg+xml")]);
		expect(res.ok).toBe(false);
		expect(res.errors[0]).toMatchObject({ code: "unsupported-type", mediaType: "image/svg+xml" });
	});

	it("rejects an oversized image but allows a PDF of the same size", () => {
		const big = base64OfBytes(MAX_IMAGE_BYTES + 3);
		const imgRes = validateUserContent([imagePart(big, "image/png")]);
		expect(imgRes.ok).toBe(false);
		expect(imgRes.errors.some((e) => e.code === "image-too-large")).toBe(true);

		// Same byte size as a PDF is fine (PDF limit is much higher).
		const pdfRes = validateUserContent([imagePart(big, "application/pdf")]);
		expect(pdfRes.ok).toBe(true);
	});

	it("rejects an oversized PDF", () => {
		const res = validateUserContent([
			imagePart(base64OfBytes(MAX_PDF_BYTES + 3), "application/pdf"),
		]);
		expect(res.ok).toBe(false);
		expect(res.errors.some((e) => e.code === "pdf-too-large")).toBe(true);
	});

	it("rejects an empty attachment payload", () => {
		const res = validateUserContent([imagePart("", "image/png")]);
		expect(res.ok).toBe(false);
		expect(res.errors.some((e) => e.code === "empty")).toBe(true);
	});

	it("rejects too many attachments", () => {
		const content: UserContentPart[] = Array.from({ length: MAX_ATTACHMENTS + 1 }, () =>
			imagePart(base64OfBytes(8)),
		);
		const res = validateUserContent(content);
		expect(res.ok).toBe(false);
		expect(res.errors.some((e) => e.code === "too-many")).toBe(true);
	});

	it("rejects when the total payload exceeds the request ceiling", () => {
		// Several individually-legal PDFs that together exceed the total cap.
		const each = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 3);
		const content: UserContentPart[] = [
			imagePart(base64OfBytes(each), "application/pdf"),
			imagePart(base64OfBytes(each), "application/pdf"),
			imagePart(base64OfBytes(each), "application/pdf"),
			imagePart(base64OfBytes(each), "application/pdf"),
		];
		const res = validateUserContent(content);
		expect(res.ok).toBe(false);
		expect(res.errors.some((e) => e.code === "total-too-large")).toBe(true);
	});
});
