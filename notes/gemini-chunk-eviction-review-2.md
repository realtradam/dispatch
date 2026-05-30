# Code Review (Pass 2): Chunk-Native Frontend Eviction

## Executive Summary

The fixes applied since Pass 1 successfully address the two major Blockers related to reconciling active turns and optimistic UI state. The decoupling of reconcile logic from `agentStatus` in favor of `liveTurnId` elegantly solves the race conditions around deferred reconciliations and interrupt boundaries. 

However, a **NEW Blocker** was identified in how `turn_id`s are backfilled onto user messages when a turn starts. The loop indiscriminately tags pending `queued-` messages that belong to *future* turns, causing them to be wiped when the *current* turn finishes.

**Verdict: DO NOT SHIP.** The new Blocker must be fixed. The fix is a trivial one-line condition.

---

## Pass 1 Fixes & Invariants

* **Fix #1: Deferred reconcile wipes concurrent active turns.** 
  **VERDICT: FIXED.** `reloadChunksFromApi`'s new `preserveTurnId` logic perfectly handles overlapping turns. It correctly preserves Turn B's in-flight chunks while dropping Turn A's, and cleanly nullifies state when appropriate. The Map `pendingReconcileTabs` ensures any intermediate turns are fetched comprehensively from the DB.
* **Fix #2: Optimistic queued user messages are dropped on reconcile.**
  **VERDICT: FIXED (Partially).** The condition `(m.turnId === undefined && m.role === "user")` inside `keptLive` effectively retains optimistic user messages. However, see the New Blocker below regarding `turnId` assignment.
* **Cache Safety Invariant.**
  **VERDICT: SAFE.** `toModelMessages` and Anthropic normalization logic were completely untouched. The backend's prompt caching remains strictly bound to DB-persisted rows.
* **`messages` -> `renderGroups` Rename Completeness.**
  **VERDICT: COMPLETE.** No stray references to `tab.messages` were found. Reactivity safely bounds derived state within `updateTab`.

---

## NEW Findings

### 1. `turn-start` wrongly tags future queued messages (Block)
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:873-882` (inside `handleEvent` case `turn-start`)

**Description:**
When a turn starts, the frontend loops backwards through `tab.live` to tag untagged user messages with the new `turnId`. It breaks only when it hits a non-user or an already-tagged message. 

If multiple messages are queued (e.g. `[queued-B, queued-C]`), and the backend dequeues `B`, `message-consumed` removes the prefix and puts `B` at the end of the array: `[queued-C, B]`. Immediately after, `turn-start` for Turn B fires, looping backward. It tags `B` with `"Turn B"`, but continues and ALSO tags `queued-C` with `"Turn B"`. When Turn B subsequently seals, `queued-C` is wiped from the UI because its `turnId` matches the sealing turn, and it loses the protection of `turnId === undefined`. It vanishes until Turn C actually finishes processing.

This same bug happens if the user queues a message in the tiny race-window between sending their first prompt and the WS `turn-start` event arriving.

**Direction:** The backfill loop must explicitly ignore queued messages. Add a check to prevent tagging them: `if (m && m.role === "user" && m.turnId === undefined && !m.id.startsWith("queued-"))`.

---

## Evaluation of New Regression Tests

The two new regression tests are highly valuable, but miss critical permutations:

1. **"preserves an optimistic queued user message..."**
   * **Genuinely covers:** Fix #2. It proves `keptLive` preserves an untagged queued message during a reconcile.
   * **Untested edge case:** It queues the message *after* `turn-start` fires. Therefore, it completely bypasses the `turn-start` backfill loop. A test should queue a message *before* `turn-start` fires (or queue *two* messages and consume one) to expose the new Blocker above.
2. **"preserves a concurrent newer turn..."**
   * **Genuinely covers:** Fix #1. It correctly validates `preserveTurnId` logic, the `currentAssistantId` mapping, and `liveTurnId` integrity when a deferred reconcile flushes across a newer streaming turn.
   * **Untested edge case (Map last-write-wins):** It only seals *one* turn while scrolled up. A test should seal *two* turns while scrolled up, then scroll down, ensuring `pendingReconcileTabs` handles the latest `turnId` and the entire window is correctly loaded.

---

## Resolution (OpenCode)

### Block #1 (`turn-start` wrongly tags future queued messages) — FIXED
`packages/frontend/src/lib/tabs.svelte.ts` `handleEvent` case `turn-start`.

Backend reality check (not in Gemini's model): a queued message **never** gets its
own `turn-start`. `turn-start` is emitted exactly once per user-initiated
`processMessage` (`agent-manager.ts:1128`), which persists exactly one user row via
`explodeUserText`. Queued messages are drained *into* the running turn through
`dequeueMessages`/`message-consumed` (`agent.ts:1241,1308`). So the turn's initiator
is always the single most-recent **non-queued** untagged user row, and any `queued-`
row in the live tail belongs to a future turn.

Gemini's literal one-liner (`&& !m.id.startsWith("queued-")` with the existing
`else break`) is **insufficient**: when the queued row is the trailing element the
loop would `break` on it and never tag the real initiator, leaving the initiator
untagged → it duplicates against its own sealed chunk row on reconcile.

Implemented fix: the backfill now (a) stops at the first non-user row, (b) **skips
past** (`continue`) pending `queued-` rows, and (c) tags exactly the one most-recent
non-queued untagged user row, then breaks. `keptLive` is unchanged — untagged
`queued-` rows remain untagged and are preserved on reconcile.

### Test gap — ADDRESSED
Added `"turn-start backfill skips a pending queued row trailing the turn initiator"`
in `chat-store.test.ts`: constructs live = `[<plain initiator>, queued-q2]`, fires
`turn-start`, asserts the initiator is tagged and `queued-q2` is **not**, then seals
and asserts `queued-q2` survives with no duplicate initiator bubble
(`renderGroups` roles = `[user, assistant, user]`). This exercises the `continue`
(skip-queued) branch and covers the queue-present-before-`turn-start` race Gemini
flagged as untested.

### Nits (deferred, non-blocking)
- `pendingReconcileTabs` last-write-wins doc/test (seal two turns while scrolled up):
  acceptable as-is — the deferred flush refetches the full window from the DB, so the
  latest sealed `turnId` correctly supersedes; left as a follow-up test.

### Verification
Full suite: **326 tests pass** (core 223 incl. 33-test agent/cache-stability suite,
api 35, frontend 68). Biome clean; `tsc` core+api and `svelte-check` report 0 errors.
Cache invariant remains untouched (no `agent.ts` wire/folding/caching changes).