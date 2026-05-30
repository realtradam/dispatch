# Code Review (Pass 3): Verify the `turn-start` backfill Block fix

## Executive Summary

The fix to the `turn-start` backfill loop successfully prevents pending `queued-` messages from being wiped by correctly skipping them. However, it exposes a critical flaw in how **consumed** messages are handled.

When a queued message is consumed (`message-consumed`), its `queued-` prefix is stripped, leaving it as an untagged, plain user row in `live`. Because it lacks a `turnId`, it survives `reconcileSealedTurn` and lingers in the UI forever, floating to the bottom and duplicating the `[USER INTERRUPT]` text already present in the sealed chunks. Additionally, in multi-client scenarios with no local initiator, the backfill loop will incorrectly tag this lingering consumed message with a future turn's ID.

**Verdict: DO NOT SHIP.** A new Blocker must be fixed. The fix is a one-line change in the `message-consumed` handler to bind consumed messages to the active turn.

---

## Detailed Findings

### Q1. Backend Claims Verification
**Confirmed.** The backend code in `packages/api/src/agent-manager.ts` and `packages/core/src/agent/agent.ts` confirms that:
1. `turn-start` is emitted exactly once per `processMessage`.
2. Exactly one user row draft is persisted via `explodeUserText`.
3. Queued messages are pulled into a running turn via `dequeueMessages` and NEVER trigger a `turn-start`.

### Q2. Block Fix Correctness
The new backfill logic correctly skips `queued-` rows and tags exactly one initiator when a local initiator exists.
* **(a) `[initiator, queued-X]`**: Correctly skips `queued-X`, tags `initiator`, and breaks.
* **(b) `[queued-X, initiator]`**: Logically impossible; the initiator is appended before a queue can form.
* **(c) `[queued-X, queued-Y]` consumed**: When `queued-X` is consumed, its prefix is stripped. It becomes an untagged user message. When the NEXT turn starts, if there is a local initiator, it tags the new initiator and ignores the consumed message.
* **(d) Multi-client (no local initiator)**: If Client B starts a turn, Client A receives `turn-start` but has no local initiator in `live`. Client A's backfill loop will find the untagged consumed message from the *previous* turn and incorrectly tag it with the *new* turn's ID.

### Q3. No Duplication / No Loss
**Failed.** Because the backfill loop `break`s after tagging the new initiator, the consumed message from the previous turn remains permanently untagged (`turnId === undefined`). It survives the `turn-sealed` reconcile process and floats to the bottom of the live tail. Since the backend injects the consumed message's text into the `[USER INTERRUPT]` chunk row, the user sees BOTH the tool result chunk text AND a lingering user bubble.

### Q4. `keptLive` Unchanged — Still Correct?
**Failed.** `keptLive` preserves optimistic rows by checking `m.turnId === undefined && m.role === "user"`. This was intended for pending initiators and queues, but it inadvertently preserves consumed messages because they never received a `turnId`. Consumed messages MUST be bound to the turn that consumed them so they are cleanly dropped when that turn seals.

### Q5. Test Adequacy
**The new test simulates an impossible backend sequence.**
The test creates `q1`, consumes it, and then fires `turn-start`, assuming `turn-start` applies to the consumed `q1`. The backend never emits a `turn-start` for a consumed message. By forcing the backfill loop to tag a consumed message, the test mistakenly verifies an action that in reality constitutes cross-turn ID theft.

### Q6. Prompt-Caching Invariant
**SAFE.** The backend logic in `packages/core/src/agent/agent.ts` was untouched. Cache stability is preserved.

---

## NEW Blockers

### Block #1: Consumed messages linger and duplicate due to missing `turnId`
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:1226` (inside `handleEvent` case `"message-consumed"`)

**Description:**
When `message-consumed` extracts a queued message, it strips the prefix but leaves `turnId` undefined. The message survives `turn-sealed` and lingers in `live` forever, duplicating the chunk data. In multi-client scenarios, it also acts as a trap for the next `turn-start` backfill.

**Direction:**
In `message-consumed`, bind the consumed message to the actively streaming turn so `reconcileSealedTurn` drops it cleanly:
```typescript
if (mcEvent.messageIds.includes(queuedId)) {
    consumed.push({ 
        ...m, 
        id: queuedId, 
        turnId: mcTab.liveTurnId ?? undefined // Bind to active turn
    });
    continue;
}
```
With this fix, the `turn-start` loop's `break` behavior is perfectly safe, as consumed messages will no longer be "untagged".

---

## Resolution (OpenCode)

### Block #1 (consumed interrupt messages linger + duplicate) — FIXED
`packages/frontend/src/lib/tabs.svelte.ts`, `handleEvent` case `"message-consumed"`.

Verified the finding against the code: `keptLive` (in `reloadChunksFromApi`) preserves
every `m.turnId === undefined && m.role === "user"` row, and `message-consumed` was
pushing `{ ...m, id: queuedId }` with **no** `turnId`. So a consumed interrupt bubble
was kept on every reconcile — lingering at the tail and duplicating the
`[USER INTERRUPT]` text the backend folds into the sealed tool-result chunk
(`agent.ts:1248-1255`). This contradicted the intended "collapse to persisted shape"
behavior.

Applied Gemini's direction (with the codebase's conditional-spread style): bind the
consumed row to the in-flight turn so reconcile drops it on seal —
```ts
consumed.push({
  ...m,
  id: queuedId,
  ...(mcTab.liveTurnId !== null ? { turnId: mcTab.liveTurnId } : {}),
});
```
`liveTurnId` is always set while a turn runs (the only time a consume happens). The
ChatPanel keyer (`${turnId}:${role}:${n}`, per-(turn,role) counter) gives the consumed
row a distinct key from the initiator, so no key collision during the live interrupt
split. This also makes the Pass-2 `turn-start` backfill `break` fully safe (no
untagged consumed rows remain to be mis-tagged in the multi-client path Q2(d)).

### Test fixes (addressing Q5)
The Pass-2 test was rewritten — Gemini correctly flagged that consuming a message and
then firing `turn-start` at it is not a real backend sequence. Replaced with two
realistic tests in `chat-store.test.ts`:
1. `"turn-start backfill skips a pending queued row (race), tags only the initiator"` —
   drives the **real** race via `store.sendMessage`: an idle send (plain optimistic
   row) followed by a running send (queued row), then a late `turn-start`. Asserts the
   initiator is tagged, the queued row is NOT, and the queued row survives the seal
   with no duplicate initiator.
2. `"a consumed interrupt message collapses into the sealed turn (no lingering bubble)"`
   — realistic interrupt flow (turn-start → stream → queue → consume → stream → seal);
   asserts the consumed row is bound to the turn and dropped on reconcile. Fails on the
   pre-fix code (row lingers untagged), passes after.

### Verdict response
- Q1 backend claims: confirmed by Gemini and re-confirmed here.
- Q2(d) multi-client mis-tag: eliminated — consumed rows are no longer untagged.
- Q3/Q4 lingering+duplication: FIXED.
- Q6 cache invariant: SAFE — change is frontend store/test only; `agent.ts` untouched.
- Q7: no new Blockers introduced.

### Verification
Frontend **69 tests pass** (chat-store 54 incl. the two new tests, sidebar 15);
`svelte-check` 0 errors; Biome clean. Core (223) + api (35) unaffected → 327 total.