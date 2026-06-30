/**
 * MCP stdio framing.
 *
 * The MCP spec (revision 2025-03-26 and later, including 2025-11-25) frames
 * JSON-RPC messages over stdio as **newline-delimited JSON**: each message is
 * a single JSON document followed by a `\n` (or `\r\n`). This replaced the
 * older LSP-style `Content-Length: N\r\n\r\n<JSON>` framing that the protocol
 * inherited originally. Modern servers (e.g. chrome-devtools-mcp) speak ONLY
 * newline-delimited JSON — they emit `<JSON>\n` on stdout and do not respond to
 * `Content-Length`-framed input at all.
 *
 * Outgoing messages are therefore encoded as newline-delimited JSON (the
 * current spec default), so we can talk to modern servers. The decoder
 * **auto-detects** the incoming framing per message — it accepts BOTH
 * newline-delimited JSON and legacy `Content-Length` frames — so we still
 * interoperate with servers that respond with the old framing.
 *
 * PURE: no I/O. Operates on bytes (Uint8Array) so multi-byte UTF-8 content is
 * handled correctly — `Content-Length` is a *byte* count, not a character count.
 */

const HEADER_PREFIX = "Content-Length:";
const HEADER_SEP = "\r\n\r\n";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

const encoder = new TextEncoder();
const SEP_BYTES = encoder.encode(HEADER_SEP);

const CR = 0x0d;
const LF = 0x0a;

/**
 * Encode a JSON string as a single newline-delimited frame (the current MCP
 * spec stdio framing): `<JSON>\n`. This is what we send to MCP servers.
 */
export function encode(msg: string): Uint8Array {
  return encoder.encode(`${msg}\n`);
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

/** Find the first occurrence of a single byte at or after `from`. -1 if absent. */
function indexOfByte(haystack: Uint8Array, needle: number, from: number): number {
  for (let i = from; i < haystack.length; i++) {
    if (haystack[i] === needle) return i;
  }
  return -1;
}

/** Lowercase an ASCII byte (A-Z → a-z); leave everything else unchanged. */
function toLowerByte(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

function isLineTerminator(b: number | undefined): boolean {
  return b === CR || b === LF;
}

/**
 * How does `buf` relate to the `Content-Length:` header prefix (case-insensitive)?
 *  - `HEADER_PREFIX.length` → `buf` starts with the full `Content-Length:` prefix.
 *  - a positive number `< HEADER_PREFIX.length` → `buf` is a (possibly partial)
 *    prefix of `Content-Length:` — ambiguous, the caller must wait for more bytes.
 *  - `-1` → `buf` definitively does NOT start with `Content-Length:` (not CL framing).
 */
function contentLengthPrefixLength(buf: Uint8Array): number {
  const n = Math.min(buf.length, HEADER_PREFIX.length);
  for (let i = 0; i < n; i++) {
    const a = buf[i];
    if (a === undefined) return -1; // unreachable: i < n <= buf.length
    if (toLowerByte(a) !== toLowerByte(HEADER_PREFIX.charCodeAt(i))) return -1;
  }
  return n;
}

/**
 * Feed raw bytes into the decoder. Returns all complete JSON messages that can
 * be extracted from the accumulated buffer. Buffers partial frames across calls.
 *
 * Auto-detects framing per message: a `Content-Length:`-prefixed buffer is parsed
 * as a Content-Length frame (legacy/LSP-style); anything else is parsed as
 * newline-delimited JSON (current MCP spec). Both framings may be mixed in a
 * single stream.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  decode(chunk: Uint8Array): string[] {
    // Append the incoming chunk to the internal byte buffer.
    if (chunk.length > 0) {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }

    const messages: string[] = [];

    while (true) {
      // 1. Skip leading CR/LF whitespace between frames.
      let i = 0;
      while (i < this.buf.length && isLineTerminator(this.buf[i])) i++;
      if (i > 0) this.buf = this.buf.subarray(i);
      if (this.buf.length === 0) break;

      // 2. Detect framing.
      const prefix = contentLengthPrefixLength(this.buf);
      if (prefix >= 0 && prefix < HEADER_PREFIX.length) {
        // Buffer is a (possibly partial) prefix of "Content-Length:" — ambiguous;
        // wait for more bytes before deciding this is (or isn't) a CL frame.
        break;
      }
      if (prefix === HEADER_PREFIX.length) {
        // Content-Length framing.
        const result = this.tryParseContentLength();
        if (result === "incomplete") break;
        if (result !== "skip") messages.push(result);
        continue;
      }

      // 3. Newline-delimited JSON: one message per line, terminated by `\n`
      //    (a trailing `\r` before the `\n` is tolerated). A raw newline byte
      //    can only ever appear as a message separator — JSON escapes newlines
      //    inside strings as the two characters `\n`, never a literal 0x0a — so
      //    splitting on `\n` bytes is safe for valid JSON.
      const nl = indexOfByte(this.buf, LF, 0);
      if (nl === -1) break; // incomplete line — wait for more bytes

      let end = nl;
      if (end > 0 && this.buf[end - 1] === CR) end--;
      const text = this.decoder.decode(this.buf.subarray(0, end));
      this.buf = this.buf.subarray(nl + 1);
      if (text.length > 0) messages.push(text);
    }

    return messages;
  }

  /**
   * Parse one Content-Length frame from the front of `this.buf`. Returns:
   *  - the decoded body string (possibly `""` for a zero-length body),
   *  - `"incomplete"` if the header or body hasn't fully arrived (caller waits),
   *  - `"skip"` if the header was consumed but carried no usable Content-Length
   *    (caller continues scanning without emitting a message).
   */
  private tryParseContentLength(): string | "incomplete" | "skip" {
    const sepIdx = indexOfBytes(this.buf, SEP_BYTES, 0);
    if (sepIdx === -1) return "incomplete"; // header not fully received yet

    const headerText = this.decoder.decode(this.buf.subarray(0, sepIdx));
    const match = CONTENT_LENGTH_RE.exec(headerText);
    const bodyStart = sepIdx + SEP_BYTES.length;

    if (!match?.[1]) {
      // No usable Content-Length — drop this header and continue scanning.
      this.buf = this.buf.subarray(bodyStart);
      return "skip";
    }

    const length = Number.parseInt(match[1], 10);
    if (length < 0) {
      this.buf = this.buf.subarray(bodyStart);
      return "skip";
    }

    if (this.buf.length - bodyStart < length) {
      // Body not fully received yet; wait for more bytes.
      return "incomplete";
    }

    // Decode exactly `length` body bytes (preserves multi-byte UTF-8).
    const body = this.decoder.decode(this.buf.subarray(bodyStart, bodyStart + length));
    this.buf = this.buf.subarray(bodyStart + length);
    return body;
  }
}
