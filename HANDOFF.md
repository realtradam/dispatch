# Claude Reset / Wake Schedule — Fix Handoff

**Branch:** `r1/claude-reset-fix` (off `dev`)
**Worktree:** `/home/tradam/projects/dispatch/r1-claude-reset-fix`
**Commits:** 3 atomic commits (see `git log r1/claude-reset-fix ^dev --oneline`).

---

## Summary

The "Claude Wake Schedule" panel (`ClaudeReset.svelte` + `/models/wake-schedule*`
routes + the in-memory backend scheduler) had several real bugs that would
silently lose wakes, drift over time, or behave erratically in the UI. This
branch fixes them with three logically separate commits.

### What was broken

#### Backend (`packages/api/src/routes/models.ts`)
1. **Missed wakes silently lost.** On boot, `loadScheduleFromDB` saw any
   past `next_wake_at` and just rewrote it to the *next* occurrence using
   server-local TZ — without firing the missed wake. So if the API was down
   when a wake was due (e.g. overnight container restart), the user lost
   that fire entirely. This directly contradicts the panel's whole purpose
   (overnight task that needs a Claude session to refresh at HH:15).
2. **Server-TZ drift.** `nextOccurrenceAt15(hour)` used `new Date().setHours()`,
   which is *server* local time. The client sends absolute Unix ms (user's
   local wall-clock intent). On a UTC Docker host running for a PST user,
   each reschedule re-anchored to the wrong TZ and slowly migrated the
   fire time off the user's intended hour.
3. **Retry storm.** Every failed wake pushed a new entry into a
   `pendingRetries[]` array, all converging at the same `+5min` instant.
   Multiple consecutive failures could spawn N retries that all hit
   simultaneously.
4. **Retry/fire race.** Within a single tick, a freshly fired wake AND a
   due retry could both hit `wakeAllClaudeAccounts()` back-to-back.
5. **No status surface.** Nothing told the user whether a scheduled wake
   actually succeeded.

#### Frontend (`packages/frontend/src/lib/components/ClaudeReset.svelte`)
6. **`fadedHours` returned a function, not a Set.** The `$derived` had
   shape `(): Set<number> => {...}` — `blockClass` then called
   `fadedHours()` once per of the 24 buttons, rebuilding the Set 24× per
   render and defeating Svelte's memoization entirely.
7. **`currentHour` was frozen.** `const currentHour = $derived(new Date().getHours())`
   — `new Date()` is not a reactive read, so the value never updated. After
   midnight or any hour boundary the "now" highlight stayed on the wrong
   block until the page was reloaded.
8. **Out-of-order toggles.** Rapid double-clicks fired multiple requests;
   the *last response* won, not the *last click* — so a slow add followed
   by a fast remove could land in the wrong order, leaving the user with
   an unexpected scheduled hour.
9. **No success/failure feedback.** No surface for whether the most-recent
   wake actually worked.

### What I changed

| # | Bug | Fix |
|---|---|---|
| 1 | Missed wake silently lost | New `recoverScheduleEntry()` helper: if missed by ≤ 2h fire on next tick; either way roll forward by 24h-multiples. |
| 2 | Server-TZ drift | Removed server-local `nextOccurrenceAt15`; rescheduling now uses `nextDailyAfter(previous, now)` — adds 24h * N from the *client-supplied* original ms. |
| 3 | Retry storm | Replaced `pendingRetries: PendingRetry[]` with a single shared `pendingRetry: PendingRetry \| null` whose budget resets on subsequent failures. |
| 4 | Retry/fire race | Retry processing skipped on any tick where a fresh wake fired. |
| 5 | No status surface | `GET /wake-schedule` now returns `{ schedule, resetOffsetHours, lastWake, pendingRetry }`. |
| 6 | `fadedHours` was a fn | Now `$derived.by(() => Set)`; passed as a value to `blockClass`. Window length is `resetOffsetHours - 1` (no longer hardcoded 4). |
| 7 | Frozen `currentHour` | Backed by `nowMs = $state(Date.now())`, bumped every 30s via `setInterval`, cleaned up in `onDestroy`. |
| 8 | Out-of-order toggles | Per-hour sequence counter (`inFlightSeq`) + `pendingHours: Set<number>` that disables in-flight buttons; stale responses dropped. |
| 9 | No feedback | New status row: "✓ Last wake N min ago" or "✗ Last wake N min ago — <error>"; pending retry row shows retries-left + next-attempt countdown. |

Also: extracted `CLAUDE_RESET_OFFSET_HOURS = 5` into one place (was
hardcoded in 3 places: frontend `resetHour`, frontend `fadedHours` loop
length, conceptual semantics). Frontend now learns the value from the
server snapshot.

---

## Files changed

- **New:** `packages/api/src/wake-scheduler.ts` — pure helpers
  (`nextDailyAfter`, `recoverScheduleEntry`, `resetHourFor`,
  `CLAUDE_RESET_OFFSET_HOURS`, `MISSED_WAKE_GRACE_MS`, `DAILY_INTERVAL_MS`).
- **New:** `packages/api/tests/wake-scheduler.test.ts` — 12 unit tests for
  the pure helpers (grace boundaries, multi-day skip, custom grace
  windows, midnight wraparound).
- **Modified:** `packages/api/src/routes/models.ts` — rewrote the
  `// ─── Wake scheduler` section (~165 LoC). All public route paths
  (`POST /models/wake`, `POST /models/wake-schedule/toggle`,
  `GET /models/wake-schedule`) preserved.
- **Modified:** `packages/api/tests/routes.test.ts` — +9 HTTP tests for
  the wake-schedule routes.
- **Modified:** `packages/frontend/src/lib/components/ClaudeReset.svelte`
  — full rewrite of the script section; markup mostly unchanged (added
  `disabled` to buttons + a status footer).

---

## Public surface changes

### API: `GET /models/wake-schedule`

**Before:**
```json
{ "schedule": { "9": 1700000000000 } }
```

**After (additive — `schedule` key unchanged):**
```json
{
  "schedule": { "9": 1700000000000 },
  "resetOffsetHours": 5,
  "lastWake": {
    "firedAt": 1700000000000,
    "ok": true,
    "results": [{ "label": "personal", "ok": true }]
  } | null,
  "pendingRetry": {
    "retriesLeft": 5,
    "nextRetryAt": 1700000300000,
    "reason": "scheduled wake at hour 9"
  } | null
}
```

### API: `POST /models/wake-schedule/toggle`

- Returns the same expanded snapshot shape as `GET`.
- Now rejects non-integer hours (`4.5` → 400). Range check (0–23)
  unchanged. Past timestamps on add still rejected.
- Delete request shape unchanged (`{ hour }` with no `timestamp`).

### Component props

- `ClaudeReset.svelte` props unchanged: still `{ apiBase?: string }`.

### New exported types/helpers

- `packages/api/src/wake-scheduler.ts` exports `nextDailyAfter`,
  `recoverScheduleEntry`, `resetHourFor`, `CLAUDE_RESET_OFFSET_HOURS`,
  `DAILY_INTERVAL_MS`, `MISSED_WAKE_GRACE_MS`, `RecoveredEntry`.
- Not re-exported from `@dispatch/core` — they live in `@dispatch/api`
  and are intentionally not part of the cross-package public surface.

---

## End-to-end traces

### Happy path: schedule wake at 9 AM
1. User clicks the "9" AM block.
2. Frontend computes `nextOccurrenceAt15(9)` in **user's local TZ** →
   absolute ms.
3. `POST /models/wake-schedule/toggle` `{ hour: 9, timestamp }`.
4. Backend stores `wakeSchedule[9] = timestamp`, persists to SQLite,
   restarts the tick loop. Returns full snapshot.
5. Frontend applies snapshot; button turns primary, +4 trailing blocks
   fade.
6. Tick loop runs every 30s. When `Date.now() >= timestamp`, the entry's
   `next_wake_at` is bumped via `nextDailyAfter` (preserves wall-clock
   intent across 24h) and `wakeAllClaudeAccounts()` runs.
7. `lastWake` is updated; surfaced on next snapshot poll.

### Recovery: API was down when 9:15 fired
1. Server boots at 11:00. Reads `wake_schedule` row `{ hour: 9, next_wake_at: 9:15-today }`.
2. `recoverScheduleEntry(9:15, 11:00)` → `{ shouldFireNow: true, nextWakeAt: 9:15-tomorrow }`
   (overdue by 1h45m, within 2h grace).
3. `loadScheduleFromDB` sets `wakeSchedule[9] = Date.now()`, persists.
4. First tick runs immediately, sees `ts <= now`, advances via
   `nextDailyAfter`, fires the wake. `lastWake` shows ✓ on the panel.

### Recovery: API was down for two days
1. Server boots Wed at 14:00. Reads `next_wake_at = Mon 9:15`.
2. Overdue by > 2h → `shouldFireNow: false`. `nextWakeAt` jumps forward
   by multiples of 24h to `Thu 9:15` (`nextDailyAfter` ceil-div, not loop).
3. Schedule is preserved; no spurious wake; entry resumes normally.

### Rapid double-click
1. User clicks "9" → request A (add, seq=1) in flight.
2. User clicks "9" again → request B (remove, seq=2) in flight; button
   disabled in between (visual cursor: wait + opacity).
3. Response B arrives → applied (inFlightSeq[9] === 2 → match → apply).
4. Response A arrives later → `inFlightSeq[9] !== 1` → dropped.

---

## Verification

### `bun run check`
```
$ biome check .
Checked 142 files in 148ms. No fixes applied.
```

### `bun run test`
```
Test Files  25 passed (25)
     Tests  414 passed (414)
  Start at  09:30:27
  Duration  2.83s
```

(Was 393 tests before this branch; +21 = 12 helper unit tests + 9 HTTP
route tests for the wake schedule.)

### TypeScript strict checks (run individually — covered by Biome+svelte-check otherwise)
- `bun --bun tsc -p packages/api/tsconfig.json --noEmit` → exit 0
- `bun --bun tsc -p packages/core/tsconfig.json --noEmit` → exit 0
- `bun run --cwd packages/frontend typecheck` → svelte-check 0 errors, 0 warnings

---

## Assumptions / known gaps

These were not specified by the orchestrator; I made the call so the code
ships in a usable state. None should be controversial, but flag them if
the user wants different semantics.

1. **TZ behavior:** the absolute `timestamp` from the toggle request is
   the source of truth for *first* fire. On reschedule the entry advances
   by exactly 24h * N from the previous `next_wake_at`. This preserves
   the user's local wall-clock intent regardless of server TZ. **DST
   transition days can drift the fire by ±1h**; it self-corrects the
   next time the user toggles the hour. A more thorough fix would store
   the hour + IANA TZ and recompute each cycle — punted because it
   requires UI for TZ selection.

2. **Missed-wake grace = 2h.** Picked because Claude's typical session
   window is ~5h — recovering within the first 40% of that window still
   leaves the user real working time. Tunable in
   `wake-scheduler.ts:MISSED_WAKE_GRACE_MS`. The 3rd argument of
   `recoverScheduleEntry` accepts a custom value, exercised in tests.

3. **"Reset" semantics:** I interpreted the "Reset at HH:00" label as a
   *display hint* (wake + 5h ≈ when Claude's session window resets), not
   a separate event. The scheduler only fires *wakes*; the "reset" label
   helps the user reason about which 5h window each wake protects.
   The `+5h` constant lives in `CLAUDE_RESET_OFFSET_HOURS` if it ever
   needs changing.

4. **Recurring vs one-shot:** the implementation is **recurring daily**
   (matches the previous behavior). There is no UI for one-shot wakes.

5. **`nowMs` ticker resolution = 30s** on the frontend. The
   current-hour ring updates within at most 30s of the hour boundary,
   which is plenty given hour granularity. Status "X min ago" labels
   refresh at the same cadence.

6. **Retry budget = 6 × 5min = 30min.** Unchanged from the original
   implementation; just consolidated to a single shared slot. If both a
   scheduled wake fails AND retries are exhausted, the next opportunity
   is the next day's scheduled fire — no infinite retry.

7. **Snapshot polling:** frontend only refreshes the snapshot on mount
   and after toggles. The `lastWake` / `pendingRetry` rows are therefore
   slightly stale between user actions. Adding a 30s poll would be a
   one-liner if desired, but it'd also generate quiet background traffic
   for a panel that's typically only opened intentionally — I left it
   off. The displayed "N min ago" / "in N min" relative timestamps DO
   refresh live (driven by the same `nowMs` ticker).

8. **No backend test for `loadScheduleFromDB` recovery branch.** The
   module-level scheduler state is initialized at import time, so
   exercising the recovery branch from a Vitest module requires either
   restructuring to inject the DB or spinning up a real SQLite. I
   covered the pure logic via `recoverScheduleEntry` unit tests
   instead, and verified the route surface end-to-end via HTTP tests.
   If you want belt-and-braces coverage of the boot path, the right move
   is to refactor `loadScheduleFromDB` to take a `db` parameter and
   write a fixture-backed integration test — happy to do that in a
   follow-up if asked.
