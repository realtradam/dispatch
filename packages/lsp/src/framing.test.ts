import { describe, expect, it } from "vitest";
import { encode, FrameDecoder } from "./framing.js";

describe("framing", () => {
	it("encode/decode round-trips", () => {
		const msg = JSON.stringify({ jsonrpc: "2.0", method: "test", params: { a: 1 } });
		const encoded = encode(msg);
		const decoder = new FrameDecoder();
		const messages = decoder.decode(encoded);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toBe(msg);
	});

	it("decoder reassembles a frame split across two chunks", () => {
		const msg = JSON.stringify({ jsonrpc: "2.0", method: "test" });
		const encoded = encode(msg);
		const mid = Math.floor(encoded.length / 2);
		const chunk1 = encoded.slice(0, mid);
		const chunk2 = encoded.slice(mid);

		const decoder = new FrameDecoder();
		const result1 = decoder.decode(chunk1);
		expect(result1).toHaveLength(0);

		const result2 = decoder.decode(chunk2);
		expect(result2).toHaveLength(1);
		expect(result2[0]).toBe(msg);
	});

	it("decoder yields two messages from one chunk", () => {
		const msg1 = JSON.stringify({ jsonrpc: "2.0", method: "a" });
		const msg2 = JSON.stringify({ jsonrpc: "2.0", method: "b" });
		const encoded1 = encode(msg1);
		const encoded2 = encode(msg2);

		const combined = new Uint8Array(encoded1.length + encoded2.length);
		combined.set(encoded1);
		combined.set(encoded2, encoded1.length);

		const decoder = new FrameDecoder();
		const messages = decoder.decode(combined);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBe(msg1);
		expect(messages[1]).toBe(msg2);
	});
});

describe("multi-byte UTF-8", () => {
	it("round-trips a message with multi-byte characters", () => {
		const msg = JSON.stringify({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { message: "Type '漢字' is not assignable to type 'number'. 🚫" },
		});
		const encoded = encode(msg);
		const decoder = new FrameDecoder();
		const messages = decoder.decode(encoded);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toBe(msg);
	});

	it("reassembles a multi-byte message split at a character boundary", () => {
		// A message whose JSON body contains 3-byte UTF-8 characters (漢字).
		// We split the encoded frame so the boundary falls INSIDE a multi-byte
		// sequence — the old string-based decoder would corrupt this.
		const msg = JSON.stringify({
			jsonrpc: "2.0",
			method: "test",
			params: { text: "漢字テスト" },
		});
		const encoded = encode(msg);

		// Find a split point inside the body (skip the ASCII header).
		const headerEnd = encoded.indexOf(0x0d, 0); // first \r
		const bodyStart = headerEnd + 4; // skip \r\n\r\n
		// Split in the middle of the body — likely inside a multi-byte char.
		const splitPoint = bodyStart + Math.floor((encoded.length - bodyStart) / 2);
		const chunk1 = encoded.slice(0, splitPoint);
		const chunk2 = encoded.slice(splitPoint);

		const decoder = new FrameDecoder();
		expect(decoder.decode(chunk1)).toHaveLength(0); // incomplete
		const result = decoder.decode(chunk2);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(msg);
	});

	it("handles Content-Length in bytes (not characters)", () => {
		// Content-Length counts bytes. For multi-byte content, byte length
		// > character length. The decoder must slice by bytes, not chars.
		const unicode = "🎉分段測試";
		const msg = JSON.stringify({ jsonrpc: "2.0", method: "test", params: { text: unicode } });
		const encoded = encode(msg);

		// Verify the Content-Length header matches the byte length of the body.
		const headerStr = new TextDecoder().decode(encoded.slice(0, encoded.indexOf(0x0d)));
		const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerStr);
		expect(contentLengthMatch).not.toBeNull();
		const declaredLength = Number.parseInt(contentLengthMatch?.[1], 10);
		const bodyBytes = new TextEncoder().encode(msg);
		expect(declaredLength).toBe(bodyBytes.length);

		const decoder = new FrameDecoder();
		const messages = decoder.decode(encoded);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toBe(msg);
	});

	it("reassembles two multi-byte messages from one chunk", () => {
		const msg1 = JSON.stringify({ jsonrpc: "2.0", method: "a", params: { t: "日本語" } });
		const msg2 = JSON.stringify({ jsonrpc: "2.0", method: "b", params: { t: "한국어" } });
		const encoded1 = encode(msg1);
		const encoded2 = encode(msg2);

		const combined = new Uint8Array(encoded1.length + encoded2.length);
		combined.set(encoded1);
		combined.set(encoded2, encoded1.length);

		const decoder = new FrameDecoder();
		const messages = decoder.decode(combined);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBe(msg1);
		expect(messages[1]).toBe(msg2);
	});

	it("reassembles a multi-byte message split across three chunks", () => {
		const msg = JSON.stringify({
			jsonrpc: "2.0",
			method: "test",
			params: { text: "𝕳𝖊𝖑𝖑𝖔, 世界! Привет! 🌍" },
		});
		const encoded = encode(msg);

		const third = Math.floor(encoded.length / 3);
		const decoder = new FrameDecoder();
		expect(decoder.decode(encoded.slice(0, third))).toHaveLength(0);
		expect(decoder.decode(encoded.slice(third, third * 2))).toHaveLength(0);
		const result = decoder.decode(encoded.slice(third * 2));
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(msg);
	});
});
