import { describe, expect, it } from "vitest";
import { encode, FrameDecoder } from "./framing.js";

/** Build a legacy Content-Length frame (for exercising the decoder's CL path). */
function contentLengthFrame(body: string): Uint8Array {
  const bodyBytes = new TextEncoder().encode(body);
  return new TextEncoder().encode(`Content-Length: ${bodyBytes.length}\r\n\r\n${body}`);
}

describe("encode", () => {
  it("produces newline-delimited JSON (current MCP spec framing)", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const encoded = encode(msg);
    const text = new TextDecoder().decode(encoded);
    expect(text).toBe(`${msg}\n`);
  });

  it("appends a trailing newline to an empty message", () => {
    const encoded = encode("");
    const text = new TextDecoder().decode(encoded);
    expect(text).toBe("\n");
  });
});

describe("FrameDecoder — newline-delimited JSON", () => {
  it("decodes a single newline-delimited message", () => {
    const msg = '{"jsonrpc":"2.0","id":1}';
    const decoder = new FrameDecoder();
    expect(decoder.decode(encode(msg))).toEqual([msg]);
  });

  it("decodes a CRLF-terminated message (trailing \\r tolerated)", () => {
    const msg = '{"jsonrpc":"2.0","id":1}';
    const decoder = new FrameDecoder();
    const framed = new TextEncoder().encode(`${msg}\r\n`);
    expect(decoder.decode(framed)).toEqual([msg]);
  });

  it("handles a split across chunks", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const encoded = encode(msg);
    const mid = Math.floor(encoded.length / 2);

    const decoder = new FrameDecoder();
    expect(decoder.decode(encoded.slice(0, mid))).toEqual([]);
    expect(decoder.decode(encoded.slice(mid))).toEqual([msg]);
  });

  it("handles two messages in one chunk", () => {
    const msg1 = '{"jsonrpc":"2.0","id":1}';
    const msg2 = '{"jsonrpc":"2.0","id":2}';
    const combined = new Uint8Array(encode(msg1).length + encode(msg2).length);
    combined.set(encode(msg1));
    combined.set(encode(msg2), encode(msg1).length);

    const decoder = new FrameDecoder();
    expect(decoder.decode(combined)).toEqual([msg1, msg2]);
  });

  it("skips blank lines between messages", () => {
    const msg = '{"jsonrpc":"2.0","id":1}';
    const framed = new TextEncoder().encode(`\n\n${msg}\n\n`);
    const decoder = new FrameDecoder();
    expect(decoder.decode(framed)).toEqual([msg]);
  });

  it("reassembles multi-byte UTF-8 content (byte-aware, not char-aware)", () => {
    const msg = '{"text":"héllo 🚀"}';
    expect(new TextEncoder().encode(msg).length).toBeGreaterThan(msg.length);
    const decoder = new FrameDecoder();
    expect(decoder.decode(encode(msg))).toEqual([msg]);
  });

  it("reassembles multi-byte content split across a chunk boundary", () => {
    const msg = '{"text":"日本語のテスト"}';
    const encoded = encode(msg);
    const mid = Math.floor(encoded.length / 2);
    const decoder = new FrameDecoder();
    expect(decoder.decode(encoded.slice(0, mid))).toEqual([]);
    expect(decoder.decode(encoded.slice(mid))).toEqual([msg]);
  });

  it("does not split a JSON string containing an escaped \\n (no raw newline)", () => {
    // JSON escapes newlines inside strings as the two chars `\` + `n`; a raw
    // 0x0a only ever appears as a message separator. So a JSON body carrying
    // an embedded newline literal survives intact.
    const msg = '{"text":"line1\\nline2"}';
    const decoder = new FrameDecoder();
    expect(decoder.decode(encode(msg))).toEqual([msg]);
  });
});

describe("FrameDecoder — legacy Content-Length framing (auto-detected)", () => {
  it("decodes a Content-Length-framed message", () => {
    const msg = '{"jsonrpc":"2.0","id":1}';
    const decoder = new FrameDecoder();
    expect(decoder.decode(contentLengthFrame(msg))).toEqual([msg]);
  });

  it("reassembles a Content-Length frame split across chunks", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const encoded = contentLengthFrame(msg);
    const mid = Math.floor(encoded.length / 2);
    const decoder = new FrameDecoder();
    expect(decoder.decode(encoded.slice(0, mid))).toEqual([]);
    expect(decoder.decode(encoded.slice(mid))).toEqual([msg]);
  });

  it("decodes two Content-Length frames in one chunk", () => {
    const msg1 = '{"jsonrpc":"2.0","id":1}';
    const msg2 = '{"jsonrpc":"2.0","id":2}';
    const combined = new Uint8Array(
      contentLengthFrame(msg1).length + contentLengthFrame(msg2).length,
    );
    combined.set(contentLengthFrame(msg1));
    combined.set(contentLengthFrame(msg2), contentLengthFrame(msg1).length);

    const decoder = new FrameDecoder();
    expect(decoder.decode(combined)).toEqual([msg1, msg2]);
  });

  it("rejects negative Content-Length by skipping header", () => {
    const encoded = new TextEncoder().encode("Content-Length: -5\r\n\r\nextra");
    const decoder = new FrameDecoder();
    expect(decoder.decode(encoded)).toEqual([]);
  });

  it("accepts zero Content-Length as an empty message", () => {
    const decoder = new FrameDecoder();
    expect(decoder.decode(contentLengthFrame(""))).toEqual([""]);
  });

  it("reassembles multi-byte UTF-8 via Content-Length (byte count)", () => {
    const msg = '{"text":"héllo 🚀"}';
    const decoder = new FrameDecoder();
    expect(decoder.decode(contentLengthFrame(msg))).toEqual([msg]);
  });

  it("does not mis-read a partial 'Content-Length' prefix as newline-delimited", () => {
    // A buffer that is a partial prefix of "Content-Length:" must WAIT for more
    // bytes rather than being split on a (nonexistent) newline.
    const decoder = new FrameDecoder();
    const partial = new TextEncoder().encode("Content-Len");
    expect(decoder.decode(partial)).toEqual([]);
    const rest = new TextEncoder().encode("gth: 3\r\n\r\nabc");
    expect(decoder.decode(rest)).toEqual(["abc"]);
  });
});

describe("FrameDecoder — mixed framings", () => {
  it("decodes a Content-Length frame followed by a newline-delimited message", () => {
    const clMsg = '{"jsonrpc":"2.0","id":1}';
    const nlMsg = '{"jsonrpc":"2.0","id":2}';
    const cl = contentLengthFrame(clMsg);
    const nl = encode(nlMsg);
    const combined = new Uint8Array(cl.length + nl.length);
    combined.set(cl);
    combined.set(nl, cl.length);

    const decoder = new FrameDecoder();
    expect(decoder.decode(combined)).toEqual([clMsg, nlMsg]);
  });
});
