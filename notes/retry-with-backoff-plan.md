# Plan — Retry-with-backoff on retryable provider errors (FINALIZED)

**Goal:** When the upstream LLM API returns a retryable error (e.g. "server
overloaded"), retry the request with a stepped backoff, visibly, until the
budget is exhausted.

## The error (from the prod DB) — detection is already done

- **HTTP 429** (46×) and **HTTP 502** (1×), **no 503s**.
- Body: `{"error":{"type":"overloaded_error","message":"The service is temporarily overloaded. Please retry."}}`
- `packages/openai-stream/src/stream.ts:201` **already sets**
  `retryable: response.status >= 500 || response.status === 429` on the error
  event, and `ProviderErrorEvent` (`kernel/contracts/provider.ts:72`) **already
  declares `retryable?: boolean`**. The kernel's `processEvent` just ignores it.
- The error is **emitted (not thrown) and before any content** → retrying
  `provider.stream()` is safe (no partial chunks to roll back).

## Decision 1 — the backoff schedule

`5s, 10s, 30s, 60s, 5m, 10m, 15m, 30m`, then **repeat 30m** until **8h of
cumulative retry-wait** is reached, then give up (emit the final error + seal).

Pure function of the attempt index (0 = first retry):
```ts
const SCHEDULE_MS = [5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 900_000, 1_800_000];
const TAIL_MS = 1_800_000;            // 30m
const BUDGET_MS = 8 * 60 * 60 * 1000;  // 8h

// pure, deterministic, no I/O
function delayFor(attempt: number): number | undefined {
  const delay = attempt < SCHEDULE_MS.length ? SCHEDULE_MS[attempt] : TAIL_MS;
  if (cumulativeSleepMs(attempt) > BUDGET_MS) return undefined; // over budget → stop
  return delay;
}
```
- `cumulativeSleepMs(attempt)` = sum of delay[0..attempt]; head (8 steps) sums to
  3,705s, then +1,800s per extra step. 8h (28,800s) is reached at attempt ~21
  → ~21 retries, ~7h32m of sleeping, then give up.
- Budget = cumulative *scheduled sleep* (pure/testable). If you prefer wall-clock
  since first error, it switches to using the injected `now` — easy change.

## Decision 2 — visible (yellow system-message warning) + 5d3f handoff

Add a new **transient** `AgentEvent` variant (emitted to the frontend, NOT
persisted into the model's message history — so it never pollutes the prompt):

```ts
// @dispatch/wire (AgentEvent union gains this member)
export interface TurnProviderRetryEvent {
  readonly type: "provider-retry";
  readonly conversationId: string;
  readonly turnId: string;
  /** 0-based: this is the Nth retry about to happen. */
  readonly attempt: number;
  /** ms the client should expect to wait before the retry fires. */
  readonly delayMs: number;
  /** The endpoint's error verbatim (e.g. "HTTP 429: {…overloaded_error…}"). */
  readonly message: string;
  /** The HTTP code when known (e.g. "429"). */
  readonly code?: string;
}
```
- Emitted once per scheduled retry, BEFORE the sleep, so the UI shows
  "⚠ Server overloaded — retrying in 5s…" immediately.
- When retries are exhausted (8h), the existing `error` event is emitted (as
  today) and the turn seals — so the final failure is still a persisted error.

**Frontend handoff to 5d3f:** render `provider-retry` as a yellow warning
system-message bubble showing `message` (+ `code`), with the countdown. (I do
the backend; 5d3f does the renderer — handoff via dispatch CLI.)

## Decision 3 — retry ANY retryable error

Retry trigger (both paths), **only when no content has been emitted yet**
(the safety invariant — never duplicate partial output):

- **Emitted** `error` ProviderEvent with `retryable === true` → retry. (429/502/5xx + network fetch errors — all pre-content.)
- **Thrown** error (mid-stream, caught in `executeStep`'s `catch`) → treated as **retryable-by-default when pre-content** (most mid-stream throws are transient network/SSE issues). A thrown error after content is emitted is NOT retried (can't safely).

So "if it's retryable, retry it" = the `retryable` flag drives emitted errors;
thrown errors default to retryable when nothing was streamed yet. Non-retryable
emitted errors (`retryable: false`/absent) end the step as today.

## Architecture — kernel provides the HOOK, shell provides POLICY + I/O

(Constitution: kernel touches no I/O; effects injected; decision pure.)

### Kernel contract (`kernel/src/contracts/runtime.ts`) — add to `RunTurnInput`:
```ts
export interface RetryStrategy {
  /** Pure: attempt → delay ms, or undefined to stop (budget exhausted). */
  readonly delayFor: (attempt: number) => number | undefined;
  /** Injected effect: actually sleep. Kernel imports no timer. Abortable. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface RunTurnInput {
  // …existing…
  /** Optional injected retry. Omit = no retry (backward-compatible). */
  readonly retry?: RetryStrategy;
}
```

### Kernel loop (`kernel/src/runtime/run-turn.ts`, `executeStep`):
Wrap stream consumption in a retry loop:
- track `hadContent` (any text/reasoning/tool-call/usage seen);
- on a retryable error (emitted `retryable:true` OR thrown) with `!hadContent`:
  - `delay = retry.delayFor(attempt)`; if `undefined` → give up (emit the
    suppressed error, end step);
  - else emit `providerRetryEvent(attempt, delay, message, code)`, `await
    retry.sleep(delay, signal)`, `attempt++`, re-call `provider.stream()`;
- on abort during sleep → reject, seal turn `aborted` (existing flow).

### Shell wiring (`session-orchestrator/src/orchestrator.ts`):
- Provide the concrete `RetryStrategy`: `delayFor` = the schedule + 8h budget
  above; `sleep` = abortable `setTimeout`-based promise.
- Pass `retry` into the `RunTurnInput` it builds (line 589).

## Build breakdown by unit (execution)

| Unit (owner) | Change |
|---|---|
| `@dispatch/wire` | add `TurnProviderRetryEvent` to `AgentEvent` union |
| `kernel` contracts | add `RetryStrategy` + `retry?` on `RunTurnInput` |
| `kernel` events.ts | `providerRetryEvent(...)` constructor |
| `kernel` run-turn.ts | retry loop in `executeStep` (the core logic) |
| `kernel` run-turn.test.ts | pure tests: fake `sleep` + pure `delayFor`; assert schedule, no-after-content retry, give-up emits error, abort-during-sleep |
| `session-orchestrator` | wire concrete schedule + real `setTimeout` sleep |
| `transport-ws` | if it has an exhaustive `switch(event.type)`, add the `provider-retry` case |
| `transport-http` (mine) | **no change** — `serializeEventLine` is generic `JSON.stringify` |
| frontend (5d3f) | render `provider-retry` as a yellow warning system message |

## Open items
- **8h budget = cumulative scheduled sleep** (pure). Confirm OK vs wall-clock.
- **Thrown errors default retryable-when-pre-content.** Confirm (vs only the
  flagged emitted path).
- **Execution mode:** this spans kernel + wire + orchestrator (outside my
  transport-http unit). Build it directly across units, or dispatch each slice
  to its unit owner via the dispatch CLI?
