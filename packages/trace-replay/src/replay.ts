import type { CapturedRequest, FetchLike, HttpExchangeFixture } from "./types.js";

export interface ReplayOptions {
	chunkBytes?: number;
}

export interface ReplayResult {
	fetch: FetchLike;
	getCapturedRequest: () => CapturedRequest | undefined;
}

export function replayFetch(fixture: HttpExchangeFixture, opts?: ReplayOptions): ReplayResult {
	let captured: CapturedRequest | undefined;

	const replay: FetchLike = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = extractMethod(input, init);
		const headers = normalizeHeaders(
			init?.headers as Record<string, string> | Headers | [string, string][] | undefined,
		);
		const body =
			init?.body != null
				? await readBody(
						init.body as
							| string
							| Blob
							| ArrayBuffer
							| ArrayBufferView
							| URLSearchParams
							| ReadableStream,
					)
				: null;

		captured = { method, url, headers, body };

		const isNullBodyStatus =
			fixture.response.status === 204 ||
			fixture.response.status === 205 ||
			fixture.response.status === 304;
		const responseBody = isNullBodyStatus
			? null
			: buildBodyStream(fixture.response.body, opts?.chunkBytes);
		const responseInit: { status: number; headers: Record<string, string>; statusText?: string } = {
			status: fixture.response.status,
			headers: fixture.response.headers,
		};
		if (fixture.response.statusText !== undefined) {
			responseInit.statusText = fixture.response.statusText;
		}
		return new Response(responseBody, responseInit);
	};

	return {
		fetch: replay,
		getCapturedRequest: () => captured,
	};
}

function extractMethod(input: string | URL | Request, init: RequestInit | undefined): string {
	if (init?.method) return init.method;
	if (typeof input !== "string" && !(input instanceof URL) && "method" in input) {
		return input.method;
	}
	return "GET";
}

function normalizeHeaders(
	raw: Headers | Record<string, string> | [string, string][] | undefined,
): Record<string, string> {
	if (!raw) return {};
	if (raw instanceof Headers) {
		const out: Record<string, string> = {};
		raw.forEach((v, k) => {
			out[k] = v;
		});
		return out;
	}
	if (Array.isArray(raw)) {
		const out: Record<string, string> = {};
		for (const [k, v] of raw) out[k] = v;
		return out;
	}
	return { ...raw };
}

async function readBody(
	body: string | Blob | ArrayBuffer | ArrayBufferView | URLSearchParams | ReadableStream,
): Promise<string | null> {
	if (typeof body === "string") return body;
	if (body instanceof Blob) return body.text();
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer);
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof ReadableStream) {
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		return new TextDecoder().decode(concatUint8Arrays(chunks));
	}
	return null;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	let totalLen = 0;
	for (const a of arrays) totalLen += a.byteLength;
	const out = new Uint8Array(totalLen);
	let offset = 0;
	for (const a of arrays) {
		out.set(a, offset);
		offset += a.byteLength;
	}
	return out;
}

function buildBodyStream(body: string, chunkBytes: number | undefined): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(body);

	if (!chunkBytes || chunkBytes <= 0 || chunkBytes >= encoded.byteLength) {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoded);
				controller.close();
			},
		});
	}

	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= encoded.byteLength) {
				controller.close();
				return;
			}
			const end = Math.min(offset + chunkBytes, encoded.byteLength);
			controller.enqueue(encoded.slice(offset, end));
			offset = end;
		},
	});
}
