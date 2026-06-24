/**
 * LSP Content-Length framing codec.
 *
 * The LSP base protocol uses Content-Length headers to frame JSON messages.
 * `encode` wraps a JSON message with headers; `FrameDecoder` reassembles
 * complete messages from streaming byte chunks (handles partial frames and
 * multiple frames per chunk).
 *
 * The buffer is a `Uint8Array` (not a string) because `Content-Length` counts
 * **bytes** — slicing by JavaScript character count corrupts messages whose
 * JSON body contains multi-byte UTF-8 characters (byte length ≠ char length).
 */

const CR = 0x0d; // \r
const LF = 0x0a; // \n
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

export function encode(msg: string): Uint8Array {
	const body = new TextEncoder().encode(msg);
	const header = `Content-Length: ${body.length}\r\n\r\n`;
	const frame = new TextEncoder().encode(header);
	const result = new Uint8Array(frame.length + body.length);
	result.set(frame);
	result.set(body, frame.length);
	return result;
}

/**
 * Find the first occurrence of the 4-byte sequence \r\n\r\n in `buf`,
 * starting at offset `from`. Returns the index of the first byte, or -1.
 */
function findHeaderSep(buf: Uint8Array, from: number): number {
	const limit = buf.length - 3;
	for (let i = from; i < limit; i++) {
		if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === CR && buf[i + 3] === LF) {
			return i;
		}
	}
	return -1;
}

export class FrameDecoder {
	private buffer: Uint8Array = new Uint8Array(0);
	private expectedLength: number | null = null;
	private headerEndByte = -1;

	/**
	 * Feed raw bytes into the decoder. Returns all complete JSON messages
	 * that can be extracted from the accumulated buffer.
	 */
	decode(chunk: Uint8Array): string[] {
		// Append the new chunk to the internal byte buffer.
		const newBuf = new Uint8Array(this.buffer.length + chunk.length);
		newBuf.set(this.buffer);
		newBuf.set(chunk, this.buffer.length);
		this.buffer = newBuf;

		const messages: string[] = [];

		while (true) {
			if (this.expectedLength === null) {
				const sepIdx = findHeaderSep(this.buffer, 0);
				if (sepIdx === -1) break;

				// Decode only the header bytes (always ASCII) to read Content-Length.
				const headerStr = new TextDecoder().decode(this.buffer.slice(0, sepIdx));
				const match = CONTENT_LENGTH_RE.exec(headerStr);
				if (!match?.[1]) {
					// Not a Content-Length header — skip past this separator and retry.
					this.buffer = this.buffer.slice(sepIdx + 4);
					continue;
				}
				this.expectedLength = Number.parseInt(match[1], 10);
				this.headerEndByte = sepIdx + 4; // skip \r\n\r\n
			}

			const bodyStart = this.headerEndByte;
			const available = this.buffer.length - bodyStart;

			if (available >= this.expectedLength) {
				// Extract exactly `expectedLength` bytes (Content-Length is in bytes).
				const bodyBytes = this.buffer.slice(bodyStart, bodyStart + this.expectedLength);
				messages.push(new TextDecoder().decode(bodyBytes));
				this.buffer = this.buffer.slice(bodyStart + this.expectedLength);
				this.expectedLength = null;
				this.headerEndByte = -1;
			} else {
				break;
			}
		}

		return messages;
	}
}
