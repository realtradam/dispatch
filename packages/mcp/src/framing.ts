/**
 * Content-Length framing for MCP stdio transport.
 *
 * Each JSON-RPC message is framed as:
 *   Content-Length: <byte-length>\r\n\r\n<JSON bytes>
 *
 * Same framing as LSP — the MCP spec inherited this from the LSP base protocol.
 *
 * PURE: no I/O. Operates on bytes (Uint8Array) so multi-byte UTF-8 content is
 * handled correctly — `Content-Length` is a *byte* count, not a character count.
 */

const HEADER_SEP = "\r\n\r\n";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

const SEP_BYTES = new TextEncoder().encode(HEADER_SEP);

/**
 * Encode a JSON string into a single Content-Length-framed message.
 * Returns the full frame (header + blank line + body) as bytes.
 */
export function encode(msg: string): Uint8Array {
  const body = new TextEncoder().encode(msg);
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  const frame = new TextEncoder().encode(header);
  const result = new Uint8Array(frame.length + body.length);
  result.set(frame);
  result.set(body, frame.length);
  return result;
}

/** Find the first occurrence of `needle` in `haystack` at or after `from`. -1 if absent. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  const max = haystack.length - needle.length;
  for (let i = from; i <= max; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Feed raw bytes into the decoder. Returns all complete JSON messages that can
 * be extracted from the accumulated buffer. Buffers partial frames across calls.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  decode(chunk: Uint8Array): string[] {
    // Append the incoming chunk to the internal byte buffer.
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;

    const messages: string[] = [];

    while (true) {
      const sepIdx = indexOfBytes(this.buf, SEP_BYTES, 0);
      if (sepIdx === -1) break;

      // The header block is everything before the separator; parse
      // Content-Length from it (ASCII, so decoding the slice is safe).
      const headerText = this.decoder.decode(this.buf.subarray(0, sepIdx));
      const match = CONTENT_LENGTH_RE.exec(headerText);
      const bodyStart = sepIdx + SEP_BYTES.length;

      if (!match?.[1]) {
        // No usable Content-Length — drop this header and continue scanning.
        this.buf = this.buf.subarray(bodyStart);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      if (length < 0) {
        this.buf = this.buf.subarray(bodyStart);
        continue;
      }

      if (this.buf.length - bodyStart < length) {
        // Body not fully received yet; wait for more bytes.
        break;
      }

      // Decode exactly `length` body bytes (preserves multi-byte UTF-8).
      messages.push(this.decoder.decode(this.buf.subarray(bodyStart, bodyStart + length)));
      this.buf = this.buf.subarray(bodyStart + length);
    }

    return messages;
  }
}
