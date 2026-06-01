# Review: Dispatch — Claude Wake Schedule (r1/claude-reset-fix)

## Executive Summary

**HOLD.** While the backend restructuring for the 4-probe coalescing is elegant and the database migrations are sound, the attempt to fix the frontend snapshot race condition is fundamentally flawed. The new `SnapshotSequencer` utility drops server responses based on client-side sequencing, but fails to account for network reordering on the *upstream* path. Under rapid user interaction, this will permanently desync the UI from the server. This desync is severely compounded by a design flaw in the toggle endpoint itself, which ignores explicit client intent. 

## Findings

### 1. `SnapshotSequencer` fails to prevent UI desync under concurrent POSTs (Critical)
**Location:** `packages/frontend/src/lib/snapshot-sequencer.ts` and `packages/frontend/src/lib/components/ClaudeReset.svelte`
**Issue:** The `SnapshotSequencer` assumes that a later client request will always contain a strictly fresher view of the server's global state. However, concurrent `fetch` calls can overtake each other on the network. If a user clicks 9 AM (Request A, seq 1) and immediately clicks 10 AM (Request B, seq 2):
1. Network jitter causes Request B to be received and processed by the server *first*.
2. The server toggles 10 AM and returns the global state `{10}`.
3. The server then receives Request A, toggles 9 AM, and returns `{9, 10}`.
4. Regardless of which response arrives at the client first, the sequencer dictates that seq 2 (the `{10}` snapshot) is the "winner" and seq 1 (the `{9, 10}` snapshot) is dropped.
**Impact:** The server state is `{9, 10}` but the UI is permanently stuck at `{10}`.
**Recommended Fix:** The simplest fix is to prevent concurrent mutations entirely. Replace the per-hour `pendingHours` lock with a global `isMutating` boolean that disables all toggle buttons while *any* POST request is in flight. The `SnapshotSequencer` can remain to protect against the `loadFromServer()` vs. user click race, but mutating requests must be sequentially ordered by the client.

### 2. Toggle endpoint ignores client intent, compounding desync (High)
**Location:** `packages/api/src/routes/models.ts` (~line 924)
**Issue:** The `POST /wake-schedule/toggle` endpoint blindly determines whether to turn an hour ON or OFF based on its *own* local state (`if (wakeSchedule[hour] !== undefined) ...`). It does not validate the client's intent. If the UI suffers the desync described in Bug 1 (the UI thinks 9 AM is OFF, but the server knows it is ON), the user will naturally click 9 AM to turn it on. The client sends `{ hour: 9, timestamps: {...} }` (clearly intending to turn it ON). The server, seeing `wakeSchedule[9]` is already defined, ignores the timestamps and toggles the hour OFF. 
**Impact:** The user's clicks feel broken. They try to turn an hour on, but the server invisibly turns it off, keeping the UI looking broken.
**Recommended Fix:** Make the toggle endpoint idempotent. Require the client to send an explicit intent (e.g., `{ action: 'on', timestamps }` or `{ action: 'off' }`). If the client says "on" but it's already on, simply update the timestamps (or no-op) and return the current snapshot without deleting the hour.

### 3. Retry storm re-wakes successful accounts (Low)
**Location:** `packages/api/src/routes/models.ts` (`wakeAllClaudeAccounts` and `processPendingRetry`)
**Issue:** If a user has multiple Anthropic accounts and only *one* of them fails a wake probe (e.g., due to expired credentials), `recordWake` returns `false`. This triggers the scheduler's background retry loop for 30 minutes. Every 5 minutes, `processPendingRetry` calls `wakeAllClaudeAccounts()`, which will re-probe *all* configured accounts, including the ones that already succeeded.
**Recommended Fix:** Likely acceptable as a known trade-off since the Anthropic probe payload is tiny (16 tokens) and cheap, but it's worth noting as a minor waste of resources. To fix, you would need to track per-account success state in the `pendingRetry` object.

## Verification of prior-review fixes

1. **Clock skew / latency rejects valid toggles (High):** **FIXED.** The server now correctly accepts finite past timestamps and relies on the tick loop to advance them safely.
2. **Race condition in global snapshot (High):** **NOT FIXED.** The author added `SnapshotSequencer`, which handles out-of-order *responses* correctly, but fails catastrophically when the server processes the *requests* out-of-order (see Finding 1).
3. **Missing transaction boundary (Medium):** **FIXED.** The `persistSchedule` function now wraps the DELETE and INSERT loop in a synchronous `db.transaction()`.
4. **Redundant concurrency logic (Nit):** **FIXED.** The unreachable `inFlightSeq` was removed, leaving only `pendingHours`.
5. **Masked boot recovery reason (Nit):** **FIXED.** The text `" (boot recovery)"` is successfully appended to the reason string.

## Things the author got right

* **Data-Loss Protection:** The `db.transaction()` wrapper safely prevents partial persistence wipes.
* **Schema Boundary:** The SQLite destructive migration is perfectly executed. Using `PRAGMA table_info` to detect the old schema and dropping *only* the `wake_schedule` table correctly preserves user API keys, settings, and chunks.
* **Math Purity:** Extracting `nextDailyAfter` and `recoverScheduleEntry` away from the Hono app allows them to be rigorously unit-tested, and those test cases cover the edge cases thoroughly.
* **Tick Coalescing:** The transition from 1 probe to 4 probes was handled intelligently. Coalescing all due slots into a single API tick prevents wasteful bursts of HTTP requests on boot or when gracefully recovering missed schedules.

## Open design questions / deferred items

* **DST Transition Drift:** The scheduler continues to use `DAILY_INTERVAL_MS` (24h) absolute additions. This means that a scheduled 9:00 AM wake will drift to 10:00 AM or 8:00 AM when the user's local daylight saving time transitions, correcting only when the user manually toggles the UI.
* **No Snapshot Polling:** As flagged in the previous review, the frontend still has no mechanism (polling or SSE) to react to background state changes. If a retry loop successfully completes in the background, the UI will continue to say "Retrying..." until the user refreshes the page or clicks another button.
