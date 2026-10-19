import { createHash } from "node:crypto";

const SEQ_PAD = 10;

export function seqKey(conversationId: string): string {
  return `conv:${conversationId}:seq`;
}

export function chunkKey(conversationId: string, seq: number): string {
  return `conv:${conversationId}:chunk:${String(seq).padStart(SEQ_PAD, "0")}`;
}

export function chunkPrefix(conversationId: string): string {
  return `conv:${conversationId}:chunk:`;
}

export function parseSeq(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function parseChunkSeq(key: string): number {
  const parts = key.split(":");
  const last = parts[parts.length - 1];
  if (last === undefined) return -1;
  const n = Number.parseInt(last, 10);
  return Number.isNaN(n) ? -1 : n;
}

export function metricsSeqKey(conversationId: string): string {
  return `conv:${conversationId}:metrics-seq`;
}

export function metricsKey(conversationId: string, ordinal: number): string {
  return `conv:${conversationId}:metrics:${String(ordinal).padStart(SEQ_PAD, "0")}`;
}

export function metricsPrefix(conversationId: string): string {
  return `conv:${conversationId}:metrics:`;
}

export function parseMetricsOrdinal(key: string): number {
  const parts = key.split(":");
  const last = parts[parts.length - 1];
  if (last === undefined) return -1;
  const n = Number.parseInt(last, 10);
  return Number.isNaN(n) ? -1 : n;
}

export function cwdKey(conversationId: string): string {
  return `conv:${conversationId}:cwd`;
}

export function computerKey(conversationId: string): string {
  return `conv:${conversationId}:computer`;
}

export function reasoningEffortKey(conversationId: string): string {
  return `conv:${conversationId}:reasoning-effort`;
}

export function modelKey(conversationId: string): string {
  return `conv:${conversationId}:model`;
}

/** The parent conversation id for a spawned/forked conversation (plain string value). */
export function parentKey(conversationId: string): string {
  return `conv:${conversationId}:parent`;
}

/** Visual group override: plain id, or empty string for explicitly ungrouped. */
export function tabGroupParentKey(conversationId: string): string {
  return `conv:${conversationId}:tab-group-parent`;
}

/** The per-conversation tool policy (JSON `ConversationToolPolicy`). */
export function toolPolicyKey(conversationId: string): string {
  return `conv:${conversationId}:toolpolicy`;
}

/**
 * The per-conversation Named Agent selection snapshot (JSON
 * `NamedAgentSelectionSnapshot`) — freezes HOW a conversation was selected so
 * later edits/deletes of the Named Agent never change an existing conversation.
 */
export function namedAgentSelectionKey(conversationId: string): string {
  return `conv:${conversationId}:named-agent-selection`;
}

export function compactThresholdKey(conversationId: string): string {
  return `conv:${conversationId}:compact-percent`;
}

/**
 * The LEGACY per-conversation image transcription cache key: one JSON object
 * mapping (resolved) image URL → transcription text. Retained only for
 * migration / deletion — the runtime uses {@link imageTranscriptionKey}.
 */
export function legacyImageTranscriptionsKey(conversationId: string): string {
  return `conv:${conversationId}:image-transcriptions`;
}

/**
 * SHA-256 hex digest of a persisted image URL. The transcription cache key is
 * derived from the URL **as stored in history** (the compact `/images/...` URL
 * or a legacy inline `data:` URL) — never the resolved data URL — so the key is
 * stable regardless of whether the temp file still exists, and cheap to compute
 * without reading the image. Pure given the URL string.
 */
export function hashImageUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * The per-image transcription cache key:
 * `conv:<id>:image-transcription:<sha256-hex(persistedUrl)>`. Note the SINGULAR
 * `image-transcription:` segment (with the trailing colon) — it does not match
 * the legacy `conv:<id>:image-transcriptions` key, so prefix scans cannot
 * confuse them.
 */
export function imageTranscriptionKey(conversationId: string, url: string): string {
  return `${imageTranscriptionPrefix(conversationId)}${hashImageUrl(url)}`;
}

/** Prefix of every per-image transcription row for a conversation. */
export function imageTranscriptionPrefix(conversationId: string): string {
  return `conv:${conversationId}:image-transcription:`;
}

/** Global vision settings (image compaction limit + compaction model). */
export const VISION_SETTINGS_KEY = "vision-settings";

export function metaKey(conversationId: string): string {
  return `conv:${conversationId}:meta`;
}

export function workspaceKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export const CONVERSATION_INDEX_KEY = "conv-index";
