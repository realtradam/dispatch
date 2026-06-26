import type { FetchLike, HttpExchangeFixture } from "./types.js";

export type { FetchLike } from "./types.js";

export function recordFetch(
  realFetch: FetchLike,
  onExchange: (fx: HttpExchangeFixture) => void,
): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = extractMethod(input, init);
    const headers = normalizeHeaders(
      init?.headers as Record<string, string> | Headers | [string, string][] | undefined,
    );
    const reqBody =
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

    const response = await realFetch(input, init);
    const responseClone = response.clone();
    const responseBody = await responseClone.text();

    const fixture: HttpExchangeFixture = {
      request: { method, url, headers, body: reqBody },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: normalizeResponseHeaders(response.headers),
        body: responseBody,
      },
    };

    onExchange(fixture);
    return response;
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

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
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
