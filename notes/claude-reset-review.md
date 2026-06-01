# Review: Dispatch — Claude Wake Schedule (r1/claude-reset-fix)

## Executive Summary

The overall architecture of this rewrite is surprisingly elegant, especially the separation of pure scheduling logic (`wake-scheduler.ts`) and the coalescing tick loop. The DB schema migration is handled correctly per the requirements, and the Svelte 5 implementation correctly avoids common reactivity pitfalls. 

However, **I recommend a HOLD** on shipping this branch as-is. There are two high-severity issues: one that will cause legitimate user toggles to be rejected by the server (due to network latency/clock skew interacting with a strict time validation), and another race condition where the global UI state can be overwritten by stale data if the user interacts quickly. There is also a data-loss risk in the SQLite persistence logic due to a missing transaction boundary.

## Findings

### 1. Clock skew / latency rejects valid toggles (High)
**Location:** `packages/api/src/routes/models.ts` (~line 918)
**Issue:** When toggling an hour on, the client generates four timestamps for the slots using `nextOccurrenceAt`, which bases its math on the client's `Date.now()`. When the server receives the request, it validates each timestamp strictly: `if (... raw <= now) return 400;`. 
If a user toggles an hour that is imminent (e.g., they click 9:00 at 8:59:59.999), or if their local clock is just a few milliseconds behind the server, the generated `9:00:00` timestamp can be slightly in the past by the time the server evaluates `Date.now()`. The server will reject the entire request with a 400 Bad Request, breaking the UI toggle.
**Fix:** The backend scheduler's `recoverScheduleEntry` is already perfectly equipped to handle past timestamps by firing them immediately and rolling them forward. Remove the `raw <= now` validation on the POST route, or change it to allow a generous grace period (e.g., `raw <= now - MISSED_WAKE_GRACE_MS`).

### 2. Race condition in global snapshot application (High)
**Location:** `packages/frontend/src/lib/components/ClaudeReset.svelte` (`postToggle` and `loadFromServer`)
**Issue:** The frontend replaces its entire `schedule` state whenever it receives a response from the server (`applySnapshot`). While the author added a per-hour `inFlightSeq` lock to prevent rapid clicks *on the same hour* from causing issues, this does not protect against toggles across *different* hours.
If a user quickly clicks "9 AM" and then "10 AM", two concurrent POST requests are fired. If the network delivers the response for 9 AM *after* the response for 10 AM, the older global snapshot (which only knows about 9 AM) will blindly overwrite the UI state, causing the 10 AM mark to disappear visually. The exact same race condition exists between the initial `$effect` `loadFromServer()` call and a rapid user toggle.
**Fix:** Use a single global `snapshotSeq` counter for all `/models/wake-schedule` responses, or implement selective merging of the returned `schedule` data into the local state rather than replacing the whole object.

### 3. Missing transaction boundary causes data loss (Medium)
**Location:** `packages/api/src/routes/models.ts` (`persistSchedule` function)
**Issue:** The `persistSchedule` function performs a `db.run("DELETE FROM wake_schedule")` followed by a loop of `insert.run(...)`. If any insertion fails (e.g., due to disk space, bad data, or arbitrary SQLite errors), the `catch` block simply ignores the error. However, the `DELETE` has already been committed, completely wiping out the user's persistent wake schedule upon the next boot.
**Fix:** Wrap the `DELETE` and `INSERT` loop inside a single `db.transaction(...)` so that any failure safely rolls back the deletion.

### 4. Redundant concurrency logic (Nit)
**Location:** `packages/frontend/src/lib/components/ClaudeReset.svelte` (`toggleHour` vs `postToggle`)
**Issue:** The author notes in `HANDOFF.md` that `inFlightSeq` handles rapid out-of-order double clicks. However, they also implemented a strict UI lock: `if (pendingHours.has(hour)) return;` at the very start of `toggleHour`. This makes it impossible to dispatch a second request for the same hour until the first completes. Consequently, `inFlightSeq` is completely unreachable dead code.
**Fix:** Remove `inFlightSeq` entirely and rely on the `pendingHours` lock, or remove the `pendingHours` early-return if optimistic UI interaction is preferred.

### 5. Masked boot recovery reason (Nit)
**Location:** `packages/api/src/routes/models.ts` (`schedulerTick`)
**Issue:** If `needsBootFire` is true and `due.length > 0`, the `reason` string for the retry tracker correctly joins the due slot names but drops the fact that a boot recovery also occurred.
**Fix:** Append `" (plus boot recovery)"` to the `reason` string if `needsBootFire` is true.

## Design / Architectural Concerns

*   **No Snapshot Polling:** As noted in the handoff, the frontend explicitly does not poll for backend state changes. This means that if a retry loop runs in the background and eventually succeeds, the UI will permanently say "Retrying..." or display a stale error state until the user interacts with the panel again or refreshes the page. A slow background poll (e.g., every 60s) or SSE feed is recommended.
*   **DST Transition Drift:** Adding `24 * 60 * 60 * 1000` (`DAILY_INTERVAL_MS`) to an absolute Unix timestamp ignores Daylight Saving Time transitions. A scheduled 9:00 AM wake will drift to 10:00 AM or 8:00 AM when the user's local clock changes. The author documented this limitation, but it's a regression in usability vs a true calendar-aware cron.

## Things the author got right

*   **Pure Logic Extraction:** Extracting the math for `nextDailyAfter` and `recoverScheduleEntry` into pure functions with 100% test coverage makes the most critical parts of this feature verifiable without SQLite/Hono overhead.
*   **Tick Coalescing:** Using the `isTickRunning` lock and advancing all due slots *before* awaiting the upstream `fireWake()` call correctly avoids re-entrancy bugs and retry storms.
*   **Svelte 5 Reactivity:** The usage of Svelte 5 `$derived.by` for `fadedHours` and `$derived` for `currentHour` is idiomatic and correctly avoids the stale reactivity bugs that plagued the previous implementation.
*   **Destructive Migration:** Handling the schema change by checking `PRAGMA table_info` for the missing column and dropping the table is clean and respects the boundary constraints.