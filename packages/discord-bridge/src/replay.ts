/**
 * The replay builder (§3.4): persisted history (stored chunks + turn
 * metrics) → the SAME events the live relay formats → the full list of
 * Discord messages the history needs → the last `count` of them.
 *
 * Pure: input → output. Running history through the live formatter is what
 * makes replayed history look identical to the live relay (echoes, thinking,
 * tool messages with results already filled in, responses, step footers,
 * turn summaries).
 */

import type { StepId, StepMetrics, StoredChunk, TurnMetrics } from "@dispatch/wire";
import { type RelayEvent, RelayFormatter } from "./formatter.js";

/** Default number of Discord messages replayed by `!dispatch open` (D22). */
export const DEFAULT_REPLAY_COUNT = 20;
/** Hard cap on replayed Discord messages (D22). */
export const MAX_REPLAY_COUNT = 300;

/** Clamp a requested replay count into `[0, MAX_REPLAY_COUNT]`. */
export function clampReplayCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_REPLAY_COUNT;
  return Math.max(0, Math.min(MAX_REPLAY_COUNT, Math.floor(requested)));
}

interface TurnRun {
  readonly turnId: string;
  readonly chunks: StoredChunk[];
}

/** Group a seq-ordered log into consecutive per-turn runs (turn-less runs get a synthetic id). */
function turnRuns(chunks: readonly StoredChunk[]): TurnRun[] {
  const runs: TurnRun[] = [];
  let current: TurnRun | undefined;
  for (const c of chunks) {
    const sameRun =
      current !== undefined &&
      (c.turnId === undefined
        ? current.turnId.startsWith("history@")
        : current.turnId === c.turnId);
    if (current === undefined || !sameRun) {
      current = { turnId: c.turnId ?? `history@${c.seq}`, chunks: [] };
      runs.push(current);
    }
    current.chunks.push(c);
  }
  return runs;
}

/**
 * Persisted history → formatter events. Step boundaries are recovered from
 * the chunk order (an assistant chunk after a step's tool results opens the
 * next step) and, when present, the tool chunks' `stepId`s; each boundary
 * carries that step's persisted `StepMetrics` as `usage` + `step-complete`,
 * and a turn with persisted metrics ends with a `done` (summary or "turn
 * stopped").
 */
export function historyToEvents(
  conversationId: string,
  chunks: readonly StoredChunk[],
  metrics: readonly TurnMetrics[],
): RelayEvent[] {
  const byTurn = new Map(metrics.map((m) => [m.turnId, m]));
  const events: RelayEvent[] = [];
  for (const run of turnRuns(chunks)) {
    const turnId = run.turnId;
    const m = byTurn.get(turnId);
    const stepIndexById = new Map<string, number>((m?.steps ?? []).map((s, i) => [s.stepId, i]));
    const base = { conversationId, turnId };
    let stepIndex = 0;
    let stepHasResults = false;
    let stepHasContent = false;

    const closeStep = () => {
      const step: StepMetrics | undefined = m?.steps[stepIndex];
      if (step !== undefined) {
        events.push({ ...base, type: "usage", stepId: step.stepId, usage: step.usage });
        events.push({
          ...base,
          type: "step-complete",
          stepId: step.stepId,
          ...(step.ttftMs !== undefined ? { ttftMs: step.ttftMs } : {}),
          ...(step.decodeMs !== undefined ? { decodeMs: step.decodeMs } : {}),
          ...(step.genTotalMs !== undefined ? { genTotalMs: step.genTotalMs } : {}),
        });
      }
      stepIndex += 1;
      stepHasResults = false;
      stepHasContent = false;
    };
    const beforeAssistant = (stepId?: string) => {
      const target = stepId === undefined ? undefined : stepIndexById.get(stepId);
      if (target !== undefined) {
        while (stepIndex < target) closeStep();
        return;
      }
      if (stepHasResults) closeStep();
    };

    let i = 0;
    while (i < run.chunks.length) {
      const sc = run.chunks[i] as StoredChunk;
      const chunk = sc.chunk;
      if (sc.role === "user" && (chunk.type === "text" || chunk.type === "image")) {
        // One user message = the consecutive user text/image chunks. The
        // FIRST text chunk is the prompt (later ones are image transcriptions).
        let text: string | undefined;
        let imageCount = 0;
        while (i < run.chunks.length) {
          const u = run.chunks[i] as StoredChunk;
          if (u.role !== "user" || (u.chunk.type !== "text" && u.chunk.type !== "image")) break;
          if (u.chunk.type === "image") imageCount += 1;
          else if (text === undefined) text = u.chunk.text;
          i += 1;
        }
        events.push({ type: "replay-user-message", turnId, text: text ?? "", imageCount });
        continue;
      }
      i += 1;
      switch (chunk.type) {
        case "thinking":
          if (chunk.text.trim().length === 0) break;
          beforeAssistant();
          events.push({ ...base, type: "reasoning-delta", delta: chunk.text });
          events.push({ ...base, type: "reasoning-end" });
          stepHasContent = true;
          break;
        case "text":
          if (sc.role !== "assistant") break;
          beforeAssistant();
          events.push({ ...base, type: "text-delta", delta: chunk.text });
          stepHasContent = true;
          break;
        case "tool-call":
          beforeAssistant(chunk.stepId);
          events.push({
            ...base,
            type: "tool-call",
            stepId: (chunk.stepId ?? `${turnId}#${stepIndex}`) as StepId,
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          });
          stepHasContent = true;
          break;
        case "tool-result":
          events.push({
            ...base,
            type: "tool-result",
            stepId: (chunk.stepId ?? `${turnId}#${stepIndex}`) as StepId,
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            content: chunk.content,
            isError: chunk.isError,
          });
          stepHasResults = true;
          stepHasContent = true;
          break;
        case "error":
          events.push({ ...base, type: "error", message: chunk.message });
          break;
        default:
          break;
      }
    }
    if (m !== undefined) {
      if (stepHasContent || stepIndex < m.steps.length) closeStep();
      events.push({
        ...base,
        type: "done",
        reason: m.aborted === true ? "aborted" : "stop",
        usage: m.usage,
        ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        ...(m.contextSize !== undefined ? { contextSize: m.contextSize } : {}),
      });
    }
    events.push({ ...base, type: "turn-ended", reason: "sealed" });
  }
  return events;
}

/** One Discord message of rendered history. */
export interface ReplayMessage {
  readonly key: string;
  readonly content: string;
}

/** Run events through a fresh formatter; the FINAL content of every message, in post order. */
export function renderMessages(events: readonly RelayEvent[]): ReplayMessage[] {
  const formatter = new RelayFormatter();
  const order: string[] = [];
  const content = new Map<string, string>();
  for (const ev of events) {
    for (const op of formatter.push(ev)) {
      if (!content.has(op.key)) order.push(op.key);
      content.set(op.key, op.content);
    }
  }
  for (const op of formatter.flush()) {
    if (!content.has(op.key)) order.push(op.key);
    content.set(op.key, op.content);
  }
  return order.map((key) => ({ key, content: content.get(key) ?? "" }));
}

export interface ReplayPlan {
  /** The header line, or null when nothing is replayed (`count` 0). */
  readonly header: string | null;
  /** The last `count` messages, oldest first. */
  readonly messages: readonly ReplayMessage[];
  readonly total: number;
}

/**
 * Pick the last `count` Discord messages of the rendered history and the
 * header announcing them. `requested` (when larger than `count`) notes a clamp.
 */
export function planReplay(
  all: readonly ReplayMessage[],
  count: number,
  requested?: number,
): ReplayPlan {
  const n = Math.max(0, Math.min(count, all.length));
  if (count <= 0) return { header: null, messages: [], total: all.length };
  if (all.length === 0) return { header: "-# no history to replay", messages: [], total: 0 };
  const clampNote =
    requested !== undefined && requested > count
      ? ` (requested ${requested}; max ${MAX_REPLAY_COUNT})`
      : "";
  return {
    header: `-# replaying last ${n} of ${all.length} messages…${clampNote}`,
    messages: all.slice(all.length - n),
    total: all.length,
  };
}
