import type { OpenAIContentPart, OpenAIMessage, OpenAITextPart } from "./convert-messages.js";

/**
 * Default ceiling for a single provider request body: 9.5 MiB. The charm
 * gateway (hyper.charm.land) hard-rejects bodies larger than 10 MiB
 * (10,485,760 bytes) with HTTP 400 "invalid request body"; 9.5 MiB leaves
 * headroom for JSON escaping and HTTP/header overhead while staying safely
 * under the cap.
 */
export const DEFAULT_MAX_BODY_BYTES = 9_500_000;

/** UTF-8 byte length of a string — the default injected measurement. */
export function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** What was dropped when a request body exceeded the provider's size budget. */
export interface BodyEvictionReport {
  /** Number of inline `image_url` parts replaced with placeholder text. */
  readonly imagesEvicted: number;
  /** Measured UTF-8 bytes freed (body bytes before − body bytes after). */
  readonly bytesFreed: number;
}

/**
 * Trailing phrase shared by every eviction placeholder — the user must be able
 * to tell WHY the image is missing when they read the captured request.
 */
const DROPPED_SUFFIX = " — dropped to keep the request under the provider's body-size limit";

/**
 * Human-sized approximation of a size, derived from the base64 length, e.g.
 * `~450 KB`, `~3 MB`, `~900 B`.
 */
function formatApproxSize(encodedLength: number): string {
  if (encodedLength < 1024) return `~${encodedLength} B`;
  if (encodedLength < 1024 * 1024) return `~${Math.round(encodedLength / 1024)} KB`;
  return `~${Math.round(encodedLength / (1024 * 1024))} MB`;
}

/**
 * MimeType of a `data:` URL, e.g. `data:image/png;base64,…` → `image/png`.
 * `undefined` when nothing is inferrable (http(s) URLs, `data:;base64,…`).
 */
function inferMimeType(url: string): string | undefined {
  if (!url.startsWith("data:")) return undefined;
  const rest = url.slice("data:".length);
  const semi = rest.indexOf(";");
  const comma = rest.indexOf(",");
  if (semi === -1 || comma === -1 || semi === 0) return undefined;
  return rest.slice(0, semi);
}

/**
 * Approximate size of an inline image, derived from its base64 payload
 * length. Base64 carries ~33% overhead over the raw bytes, so the encoded
 * length is a good (slightly pessimistic) approximation of the image's size —
 * and it is exact for the ASCII payloads that `data:` URLs always are.
 */
function approximateImageSize(url: string): number {
  const comma = url.indexOf(",");
  return comma >= 0 ? url.length - comma - 1 : url.length;
}

/**
 * The placeholder text that replaces an evicted inline image part, e.g.
 * `[image omitted: image/png, ~450 KB — dropped to keep the request under the provider's body-size limit]`.
 */
function buildPlaceholder(url: string): string {
  const size = formatApproxSize(approximateImageSize(url));
  const mime = inferMimeType(url);
  const head = mime !== undefined ? `[image omitted: ${mime}, ${size}` : `[image omitted, ${size}`;
  return `${head}${DROPPED_SUFFIX}]`;
}

/**
 * Enforce a provider request-body budget by evicting inline `image_url`
 * parts, oldest first, and replacing each IN PLACE with a placeholder text
 * part (so a message's content array never becomes empty).
 *
 * Pure: decision logic only, no I/O. Byte measurement is injectable so tests
 * stay deterministic; it defaults to UTF-8 byte length via `Buffer`.
 *
 * - While `JSON.stringify(body)` exceeds `maxBodyBytes`, evicts the oldest
 *   `image_url` part (messages scanned in array order, parts in order).
 * - Stops as soon as the body fits within the budget, or when no image parts
 *   remain — a body still over budget with zero images is returned as-is
 *   (best effort). Never touches anything except `image_url` parts.
 * - Eviction happens on the caller's body object: the mutated `body` IS the
 *   result, so the caller must re-stringify it before sending.
 *
 * @returns `null` when the body already fits within the budget; otherwise a
 *   report of what was evicted (`imagesEvicted: 0` means the body was over
 *   budget but no image parts were available to drop).
 */
export function enforceBodyBudget(
  body: Record<string, unknown>,
  maxBodyBytes: number,
  byteLength: (s: string) => number = byteLengthUtf8,
): BodyEvictionReport | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;

  let bodyString = JSON.stringify(body) ?? "";
  let bodyBytes = byteLength(bodyString);
  if (bodyBytes <= maxBodyBytes) return null;

  const bytesBefore = bodyBytes;
  const openaiMessages = messages as OpenAIMessage[];
  let imagesEvicted = 0;

  for (const message of openaiMessages) {
    if (bodyBytes <= maxBodyBytes) break;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const parts = content as OpenAIContentPart[];
    for (let i = 0; i < parts.length; i++) {
      if (bodyBytes <= maxBodyBytes) break;
      const part = parts[i];
      if (!part || typeof part !== "object") continue;
      if (part.type !== "image_url") continue;
      const placeholder: OpenAITextPart = {
        type: "text",
        text: buildPlaceholder(part.image_url.url),
      };
      parts[i] = placeholder;
      imagesEvicted++;
      bodyString = JSON.stringify(body) ?? "";
      bodyBytes = byteLength(bodyString);
    }
  }

  return { imagesEvicted, bytesFreed: bytesBefore - bodyBytes };
}
