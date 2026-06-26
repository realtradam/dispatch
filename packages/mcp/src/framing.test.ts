import { describe, expect, it } from "vitest";
import { encode, FrameDecoder } from "./framing.js";

describe("encode", () => {
  it("produces correct Content-Length header", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const encoded = encode(msg);
    const text = new TextDecoder().decode(encoded);
    expect(text).toBe(`Content-Length: ${new TextEncoder().encode(msg).length}\r\n\r\n${msg}`);
  });

  it("handles empty message", () => {
    const encoded = encode("");
    const text = new TextDecoder().decode(encoded);
    expect(text).toBe("Content-Length: 0\r\n\r\n");
  });
});

describe("FrameDecoder", () => {
  it("reassembles a complete message from one chunk", () => {
    const msg = '{"jsonrpc":"2.0","id":1}';
    const encoded = encode(msg);
    const decoder = new FrameDecoder();
    const messages = decoder.decode(encoded);
    expect(messages).toEqual([msg]);
  });

  it("handles split across chunks", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const encoded = encode(msg);
    const mid = Math.floor(encoded.length / 2);
    const chunk1 = encoded.slice(0, mid);
    const chunk2 = encoded.slice(mid);

    const decoder = new FrameDecoder();
    const result1 = decoder.decode(chunk1);
    expect(result1).toEqual([]);

    const result2 = decoder.decode(chunk2);
    expect(result2).toEqual([msg]);
  });

  it("handles two messages in one chunk", () => {
    const msg1 = '{"jsonrpc":"2.0","id":1}';
    const msg2 = '{"jsonrpc":"2.0","id":2}';
    const encoded1 = encode(msg1);
    const encoded2 = encode(msg2);
    const combined = new Uint8Array(encoded1.length + encoded2.length);
    combined.set(encoded1);
    combined.set(encoded2, encoded1.length);

    const decoder = new FrameDecoder();
    const messages = decoder.decode(combined);
    expect(messages).toEqual([msg1, msg2]);
  });

  it("rejects negative Content-Length by skipping header", () => {
    const header = "Content-Length: -5\r\n\r\n";
    const encoded = new TextEncoder().encode(`${header}extra`);
    const decoder = new FrameDecoder();
    const messages = decoder.decode(encoded);
    // Negative length does not match the digit capture, so the header is skipped.
    expect(messages).toEqual([]);
  });

  it("rejects zero Content-Length", () => {
    const encoded = encode("");
    const decoder = new FrameDecoder();
    const messages = decoder.decode(encoded);
    expect(messages).toEqual([""]);
  });

  it("reassembles multi-byte UTF-8 content (byte-length, not char-length)", () => {
    // "héllo" — é is two UTF-8 bytes; Content-Length counts bytes.
    const msg = '{"text":"héllo 🚀"}';
    const encoded = encode(msg);
    expect(new TextEncoder().encode(msg).length).toBeGreaterThan(msg.length);

    const decoder = new FrameDecoder();
    const messages = decoder.decode(encoded);
    expect(messages).toEqual([msg]);
  });

  it("reassembles multi-byte content split across a chunk boundary", () => {
    const msg = '{"text":"日本語のテスト"}';
    const encoded = encode(msg);
    const mid = Math.floor(encoded.length / 2);
    const decoder = new FrameDecoder();
    expect(decoder.decode(encoded.slice(0, mid))).toEqual([]);
    expect(decoder.decode(encoded.slice(mid))).toEqual([msg]);
  });
});
