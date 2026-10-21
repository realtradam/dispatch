import type {
  AgentEvent,
  Attributes,
  ChatMessage,
  Chunk,
  ImageInput,
  ProviderContract,
  ReasoningEffort,
  ToolDispatchPolicy,
} from "@dispatch/kernel";

/**
 * Build the persisted user message for a turn. When `images` are provided, each
 * is appended as an `image` chunk AFTER the text chunk, so the persisted message
 * carries both the prompt text and the attached images (the frontend renders
 * the images; vision-capable providers receive them natively; non-vision
 * providers have them transcribed by the vision handoff before streaming).
 *
 * Pure: inputs → a ChatMessage, no I/O.
 */
export function buildUserMessage(text: string, images?: readonly ImageInput[]): ChatMessage {
  const chunks: Chunk[] = [];
  if (text.length > 0) {
    chunks.push({ type: "text", text });
  }
  if (images !== undefined) {
    for (const img of images) {
      chunks.push({
        type: "image",
        url: img.url,
        ...(img.mimeType !== undefined ? { mimeType: img.mimeType } : {}),
      });
    }
  }
  // An image-only message (empty text) is valid.
  if (chunks.length === 0) {
    chunks.push({ type: "text", text: "" });
  }
  return { role: "user", chunks };
}

// ── Provider-error retry backoff schedule ───────────────────────────────────
//
// Pure, deterministic delay decision (no I/O, no clock) for retrying retryable
// provider errors (HTTP 429 / 5xx "overloaded"). The concrete `sleep` (I/O)
// is wired in the orchestrator; this owns only the policy.

/**
 * Stepped backoff schedule (ms): 5s, 10s, 30s, 60s, 5m, 10m, 15m, 30m.
 * After the head is exhausted, {@link RETRY_TAIL_MS} (30m) repeats.
 */
export const RETRY_SCHEDULE_MS = [
  5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 900_000, 1_800_000,
] as const;

/** Tail delay (ms) repeated after the stepped head: 30 minutes. */
export const RETRY_TAIL_MS = 1_800_000;

/** Cumulative scheduled-sleep budget (ms) after which retrying gives up: 8h. */
export const RETRY_BUDGET_MS = 8 * 60 * 60 * 1000;

/**
 * Cumulative scheduled sleep through `attempt` (sum of delay[0..attempt]).
 * Pure — no I/O, no clock.
 */
export function cumulativeSleepMs(attempt: number): number {
  let sum = 0;
  for (let i = 0; i <= attempt; i++) {
    sum += i < RETRY_SCHEDULE_MS.length ? (RETRY_SCHEDULE_MS[i] ?? RETRY_TAIL_MS) : RETRY_TAIL_MS;
  }
  return sum;
}

/**
 * Pure, deterministic delay decision for the retry strategy: given the
 * 0-based attempt index, return the delay in ms to sleep before the next
 * retry, or `undefined` to stop (cumulative budget exhausted). No I/O, no
 * clock — fully testable. Matches the plan's schedule:
 * `5s, 10s, 30s, 60s, 5m, 10m, 15m, 30m`, then repeat 30m until 8h of
 * cumulative scheduled sleep is reached, then give up.
 */
export function delayFor(attempt: number): number | undefined {
  const scheduled = RETRY_SCHEDULE_MS[attempt];
  const delay = scheduled !== undefined ? scheduled : RETRY_TAIL_MS;
  if (cumulativeSleepMs(attempt) > RETRY_BUDGET_MS) return undefined; // over budget → stop
  return delay;
}

/**
 * Resolve the reasoning-effort level for a turn:
 *   per-turn override → persisted per-conversation value → default `"high"`.
 * Pure — no I/O, no ambient state.
 */
export function resolveReasoningEffort(
  override: ReasoningEffort | undefined,
  stored: ReasoningEffort | null,
): ReasoningEffort {
  return override ?? stored ?? "high";
}

/**
 * Resolve the model name for a turn:
 *   per-turn override → persisted per-conversation value → `undefined`.
 *
 * Unlike {@link resolveReasoningEffort}, there is NO default model name: when
 * both the override and the persisted value are absent, this returns
 * `undefined` and the caller falls through to `resolveProvider()` (the default
 * provider). Returning `undefined` (rather than a sentinel) keeps the existing
 * "no model override" code path untouched. Pure — no I/O, no ambient state.
 */
export function resolveModelName(
  override: string | undefined,
  stored: string | null,
): string | undefined {
  return override ?? stored ?? undefined;
}

export function selectFirstProvider(
  providers: ReadonlyMap<string, ProviderContract>,
): ProviderContract {
  const first = providers.values().next();
  if (first.done === true || first.value === undefined) {
    throw new Error("No providers registered — at least one provider is required to run a turn.");
  }
  return first.value;
}

export function resolveTools(tools: ReadonlyMap<string, unknown>): readonly unknown[] {
  return [...tools.values()];
}

/**
 * The default tool-dispatch policy: up to four tools at once, launched as
 * soon as their call streams in. Tools flagged `concurrencySafe: false` still
 * run exclusively (the kernel dispatcher enforces that regardless of the cap).
 *
 * Chosen as a CAP rather than unlimited (`0`): the contract doc flags
 * unlimited parallelism as a deliberate opt-in, and a cap keeps a runaway
 * batch bounded. Pure: returns a fresh value, no ambient state.
 */
export function defaultDispatchPolicy(): ToolDispatchPolicy {
  return { maxConcurrent: 4, eager: true };
}

/** Environment variable an operator uses to override the dispatch cap. */
export const DISPATCH_TOOL_MAX_CONCURRENT_ENV = "DISPATCH_TOOL_MAX_CONCURRENT";

/**
 * The result of resolving the operator's dispatch override: the policy to
 * hand to `runTurn`, plus an optional human-readable warning when the raw
 * value was present but invalid. The caller (the extension's edge) logs the
 * warning; this stays pure.
 */
export interface DispatchPolicyResolution {
  readonly policy: ToolDispatchPolicy;
  readonly warning?: string;
}

/**
 * Parse the `DISPATCH_TOOL_MAX_CONCURRENT` override into a dispatch policy.
 *
 * - unset / empty / whitespace-only → {@link defaultDispatchPolicy}
 *   (empty-string env values are treated as unset, matching the repo's
 *   `DISPATCH_PLUGINS_DIR` convention)
 * - a non-negative integer (`"0"` unlimited, `"1"` sequential, `"2"+` cap) →
 *   that cap, `eager` stays `true`
 * - anything else (`"-1"`, `"abc"`, `"2.5"`, overflow) → the default plus a
 *   warning for the edge to log
 *
 * Pure: raw string in → decision out; no `process.env` read, no logging.
 */
export function resolveDispatchPolicy(raw: string | undefined): DispatchPolicyResolution {
  const fallback = defaultDispatchPolicy();
  if (raw === undefined || raw.trim().length === 0) {
    return { policy: fallback };
  }
  const trimmed = raw.trim();
  const maxConcurrent = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(maxConcurrent)) {
    return {
      policy: fallback,
      warning:
        `invalid ${DISPATCH_TOOL_MAX_CONCURRENT_ENV}="${raw}" (expected an integer >= 0); ` +
        `using the default maxConcurrent=${fallback.maxConcurrent}`,
    };
  }
  return { policy: { maxConcurrent, eager: true } };
}

export function generateTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Memory telemetry (leak localization) ────────────────────────────────────
//
// Pure helpers for process.memoryUsage() sampling. The orchestrator owns the
// sample SHAPE (this type) so its per-turn sampling and the host-bin periodic
// timer share one contract without a cross-package import of an
// implementation — host-bin imports this type, the orchestrator never imports
// host-bin. Pure: inputs → attributes/delta, no I/O, no clock.

/**
 * A snapshot of process.memoryUsage() at one instant. Mirrors the subset of
 * Node/Bun's MemoryUsage we log for leak localization (rss, heapUsed,
 * heapTotal, external, arrayBuffers). Owned here so the orchestrator's
 * per-turn sampling and the host-bin periodic timer agree on the shape.
 */
export interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

const BYTES_PER_MB = 1024 * 1024;

function mb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/**
 * Pure: format a {@link MemorySample} as flat logger {@link Attributes}
 * (values in MB, rounded). Flat scalars are serializable (D3) and queryable
 * (D9) in the journal. No I/O.
 *
 * Pass a `prefix` to namespace the keys — e.g. `memorySampleAttributes(delta,
 * "delta")` yields `deltaRssMB`, so an "after" log can carry both the absolute
 * sample (`rssMB`) and the per-turn delta (`deltaRssMB`) without key collision.
 * The first letter of each field is capitalized after the prefix for
 * readability (`deltaRssMB`, not `deltarssMB`).
 */
export function memorySampleAttributes(sample: MemorySample, prefix?: string): Attributes {
  const p = prefix === undefined ? "" : prefix;
  const cap = (s: string): string =>
    s.length === 0 ? s : `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;
  const field = (name: string): string => (p.length === 0 ? name : `${p}${cap(name)}`);
  return {
    [field("rssMB")]: mb(sample.rss),
    [field("heapUsedMB")]: mb(sample.heapUsed),
    [field("heapTotalMB")]: mb(sample.heapTotal),
    [field("externalMB")]: mb(sample.external),
    [field("arrayBuffersMB")]: mb(sample.arrayBuffers),
  };
}

/**
 * Pure: compute the signed per-field delta `after - before`. A positive
 * `rss` delta on a sealed turn flags memory retained by the streaming path
 * (the prime leak suspect). No I/O.
 */
export function memoryDelta(before: MemorySample, after: MemorySample): MemorySample {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    heapTotal: after.heapTotal - before.heapTotal,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

/** Maximum retained UTF-8 progress output per tool call (stdout + stderr). */
export const REPLAY_TOOL_OUTPUT_BYTES = 64 * 1024;

/** A code-point-aligned suffix; never retain a partial UTF-8 character. */
function outputTail(data: string, budget: number): { data: string; bytes: number } {
  let start = data.length;
  let bytes = 0;
  while (start > 0) {
    const last = data.charCodeAt(start - 1);
    const paired =
      last >= 0xdc00 &&
      last <= 0xdfff &&
      start > 1 &&
      data.charCodeAt(start - 2) >= 0xd800 &&
      data.charCodeAt(start - 2) <= 0xdbff;
    const size = paired ? 4 : last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
    if (bytes + size > budget) break;
    bytes += size;
    start -= paired ? 2 : 1;
  }
  return { data: start === 0 ? data : data.slice(start), bytes };
}

/**
 * Pure batch reference for late-join replay. Keep every structural event in
 * order, only the last status, and no output for calls with a result (even if
 * output arrives after the result). Running calls retain the trailing 64 KiB
 * across both streams, at their original positions/with their stream metadata.
 * Merge same-type/same-turn deltas adjacent AFTER discarded events are removed.
 * Inputs are never mutated; live delivery is unaffected.
 */
export function compactReplay(events: readonly AgentEvent[]): AgentEvent[] {
  const finishedTools = new Set<string>();
  let lastStatus = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.type === "tool-result") finishedTools.add(e.toolCallId);
    else if (e.type === "status") lastStatus = i;
  }

  const remaining = new Map<string, number>();
  const outputs = new Map<number, AgentEvent>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== "tool-output" || finishedTools.has(e.toolCallId)) continue;
    const budget = remaining.get(e.toolCallId) ?? REPLAY_TOOL_OUTPUT_BYTES;
    const tail = outputTail(e.data, budget);
    // Once a chunk is truncated, earlier chunks cannot fit in the suffix.
    remaining.set(e.toolCallId, tail.data.length < e.data.length ? 0 : budget - tail.bytes);
    if (tail.data.length > 0 || e.data.length === 0) {
      outputs.set(i, tail.data === e.data ? e : { ...e, data: tail.data });
    }
  }

  const out: AgentEvent[] = [];
  let pending: {
    type: "text-delta" | "reasoning-delta";
    base: AgentEvent;
    parts: string[];
  } | null = null;
  const flush = (): void => {
    if (pending === null) return;
    const base = pending.base;
    out.push(
      pending.parts.length === 1
        ? base
        : ({ ...base, delta: pending.parts.join("") } as AgentEvent),
    );
    pending = null;
  };

  for (let i = 0; i < events.length; i++) {
    const original = events[i];
    const e = original?.type === "tool-output" ? outputs.get(i) : original;
    if (e === undefined) continue;
    if (e.type === "text-delta" || e.type === "reasoning-delta") {
      if (
        pending !== null &&
        pending.type === e.type &&
        (pending.base as { turnId: string }).turnId === e.turnId
      ) {
        pending.parts.push(e.delta);
      } else {
        flush();
        pending = { type: e.type, base: e, parts: [e.delta] };
      }
      continue;
    }
    if (e.type === "status" && i !== lastStatus) continue;
    flush();
    out.push(e);
  }
  flush();
  return out;
}

/** Internal retained list; events are replaced, never mutated (snapshots share them). */
interface ReplayNode {
  event: AgentEvent;
  previous: ReplayNode | undefined;
  next: ReplayNode | undefined;
  bytes: number;
}

interface ReplayOutput {
  readonly nodes: Set<ReplayNode>;
  /** Nonempty nodes only: empty output boundaries must not slow down trimming. */
  readonly nonempty: Set<ReplayNode>;
  bytes: number;
}

/**
 * Explicitly owned, I/O-free accumulator. Mutable bookkeeping is private to a turn;
 * only snapshotReplay's immutable event array may escape to replay listeners.
 * No raw event history, tombstones, ambient caches, or retained-array copies.
 */
export interface ReplayBuffer {
  first: ReplayNode | undefined;
  last: ReplayNode | undefined;
  status: ReplayNode | undefined;
  readonly outputs: Map<string, ReplayOutput>;
  readonly finishedTools: Set<string>;
  size: number;
}

export function createReplayBuffer(): ReplayBuffer {
  return {
    first: undefined,
    last: undefined,
    status: undefined,
    outputs: new Map(),
    finishedTools: new Set(),
    size: 0,
  };
}

function mergeDeltas(left: ReplayNode | undefined, right: AgentEvent): boolean {
  const event = left?.event;
  if (
    left !== undefined &&
    (event?.type === "text-delta" || event?.type === "reasoning-delta") &&
    right.type === event.type &&
    right.turnId === event.turnId
  ) {
    left.event = { ...event, delta: event.delta + right.delta };
    return true;
  }
  return false;
}

function unlinkReplay(buffer: ReplayBuffer, node: ReplayNode): void {
  const { previous, next } = node;
  if (previous === undefined) buffer.first = next;
  else previous.next = next;
  if (next === undefined) buffer.last = previous;
  else next.previous = previous;
  buffer.size--;
  node.previous = undefined;
  node.next = undefined;
  // Only the two newly adjacent neighbours can merge. Both are deltas, so
  // removing the right neighbour cannot invalidate a status/output index.
  if (next !== undefined && mergeDeltas(previous, next.event)) unlinkReplay(buffer, next);
}

/** Remove just enough leading code points; work is charged to bytes evicted. */
function trimOutput(node: ReplayNode, excess: number): number {
  const event = node.event;
  if (event.type !== "tool-output") throw new Error("invalid replay output index");
  let offset = 0;
  let removed = 0;
  while (removed < excess) {
    const code = event.data.codePointAt(offset) ?? 0;
    removed += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    offset += code > 0xffff ? 2 : 1;
  }
  node.event = { ...event, data: event.data.slice(offset) };
  node.bytes -= removed;
  return removed;
}

/**
 * Append to caller-owned state, returning it for foldl(append) equivalence tests.
 * Deltas/status are O(1) in retained size. Output work is O(incoming bytes +
 * evicted bytes/nodes); results visit only their own output nodes, each once.
 * Removing a boundary re-merges adjacent deltas in place, including non-tail runs.
 */
export function appendCompacted(buffer: ReplayBuffer, event: AgentEvent): ReplayBuffer {
  let output: ReplayOutput | undefined;
  let bytes = 0;
  if (event.type === "status") {
    if (buffer.status !== undefined) unlinkReplay(buffer, buffer.status);
  } else if (event.type === "tool-result") {
    buffer.finishedTools.add(event.toolCallId);
    const prior = buffer.outputs.get(event.toolCallId);
    if (prior !== undefined) {
      for (const node of prior.nodes) unlinkReplay(buffer, node);
      buffer.outputs.delete(event.toolCallId);
    }
  } else if (event.type === "tool-output") {
    if (buffer.finishedTools.has(event.toolCallId)) return buffer;
    const tail = outputTail(event.data, REPLAY_TOOL_OUTPUT_BYTES);
    // A nonempty event whose final character cannot fit is absent, not a boundary.
    if (tail.data.length === 0 && event.data.length > 0) return buffer;
    output = buffer.outputs.get(event.toolCallId);
    if (output === undefined) {
      output = { nodes: new Set(), nonempty: new Set(), bytes: 0 };
      buffer.outputs.set(event.toolCallId, output);
    }
    bytes = tail.bytes;
    const truncated = tail.data.length < event.data.length;
    if (truncated) event = { ...event, data: tail.data };
    // An oversized chunk consumes the entire suffix budget, including a gap
    // at a multibyte boundary: no backfilling earlier chunks into that gap.
    for (const node of output.nonempty) {
      if (!truncated && output.bytes + bytes <= REPLAY_TOOL_OUTPUT_BYTES) break;
      const excess = output.bytes + bytes - REPLAY_TOOL_OUTPUT_BYTES;
      if (truncated || node.bytes <= excess) {
        output.bytes -= node.bytes;
        output.nodes.delete(node);
        output.nonempty.delete(node);
        unlinkReplay(buffer, node);
      } else {
        output.bytes -= trimOutput(node, excess);
        break;
      }
    }
  }
  if (mergeDeltas(buffer.last, event)) return buffer;
  const node: ReplayNode = { event, bytes, previous: buffer.last, next: undefined };
  if (buffer.last === undefined) buffer.first = node;
  else buffer.last.next = node;
  buffer.last = node;
  buffer.size++;
  if (event.type === "status") buffer.status = node;
  if (output !== undefined) {
    output.nodes.add(node);
    if (bytes > 0) output.nonempty.add(node);
    output.bytes += bytes;
  }
  return buffer;
}

/**
 * O(R) only at subscribe: freeze the array before invoking any listener. Shared
 * event objects are stable because append replaces them rather than mutating.
 * A reentrant append/unlink cannot change this traversal or later replay events.
 */
export function snapshotReplay(buffer: ReplayBuffer): readonly AgentEvent[] {
  const snapshot: AgentEvent[] = [];
  for (let node = buffer.first; node !== undefined; node = node.next) snapshot.push(node.event);
  return Object.freeze(snapshot);
}

/** All-or-nothing replay preflight; never allocate more than maxEvents references. */
export function boundedSnapshotReplay(
  buffer: ReplayBuffer,
  maxEvents: number,
  accept: (event: AgentEvent) => boolean,
): readonly AgentEvent[] | undefined {
  if (buffer.size > maxEvents) return undefined;
  const snapshot: AgentEvent[] = [];
  for (let node = buffer.first; node !== undefined; node = node.next) {
    if (!accept(node.event)) return undefined;
    snapshot.push(node.event);
  }
  return Object.freeze(snapshot);
}
