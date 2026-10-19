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

/**
 * Compact an in-flight turn's event buffer for a LATE-JOIN replay (a client
 * that subscribes mid-turn: a refresh, reconnect, or second device).
 *
 * The live stream emits one event per provider token chunk, so a long turn's
 * buffer holds thousands of tiny `text-delta` / `reasoning-delta` events. A
 * late-joiner folding them one-by-one does O(events) client work (each one a
 * separate WS frame + reactive cycle) — painfully slow on mobile. The replay
 * is purely historical, so it can be compacted without any latency tradeoff:
 *
 * - Each run of ADJACENT same-type, same-turn deltas is merged into ONE event
 *   whose `delta` is the concatenation. Byte-identical for every consumer that
 *   accumulates deltas by string concatenation (the FE reducer, the CLI).
 * - `tool-output` (incremental stdout/stderr of a running tool) is dropped for
 *   tool calls that already have a `tool-result` in the buffer — the result
 *   carries the full output, so the progress stream is redundant (and large).
 *   Output of a STILL-RUNNING tool is kept so the late-joiner sees progress.
 * - `status` events are free-form transient hints; only the LAST is kept.
 *
 * Every structural event (`turn-start`, `user-message`, `tool-call`,
 * `tool-result`, `usage`, `step-complete`, `steering`, `error`, `done`, …)
 * is kept, in order. Live streaming is NOT affected — only the subscribe-time
 * snapshot. Pure: input array → new array; the input is never mutated.
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

  const out: AgentEvent[] = [];
  // Pending merged delta (flushed when a different event interrupts the run).
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
    const e = events[i];
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
    if (e.type === "tool-output" && finishedTools.has(e.toolCallId)) continue;
    if (e.type === "status" && i !== lastStatus) continue;
    flush();
    out.push(e);
  }
  flush();
  return out;
}
