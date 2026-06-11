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
