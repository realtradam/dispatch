/**
 * Pure repair helpers for corrupted transcripts — packages/conversation-store.
 *
 * The `dedupeDuplicateToolChunks` pass removes duplicate `tool-call` /
 * `tool-result` chunks (same `toolCallId` more than once in a message) that a
 * provider double-emission can persist (see notes/fix-toolcall-duplicate-keys
 * plan Part 3). The kernel now prevents NEW duplicates; this pass repairs
 * ALREADY-PERSISTED ones (used by the one-shot repair script). It is also the
 * canonical, unit-tested home of the dedupe rule so the script's behavior is
 * verified rather than inline-duplicated.
 *
 * Pure: `ChatMessage[]` in, deduped `ChatMessage[]` out. No storage, no logger.
 */
import type { ChatMessage, Chunk } from "@dispatch/wire";

export interface DedupeResult {
  readonly messages: readonly ChatMessage[];
  /** Total chunks removed across all messages. */
  readonly removedChunks: number;
  /** The toolCallIds that had at least one duplicate removed (unique). */
  readonly removedIds: readonly string[];
}

/**
 * For EACH message independently, keep the first occurrence of every
 * `toolCallId` among its `tool-call` / `tool-result` chunks and drop later
 * duplicates. Non-tool chunks (text, thinking, image, …) pass through
 * untouched. A message with no duplicates is returned by reference (no churn).
 */
export function dedupeDuplicateToolChunks(messages: readonly ChatMessage[]): DedupeResult {
  let removedChunks = 0;
  const removedIds = new Set<string>();

  const fixed = messages.map((m) => {
    const seen = new Set<string>();
    let msgRemoved = 0;
    const chunks: Chunk[] = [];
    for (const chunk of m.chunks) {
      if (chunk.type === "tool-call" || chunk.type === "tool-result") {
        if (seen.has(chunk.toolCallId)) {
          msgRemoved++;
          removedIds.add(chunk.toolCallId);
          continue;
        }
        seen.add(chunk.toolCallId);
      }
      chunks.push(chunk);
    }
    removedChunks += msgRemoved;
    return msgRemoved > 0 ? { role: m.role, chunks } : m;
  });

  return { messages: fixed, removedChunks, removedIds: [...removedIds] };
}

/**
 * Total chunk count across messages — handy for before/after repair reports.
 */
export function countChunks(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += m.chunks.length;
  return n;
}
