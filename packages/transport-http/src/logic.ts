import { extname, isAbsolute, join } from "node:path";
import type {
  AgentEvent,
  ChatMessage,
  ConversationStatus,
  ReasoningEffort,
  StoredChunk,
} from "@dispatch/kernel";
import type { PluginOpResponse, SetTabGroupRequest } from "@dispatch/transport-contract";
import type { NamedAgentSelectionSnapshot } from "@dispatch/wire";

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const VALID_STATUSES: readonly ConversationStatus[] = ["active", "queued", "idle", "closed"];

/**
 * Pure HTTP history projection: omit provider-opaque thinking replay fields,
 * preserving every row (including empty/redacted thinking) and its metadata.
 * Store/provider history remains untouched.
 */
export function projectHistoryChunks(chunks: readonly StoredChunk[]): readonly StoredChunk[] {
  return chunks.map((row) => {
    if (row.chunk.type !== "thinking") return row;
    const { signature: _signature, redactedData: _redactedData, ...chunk } = row.chunk;
    return { ...row, chunk };
  });
}

/**
 * Pure: parse a `?status=` query value into a list of valid ConversationStatus
 * values. Returns `undefined` when the input is missing/empty (no filter).
 * Invalid values are silently dropped; if ALL values are invalid, returns
 * `undefined` (no filter — shows all).
 */
export function parseStatusFilter(
  raw: string | undefined,
): readonly ConversationStatus[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const valid = parts.filter((p): p is ConversationStatus =>
    VALID_STATUSES.includes(p as ConversationStatus),
  );
  return valid.length > 0 ? valid : undefined;
}

export function isValidReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && VALID_REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/**
 * Pure: validate that a value is a conforming `NamedAgentSelectionSnapshot` —
 * an object with non-empty string `namedAgentId`, `namedAgentName`, and
 * `model` (the resolved raw `<credential>/<model>` frozen at selection time).
 * Used by the chat + set-model body parsers to reject a malformed snapshot
 * with a 400 rather than persisting garbage.
 */
export function isValidNamedAgentSelectionSnapshot(
  value: unknown,
): value is NamedAgentSelectionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snap = value as Record<string, unknown>;
  return (
    typeof snap.namedAgentId === "string" &&
    snap.namedAgentId.length > 0 &&
    typeof snap.namedAgentName === "string" &&
    typeof snap.model === "string" &&
    snap.model.length > 0
  );
}

export interface ChatCommand {
  readonly conversationId: string;
  readonly message: string;
  readonly model?: string;
  readonly cwd?: string;
  /**
   * Per-turn computer override (SSH `Host` alias). Mirrors `cwd`: forwarded
   * to the orchestrator verbatim and never part of the model prompt. When
   * absent, the orchestrator resolves the per-conversation → workspace
   * default → local chain.
   */
  readonly computerId?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly workspaceId?: string;
  /**
   * A human-readable title for the conversation tab, set at creation time.
   * Parsed from the `ChatRequest.title` field; trimmed server-side. A
   * whitespace-only value is treated as absent (omitted) so the auto-derived
   * title applies. Forwarded to the orchestrator, which persists it via the
   * conversation store's `setConversationTitle` AFTER the new-conversation
   * workspace setup (so workspace assignment / first-turn system-prompt
   * construction are not skipped) and before the first message append.
   */
  readonly title?: string;
  /**
   * Images attached to this turn (data URLs or http URLs). Parsed from the
   * `ChatRequest.images` field; forwarded to the orchestrator which converts
   * them to `image` chunks on the user message. Each entry must have a non-empty
   * string `url`; `mimeType` is optional.
   */
  readonly images?: readonly { readonly url: string; readonly mimeType?: string }[];
  /**
   * Named Agent selection snapshot to persist on the conversation at creation
   * (parsed from `ChatRequest.namedAgent`). When present, the chat route
   * persists it alongside the model via `setNamedAgentSelection` (fail-open —
   * a snapshot write error never fails the turn). Omit for a raw-model
   * conversation (backward compatible). Validated by
   * {@link isValidNamedAgentSelectionSnapshot}.
   */
  readonly namedAgent?: NamedAgentSelectionSnapshot;
}

export interface ParseError {
  readonly error: string;
}

export type ParseResult = ChatCommand | ParseError;

export type SinceSeqResult = number | ParseError;

export function parseChatBody(body: unknown, generateId: () => string): ParseResult {
  if (body === null || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  const message = obj.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    return { error: "Field 'message' is required and must be a non-empty string" };
  }

  const conversationId =
    typeof obj.conversationId === "string" && obj.conversationId.length > 0
      ? obj.conversationId
      : generateId();

  const result: ChatCommand = { conversationId, message: message.trim() };

  if (obj.model !== undefined) {
    if (typeof obj.model !== "string") {
      return { error: "Field 'model' must be a string" };
    }
    (result as { model?: string }).model = obj.model;
  }

  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") {
      return { error: "Field 'cwd' must be a string" };
    }
    (result as { cwd?: string }).cwd = obj.cwd;
  }

  if (obj.computerId !== undefined) {
    if (typeof obj.computerId !== "string") {
      return { error: "Field 'computerId' must be a string" };
    }
    (result as { computerId?: string }).computerId = obj.computerId;
  }

  if (obj.reasoningEffort !== undefined) {
    if (!isValidReasoningEffort(obj.reasoningEffort)) {
      return {
        error: `Field 'reasoningEffort' must be one of: ${VALID_REASONING_EFFORTS.join(", ")}`,
      };
    }
    (result as { reasoningEffort?: ReasoningEffort }).reasoningEffort = obj.reasoningEffort;
  }

  if (obj.workspaceId !== undefined) {
    if (typeof obj.workspaceId !== "string") {
      return { error: "Field 'workspaceId' must be a string" };
    }
    (result as { workspaceId?: string }).workspaceId = obj.workspaceId;
  }

  if (obj.title !== undefined) {
    if (typeof obj.title !== "string") {
      return { error: "Field 'title' must be a string" };
    }
    const title = obj.title.trim();
    // A whitespace-only title is treated as absent so the auto-derived title
    // applies (mirrors omitting the field) — never persist an empty title.
    if (title.length > 0) {
      (result as { title?: string }).title = title;
    }
  }

  if (obj.images !== undefined) {
    if (!Array.isArray(obj.images)) {
      return { error: "Field 'images' must be an array" };
    }
    const images: { url: string; mimeType?: string }[] = [];
    for (const entry of obj.images) {
      if (entry === null || typeof entry !== "object") {
        return { error: "Each image must be an object with a 'url' string" };
      }
      const img = entry as { url?: unknown; mimeType?: unknown };
      if (typeof img.url !== "string" || img.url.length === 0) {
        return { error: "Each image must have a non-empty string 'url'" };
      }
      const parsed: { url: string; mimeType?: string } = { url: img.url };
      if (img.mimeType !== undefined) {
        if (typeof img.mimeType !== "string") {
          return { error: "Field 'mimeType' on an image must be a string" };
        }
        parsed.mimeType = img.mimeType;
      }
      images.push(parsed);
    }
    if (images.length > 0) {
      (result as { images?: readonly { url: string; mimeType?: string }[] }).images = images;
    }
  }

  if (obj.namedAgent !== undefined) {
    if (!isValidNamedAgentSelectionSnapshot(obj.namedAgent)) {
      return {
        error:
          "Field 'namedAgent' must be a NamedAgentSelectionSnapshot with non-empty string namedAgentId, namedAgentName, and model",
      };
    }
    (result as { namedAgent?: NamedAgentSelectionSnapshot }).namedAgent = obj.namedAgent;
  }

  return result;
}

export function isParseError<T>(result: T | ParseError): result is ParseError {
  return typeof result === "object" && result !== null && "error" in result;
}

export function serializeEventLine(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseSinceSeq(raw: string | undefined): SinceSeqResult {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return { error: "sinceSeq must be a non-negative integer" };
  }
  return n;
}

export function isSinceSeqError(result: SinceSeqResult): result is ParseError {
  return typeof result === "object";
}

/**
 * Result of parsing an OPTIONAL positive-integer history-window query param
 * (`limit` / `beforeSeq`): `undefined` = the param was absent (omit it from the
 * store window), a `number` = a valid positive integer, or a {@link ParseError}
 * for a malformed / zero / negative value (the route 400s on it).
 */
export type WindowParamResult = number | undefined | ParseError;

/**
 * Parse an optional `limit` / `beforeSeq` query param. Unlike `sinceSeq` these
 * must be STRICTLY POSITIVE integers when present (zero is rejected, since the
 * store treats a zero bound as absent and would silently return the full log).
 * Absent (`undefined` / empty) is the valid "no window" case → `undefined`.
 */
export function parseWindowParam(raw: string | undefined, name: string): WindowParamResult {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `${name} must be a positive integer` };
  }
  return n;
}

export function isWindowParamError(result: WindowParamResult): result is ParseError {
  return typeof result === "object" && result !== null;
}

export interface WarmBodyParsed {
  readonly conversationId: string;
  readonly model?: string;
  readonly cwd?: string;
}

export function parseWarmBody(body: unknown): WarmBodyParsed | ParseError {
  if (body === null || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  const conversationId = obj.conversationId;
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return { error: "Field 'conversationId' is required and must be a non-empty string" };
  }

  const result: Record<string, unknown> = { conversationId };

  if (obj.model !== undefined) {
    if (typeof obj.model !== "string") {
      return { error: "Field 'model' must be a string" };
    }
    result.model = obj.model;
  }

  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") {
      return { error: "Field 'cwd' must be a string" };
    }
    result.cwd = obj.cwd;
  }

  return result as unknown as WarmBodyParsed;
}

export function computeCachePct(inputTokens: number, cacheReadTokens: number): number {
  if (inputTokens <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, cacheReadTokens / inputTokens)) * 100);
}

export function computeExpectedCacheRate(
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const denom = cacheReadTokens + cacheWriteTokens;
  if (denom <= 0) return 0;
  return Math.round((cacheReadTokens / denom) * 100);
}

/**
 * Parsed body for `POST /conversations/:id/queue` (`QueueRequest`). Only the
 * `text` field — `conversationId` comes from the path param, not the body, so it
 * is deliberately NOT part of this parse result.
 */
export interface QueueBodyParsed {
  readonly text: string;
  readonly workspaceId?: string;
}

/**
 * Parse + validate a `POST /conversations/:id/queue` body (`QueueRequest`).
 * `text` must be a non-empty string after trim — invalid/missing →
 * {@link ParseError}. The TRIMMED text is returned (forwarded to
 * `orchestrator.enqueue`), mirroring how `parseChatBody` forwards a trimmed
 * `message`.
 */
export function parseQueueBody(body: unknown): QueueBodyParsed | ParseError {
  if (body === null || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  const text = obj.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: "Field 'text' is required and must be a non-empty string" };
  }

  const result: QueueBodyParsed = { text: text.trim() };

  if (obj.workspaceId !== undefined) {
    if (typeof obj.workspaceId !== "string") {
      return { error: "Field 'workspaceId' must be a string" };
    }
    return { text: text.trim(), workspaceId: obj.workspaceId };
  }

  return result;
}

export function parseReasoningEffortBody(body: unknown): ReasoningEffort | ParseError {
  if (body === null || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  if (!isValidReasoningEffort(obj.reasoningEffort)) {
    return {
      error: `Field 'reasoningEffort' is required and must be one of: ${VALID_REASONING_EFFORTS.join(", ")}`,
    };
  }
  return obj.reasoningEffort;
}

export function isReasoningEffortParseError(
  result: ReasoningEffort | ParseError,
): result is ParseError {
  return typeof result === "object" && result !== null && "error" in result;
}

/**
 * Parsed body for `PUT /conversations/:id/model` (`SetModelRequest`): the
 * validated `model` (`string | null`) plus an optional Named Agent selection
 * snapshot. `model` must be present and either a string (any value, including
 * the empty string — which clears the persisted selection) or `null`. A missing
 * field or a non-string/non-null value → {@link ParseError}. There is no enum
 * validation (the provider resolves model names at turn time). `namedAgent`,
 * when present, must be a conforming {@link NamedAgentSelectionSnapshot}.
 */
export interface SetModelBodyParsed {
  readonly model: string | null;
  readonly namedAgent?: NamedAgentSelectionSnapshot;
}

/**
 * Parse + validate a `PUT /conversations/:id/model` body (`SetModelRequest`).
 * Returns the validated `model` plus any `namedAgent` snapshot on success, or a
 * {@link ParseError} for a malformed body.
 */
export function parseModelBody(body: unknown): SetModelBodyParsed | ParseError {
  if (body === null || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  if (obj.model === undefined) {
    return { error: "Field 'model' is required and must be a string or null" };
  }
  if (obj.model !== null && typeof obj.model !== "string") {
    return { error: "Field 'model' must be a string or null" };
  }
  const model = obj.model as string | null;
  if (obj.namedAgent !== undefined) {
    if (!isValidNamedAgentSelectionSnapshot(obj.namedAgent)) {
      return {
        error:
          "Field 'namedAgent' must be a NamedAgentSelectionSnapshot with non-empty string namedAgentId, namedAgentName, and model",
      };
    }
    return { model, namedAgent: obj.namedAgent };
  }
  return { model };
}

export function isModelParseError(result: SetModelBodyParsed | ParseError): result is ParseError {
  return typeof result === "object" && result !== null && "error" in result;
}

// ─── Named Agent service error → HTTP status mapping (pure) ──────────────────

/** The typed error strings the Named Agent registry returns from `create`. */
export type NamedAgentCreateError = "duplicate-name" | "invalid-name" | "invalid-model";

/**
 * The typed error strings the registry returns from `update` — `create`'s set
 * plus `not-found` (the targeted id does not exist).
 */
export type NamedAgentUpdateError = NamedAgentCreateError | "not-found";

/**
 * Pure: map a Named Agent registry `create` error to an HTTP status + message.
 * `duplicate-name` → 409; `invalid-name`/`invalid-model` → 400. The caller
 * wraps a non-typed (storage) failure as 500 separately. The `status` is a
 * literal union (not `number`) so it satisfies Hono's `ContentfulStatusCode`
 * without the pure core importing a web framework type.
 */
export function mapCreateError(error: NamedAgentCreateError): {
  readonly status: 400 | 409;
  readonly message: string;
} {
  switch (error) {
    case "duplicate-name":
      return {
        status: 409,
        message: "A Named Agent with this name already exists",
      };
    case "invalid-name":
      return {
        status: 400,
        message: "Field 'name' is required and must be a non-empty string",
      };
    case "invalid-model":
      return {
        status: 400,
        message: "Field 'model' must be a valid canonical model identifier (<provider>/<model>)",
      };
  }
}

/**
 * Pure: map a Named Agent registry `update` error to an HTTP status + message.
 * `not-found` → 404; otherwise delegates to {@link mapCreateError}.
 */
export function mapUpdateError(error: NamedAgentUpdateError): {
  readonly status: 400 | 404 | 409;
  readonly message: string;
} {
  if (error === "not-found") {
    return { status: 404, message: "Named Agent not found" };
  }
  return mapCreateError(error);
}

/**
 * Extract the text of the last assistant message's last `text` chunk — the
 * "show me the last reply" affordance for `GET /conversations/:id/last`.
 *
 * Scan from the END for the last message with `role: "assistant"`, then within
 * THAT message for the last `type: "text"` chunk. Returns its `text`. Returns
 * `""` when there is no assistant message, or when the last assistant message
 * has no text chunk (e.g. only tool-call chunks).
 *
 * Pure (input → output); zero I/O, so it tests directly without mocks.
 */
export function extractLastAssistantText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== "assistant") continue;
    // Found the last assistant message — scan its chunks from the end for
    // the last `text` chunk. Stop here (do not keep scanning earlier
    // assistant messages): the contract is "the last assistant message's
    // last text chunk", not "the most recent text chunk anywhere".
    for (let j = msg.chunks.length - 1; j >= 0; j--) {
      const chunk = msg.chunks[j];
      if (chunk !== undefined && chunk.type === "text") {
        return chunk.text;
      }
    }
    return "";
  }
  return "";
}

/**
 * Pure: parse the `{ force?: boolean }` body of the plugin unload/reload
 * routes. An ABSENT body is valid (force defaults to false — the routes are
 * POSTs with an optional JSON body). Malformed JSON or a non-boolean `force`
 * is rejected. Everything else about the body is ignored (isolation over
 * strictness — extra fields are not an error).
 */
export function parsePluginForceBody(
  raw: string,
): { readonly ok: true; readonly force: boolean } | { readonly ok: false; readonly error: string } {
  if (raw.trim().length === 0) return { ok: true, force: false };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const force = (body as Record<string, unknown>).force;
  if (force !== undefined && typeof force !== "boolean") {
    return { ok: false, error: "Field 'force' must be a boolean" };
  }
  return { ok: true, force: force === true };
}

/**
 * Pure: map a `PluginOpResponse` to its HTTP status. Success → 200;
 * `not-found` → 404 (no such plugin); every other refusal is a
 * blocked-with-reason → 409 (per plan 05's route contract: the client shows
 * the message and, for `cascade-needs-force`, the dependents).
 */
export function pluginOpStatus(response: PluginOpResponse): 200 | 404 | 409 {
  if (response.ok) return 200;
  return response.reason === "not-found" ? 404 : 409;
}

/** Validate without normalizing ids: they are opaque identifiers, not titles. */
export function parseTabGroupBody(body: unknown): SetTabGroupRequest | ParseError {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }
  const parentId = (body as Record<string, unknown>).parentId;
  if (parentId !== null && (typeof parentId !== "string" || parentId.trim().length === 0)) {
    return { error: "Field 'parentId' must be a non-empty string or null" };
  }
  return { parentId };
}

// ── Local image serving (Markdown image embedding) ──────────────────────────

/**
 * Extension → MIME whitelist for `GET /local-image`. Raster formats only:
 * SVG is deliberately excluded (it can carry script — an XSS vector).
 */
const LOCAL_IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface LocalImageRequest {
  /** Absolute filesystem path (after `~` expansion). */
  readonly path: string;
  /** Lowercased extension, one of the whitelist keys. */
  readonly extension: string;
  readonly mime: string;
}

export interface LocalImageRequestError {
  readonly error: string;
}

/** Type guard for the `parseLocalImageRequest` union. */
export function isLocalImageRequestError(
  value: LocalImageRequest | LocalImageRequestError,
): value is LocalImageRequestError {
  return "error" in value;
}

/** Expand a single leading `~` to the OS home directory. */
function expandLeadingHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

/**
 * Pure: validate + normalize the `path` query param of `GET /local-image`.
 * Expands a leading `~`, requires an absolute path, and checks the extension
 * against the raster whitelist. Magic bytes are checked separately, once the
 * file has been read.
 */
export function parseLocalImageRequest(
  rawPath: string | undefined,
  homeDir: string,
): LocalImageRequest | LocalImageRequestError {
  if (rawPath === undefined || rawPath === "") {
    return { error: "Query param 'path' must be a non-empty absolute path" };
  }
  const path = expandLeadingHome(rawPath, homeDir);
  if (!isAbsolute(path)) {
    return { error: "Query param 'path' must be an absolute path" };
  }
  const extension = extname(path).toLowerCase();
  const mime = LOCAL_IMAGE_MIME[extension];
  if (mime === undefined) {
    return { error: "Unsupported image extension" };
  }
  return { path, extension, mime };
}

// Cheap per-format headers. PNG's first four bytes are enough to distinguish
// it; WEBP is a RIFF container with "WEBP" at offset 8.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38] as const; // "GIF8"
const BMP_MAGIC = [0x42, 0x4d] as const; // "BM"
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP" at offset 8

function startsWithBytes(buf: Uint8Array, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Pure: does the buffer's header match the extension it claims? A mismatch
 * means the file is not the image type its name says, so the route refuses to
 * serve it — guaranteeing the endpoint can never serve a non-image file.
 */
export function matchesImageMagicBytes(buf: Uint8Array, extension: string): boolean {
  switch (extension) {
    case ".png":
      return startsWithBytes(buf, PNG_MAGIC);
    case ".jpg":
    case ".jpeg":
      return startsWithBytes(buf, JPEG_MAGIC);
    case ".gif":
      return startsWithBytes(buf, GIF_MAGIC);
    case ".bmp":
      return startsWithBytes(buf, BMP_MAGIC);
    case ".webp":
      return (
        startsWithBytes(buf, RIFF_MAGIC) &&
        buf.length >= 12 &&
        startsWithBytes(buf.subarray(8), WEBP_MAGIC)
      );
    default:
      return false;
  }
}
