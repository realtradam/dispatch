# Instant Stop — Problem 1: Backend Cancellation Does Not Interrupt Every Wait

**Status:** Implemented — merged to `dev` (a3f752d, fbcb39e, 17fab5e; merge 61e497a)
**Scope:** Backend kernel, provider contract/adapters, provider concurrency, and turn-boundary callbacks  
**Goal:** After `POST /conversations/:id/stop`, the active backend turn must settle promptly even if a provider, concurrency wait, network read, or turn-boundary callback is stuck.

## Problem statement

The Stop endpoint aborts the active turn's `AbortController`, but the backend does not guarantee that the work currently awaited by the turn will observe that abort.

The most visible failure occurs after a tool result: the next provider request begins, the provider stops yielding events, and the turn remains active indefinitely. Clicking Stop calls `abort()`, but the kernel is blocked awaiting the provider's next async-iterator result and never reaches its next `signal.aborted` check.

This problem is independent of frontend rendering. The backend itself can remain active after Stop.

## Confirmed reproduction

A minimal reproduction used `runTurn()` with a provider whose async generator never yields:

```ts
const provider = {
  id: "never-yields",
  stream: async function* () {
    await new Promise(() => {});
  },
};
```

The turn's signal was aborted after 20 ms and the result was raced against a 250 ms timeout. The observed result was:

```text
still-pending-after-abort
```

This confirms that an aborted turn can remain pending inside provider iteration.

## Current cancellation path

1. The frontend sends `POST /conversations/:id/stop`.
2. `packages/transport-http/src/app.ts` calls `orchestrator.stopTurn(conversationId)`.
3. `packages/session-orchestrator/src/orchestrator.ts` finds the active turn and calls `turn.controller.abort()`.
4. The kernel receives that controller's signal as `RunTurnInput.signal`.
5. The kernel checks `signal.aborted` before steps and after provider events.

The gap is that several awaited operations are not themselves abortable.

## Root causes

### 1. Provider iteration only checks abort after an event arrives

In `packages/kernel/src/runtime/run-turn.ts`, the provider is consumed with a normal `for await` loop:

```ts
const stream = ctx.provider.stream(ctx.messages, ctx.tools, opts);
for await (const event of stream) {
  if (ctx.signal.aborted) break;
  // process event
}
```

If `iterator.next()` never resolves, control never enters the loop body again. The abort check is therefore ineffective for a stalled stream.

### 2. `ProviderStreamOptions` carries no `AbortSignal`

`packages/kernel/src/contracts/provider.ts` does not expose the turn signal to providers.

As a result, the shared OpenAI-compatible adapter does not pass a signal to:

- The initial `fetch()` request.
- The response body's `ReadableStreamDefaultReader.read()` lifecycle.

The external Anthropic provider has the same gap. Therefore, all current provider families can remain blocked after Stop.

### 3. Provider concurrency acquisition is not cancellable

`packages/provider-concurrency/src/provider-wrapper.ts` awaits:

```ts
const release = await limiter.acquire(...);
```

`ConcurrencyLimiter.acquire()` accepts no signal or cancellation handle. A stopped turn can remain in the provider queue and later receive a slot. It may then start a provider request even though the turn was already aborted.

### 4. Some turn-boundary awaits are not cancellation-aware

After a tool step, the kernel can await:

- `onStepComplete`
- `drainSteering`
- `onStepBoundary`

The in-flight compaction implementation runs through `onStepBoundary` and may start another provider stream. That compaction request does not receive the active turn's abort signal. A Stop request during in-flight compaction can therefore hang at the tool-result boundary.

### 5. Provider compliance alone is not a sufficient guarantee

Even after the provider contract accepts a signal, an extension or third-party provider could ignore it. The kernel needs a defensive cancellation boundary analogous to the existing hanging-tool defense in `packages/kernel/src/runtime/dispatch.ts`.

## Existing behavior that should be preserved

- Partial assistant text/reasoning should remain persistable after abort.
- Incomplete tool-call/result pairs must not corrupt the next turn's history.
- A stopped turn should emit one terminal `done` event with `reason: "aborted"`.
- The turn should seal normally and transition the conversation from active/queued to idle.
- Late failures from abandoned provider/tool promises must not become unhandled rejections.
- Provider concurrency slots must be released exactly once.

## Proposed implementation

### A. Add the signal to the provider contract

Extend `ProviderStreamOptions`:

```ts
export interface ProviderStreamOptions {
  // existing fields
  readonly signal?: AbortSignal;
}
```

The session orchestrator should include the active turn signal in the options passed to the kernel/provider.

Every provider adapter should forward it to its network request:

```ts
await fetch(url, {
  method: "POST",
  headers,
  body,
  signal: opts?.signal,
});
```

Provider adapters must distinguish deliberate abort from ordinary network failure. An abort caused by the turn signal must end as `aborted`; it must not be emitted as a retryable provider error and enter the retry schedule.

### B. Add a defensive abortable async-iterator boundary in the kernel

Replace implicit `for await` consumption with explicit iterator control so each `iterator.next()` is raced against the turn signal.

Required behavior:

1. Check `signal.aborted` before requesting another event.
2. Race `iterator.next()` against an abort promise.
3. On abort, stop accepting events immediately.
4. Invoke `iterator.return()` best-effort so the provider can release its reader/request.
5. Swallow late rejections from an abandoned `next()` promise.
6. Seal the turn with `finishReason: "aborted"`.
7. Remove abort listeners on every settlement path.

This protects the kernel even if a provider ignores `ProviderStreamOptions.signal`.

### C. Make provider-concurrency acquisition cancellable

Extend `ConcurrencyLimiter.acquire()` with a signal or equivalent cancellation token.

When the signal aborts while queued:

- Remove that exact waiter from the provider queue.
- Settle `acquire()` immediately as aborted.
- Never invoke `onAcquired`.
- Never start the inner provider stream.
- Do not consume or leak a provider slot.

The slot-grant/abort race must be handled atomically. If the slot is granted at the same instant as abort, either:

- Abort wins and the newly granted slot is immediately released, or
- Grant wins, then the provider starts with an already-aborted signal and exits immediately.

In both cases, accounting must remain correct and release must be idempotent.

### D. Add cancellation checks around turn-boundary callbacks

Check `signal.aborted` before and after:

- `onStepComplete`
- `drainSteering`
- `onStepBoundary`
- Any next provider invocation

Network-backed callbacks should receive the signal. In particular, in-flight compaction must forward the active turn signal through its concurrency acquisition and provider stream.

Durable writes that are already in progress may be allowed to finish if interrupting them would violate append-only consistency, but they must not lead to another provider step after abort.

### E. Ensure cleanup and terminal events are exactly-once

The implementation must guarantee:

- Provider iterator cleanup runs at most once.
- Concurrency release runs at most once.
- `done(reason: "aborted")` is emitted once.
- The orchestrator removes the turn from `activeTurns`.
- Conversation status eventually becomes idle.
- No retry is scheduled after abort.

## Files likely involved

### Backend repository

- `packages/kernel/src/contracts/provider.ts`
- `packages/kernel/src/runtime/run-turn.ts`
- `packages/kernel/src/runtime/run-turn.test.ts`
- `packages/openai-stream/src/stream.ts`
- `packages/openai-stream/src/stream.test.ts`
- `packages/provider-concurrency/src/concurrency-manager.ts`
- `packages/provider-concurrency/src/concurrency-manager.test.ts`
- `packages/provider-concurrency/src/provider-wrapper.ts`
- `packages/provider-concurrency/src/provider-wrapper.test.ts`
- `packages/session-orchestrator/src/orchestrator.ts`
- `packages/session-orchestrator/src/orchestrator.test.ts`

### External Claude extension repository

- `claude/packages/provider-anthropic/src/stream.ts`
- `claude/packages/provider-anthropic/src/stream.test.ts`

The shared provider contract change must be coordinated with the external Claude extension so Anthropic uses the same cancellation semantics.

## Required tests

### Kernel

1. **Provider `next()` never resolves**
   - Abort settles `runTurn()` promptly.
   - Result has `finishReason: "aborted"`.
   - Exactly one aborted `done` event is emitted.

2. **Provider ignores the signal**
   - Kernel's iterator race still settles promptly.
   - A late rejection from `next()` is swallowed.

3. **Provider cleanup**
   - `iterator.return()` is called best-effort on abort.
   - Cleanup failure does not replace the aborted result.

4. **Abort after partial content**
   - Partial text/reasoning remains in the result.
   - No additional provider events are accepted after the abort barrier.

5. **Abort after a tool result while the next stream hangs**
   - The turn settles.
   - No incomplete tool-call/result history is persisted.

### OpenAI-compatible provider

1. Fetch receives `opts.signal`.
2. Aborting during the initial fetch cancels the request.
3. Aborting during `reader.read()` cancels/ends the stream.
4. Abort is not emitted as a retryable error.
5. Request spans close correctly on abort.

### Provider concurrency

1. Abort removes a queued waiter immediately.
2. The aborted waiter is never granted a slot later.
3. Abort/grant races do not leak or double-release slots.
4. `onAcquired` does not fire for an aborted waiter.
5. Other queued conversations preserve their priority order.

### Session orchestrator

1. Stop during provider generation settles active state promptly.
2. Stop during an in-flight compaction provider call settles promptly.
3. No retry starts after Stop.
4. Status reaches idle after abort.

### Anthropic provider

Repeat the fetch/read/abort tests for the external provider implementation.

## Acceptance criteria

- Clicking Stop causes the backend turn to leave active/queued state promptly, even if the provider never yields again.
- The upstream HTTP request is cancelled where the provider supports `AbortSignal`.
- A provider that ignores the signal still cannot keep the kernel turn pending.
- A stopped conversation waiting for a concurrency slot is removed from the queue immediately.
- In-flight compaction cannot keep a stopped turn alive.
- The turn emits and persists a clean aborted terminal state with no malformed tool history.
- No slot, reader, abort listener, retry timer, or unhandled promise rejection is leaked.

## Out of scope

This note does not cover:

- Frontend rendering backlog or optimistic UI behavior. See `instant-stop-2-frontend-render-backlog.md`.
- Steering messages automatically starting another turn after Stop. See `instant-stop-3-queued-steering-restart.md`.
- Changing normal provider retry policy for non-abort failures.
- Cancelling completed side effects from eager tools; effects that already happened cannot be undone.
