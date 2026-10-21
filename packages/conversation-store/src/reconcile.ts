import type { ChatMessage, ToolCallChunk, ToolResultChunk } from "@dispatch/kernel";

export interface ReconcileReport {
  readonly repairedCount: number;
  readonly repairedToolCallIds: readonly string[];
  /** Number of `error` chunks stripped from assistant messages. */
  readonly strippedErrorChunks: number;
  /** Number of messages dropped after stripping errors or orphan results left them empty. */
  readonly droppedEmptyMessages: number;
  /** Number of tool-result chunks dropped because no assistant tool-call precedes them. */
  readonly droppedOrphanToolResults: number;
}

export interface ReconcileResult {
  readonly messages: ChatMessage[];
  readonly report: ReconcileReport;
}

export function reconcileWithReport(messages: readonly ChatMessage[]): ReconcileResult {
  // Phase 1: strip `error` chunks from assistant messages. An error chunk is a
  // failed-generation marker, never valid provider content — removing it here
  // (on load, before any provider sees the messages) auto-repairs broken chats
  // with no DB surgery (append-only storage untouched).
  let strippedErrorChunks = 0;
  const stripped: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.chunks.some((c) => c.type === "error")) {
      const filtered = msg.chunks.filter((chunk) => {
        if (chunk.type === "error") {
          strippedErrorChunks++;
          return false;
        }
        return true;
      });
      stripped.push({ role: msg.role, chunks: filtered });
    } else {
      stripped.push(msg);
    }
  }

  // Phase 2: drop assistant messages left with no `text`, `tool-call`, or
  // `thinking` chunks after stripping (the now-empty error-only message).
  // Thinking counts even with empty text: a signature-only or redacted chunk
  // carries opaque provider replay content. Never normalize or merge it.
  // Dropping an empty message unblocks continuation: it serializes to nothing
  // a provider understands. Phase 3 removes any orphan results that follow it.
  let droppedEmptyMessages = 0;
  const pruned: ChatMessage[] = [];
  for (const msg of stripped) {
    if (msg.role === "assistant") {
      const hasContent = msg.chunks.some(
        (chunk) => chunk.type === "text" || chunk.type === "tool-call" || chunk.type === "thinking",
      );
      if (!hasContent) {
        droppedEmptyMessages++;
        continue;
      }
    }
    pruned.push(msg);
  }

  // Phase 3: drop tool results without a preceding assistant call. Do this
  // before synthesis so a premature result cannot hide a later unfinished call.
  let droppedOrphanToolResults = 0;
  const precedingCalls = new Set<string>();
  const matched: ChatMessage[] = [];
  for (const msg of pruned) {
    const chunks = msg.chunks.filter((chunk) => {
      if (chunk.type === "tool-result" && !precedingCalls.has(chunk.toolCallId)) {
        droppedOrphanToolResults++;
        return false;
      }
      return true;
    });
    if (chunks.length !== msg.chunks.length) {
      if (chunks.length === 0) {
        droppedEmptyMessages++;
        continue;
      }
      matched.push({ ...msg, chunks });
    } else {
      matched.push(msg);
    }
    if (msg.role === "assistant") {
      for (const chunk of chunks) {
        if (chunk.type === "tool-call") precedingCalls.add(chunk.toolCallId);
      }
    }
  }

  // Phase 4: orphaned-tool-call synthesis (unchanged) on what remains.
  const resolvedIds = new Set<string>();
  for (const msg of matched) {
    for (const chunk of msg.chunks) {
      if (chunk.type === "tool-result") {
        resolvedIds.add(chunk.toolCallId);
      }
    }
  }

  const orphaned: ToolCallChunk[] = [];
  for (const msg of matched) {
    if (msg.role !== "assistant") continue;
    for (const chunk of msg.chunks) {
      if (chunk.type === "tool-call" && !resolvedIds.has(chunk.toolCallId)) {
        orphaned.push(chunk);
      }
    }
  }

  const result: ChatMessage[] = [...matched];

  for (const call of orphaned) {
    const base = {
      type: "tool-result" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      content: "interrupted: tool execution did not complete",
      isError: true,
    };
    const synthesized: ToolResultChunk =
      call.stepId !== undefined ? { ...base, stepId: call.stepId } : base;
    result.push({ role: "tool", chunks: [synthesized] });
  }

  return {
    messages: result,
    report: {
      repairedCount: orphaned.length,
      repairedToolCallIds: orphaned.map((c) => c.toolCallId),
      strippedErrorChunks,
      droppedEmptyMessages,
      droppedOrphanToolResults,
    },
  };
}

export function reconcile(messages: readonly ChatMessage[]): ChatMessage[] {
  return reconcileWithReport(messages).messages;
}
