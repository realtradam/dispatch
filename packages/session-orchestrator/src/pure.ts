import type {
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

export function defaultDispatchPolicy(): ToolDispatchPolicy {
  return { maxConcurrent: 1, eager: true };
}

export function generateTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
