/**
 * LSP Content-Length framing codec.
 *
 * The LSP base protocol uses Content-Length headers to frame JSON messages.
 * `encode` wraps a JSON message with headers; `FrameDecoder` reassembles
 * complete messages from streaming byte chunks (handles partial frames and
 * multiple frames per chunk).
 */

const HEADER_SEP = "\r\n\r\n";
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)/i;

export function encode(msg: string): Uint8Array {
	const body = new TextEncoder().encode(msg);
	const header = `Content-Length: ${body.length}\r\n\r\n`;
	const frame = new TextEncoder().encode(header);
	const result = new Uint8Array(frame.length + body.length);
	result.set(frame);
	result.set(body, frame.length);
	return result;
}

export class FrameDecoder {
	private buffer = "";
	private expectedLength: number | null = null;
	private headerEnd = -1;

	/**
	 * Feed raw bytes into the decoder. Returns all complete JSON messages
	 * that can be extracted from the accumulated buffer.
	 */
	decode(chunk: Uint8Array): string[] {
		this.buffer += new TextDecoder().decode(chunk);
		const messages: string[] = [];

		while (true) {
			if (this.expectedLength === null) {
				const headerEnd = this.buffer.indexOf(HEADER_SEP);
				if (headerEnd === -1) break;

				const headerPart = this.buffer.slice(0, headerEnd);
				const match = CONTENT_LENGTH_RE.exec(headerPart);
				if (!match?.[1]) {
					this.buffer = this.buffer.slice(headerEnd + HEADER_SEP.length);
					continue;
				}
				this.expectedLength = Number.parseInt(match[1], 10);
				this.headerEnd = headerEnd;
			}

			const bodyStart = this.headerEnd + HEADER_SEP.length;
			const available = this.buffer.length - bodyStart;

			if (available >= this.expectedLength) {
				const body = this.buffer.slice(bodyStart, bodyStart + this.expectedLength);
				messages.push(body);
				this.buffer = this.buffer.slice(bodyStart + this.expectedLength);
				this.expectedLength = null;
				this.headerEnd = -1;
			} else {
				break;
			}
		}

		return messages;
	}
}
