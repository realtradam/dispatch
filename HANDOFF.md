# Claude Reset / Wake Schedule — Fix Handoff

**Branch:** `r1/claude-reset-fix` (off `dev`)
**Worktree:** `/home/tradam/projects/dispatch/r1-claude-reset-fix`
**Commits:** 4 atomic commits (see `git log r1/claude-reset-fix ^dev --oneline`).

---

## Summary

The "Claude Wake Schedule" panel (`ClaudeReset.svelte` + `/models/wake-schedule*`
routes + the in-memory backend scheduler) had several real bugs that would
silently lose wakes, drift over time, or behave erratically in the UI. It
also only probed once per marked hour, which is unreliable at rate-window
edges.

This branch fixes the bugs *and* upgrades probing to 4× per hour
(`:00 / :15 / :30 / :45`), with same-tick coalescing so the upstream still
sees a single call. Schema changed destructively (per direction); migration
code drops the old `wake_schedule` table.

### What was broken

#### Backend (`packages/api/src/routes/models.ts`)
1. **Missed wakes silently lost.** `loadScheduleFromDB` saw any past
   `next_wake_at`, rewrote it to the next occurrence using server-local TZ,
   and never fired the missed wake. So if the API was down when a wake was
   due (overnight container restart), the user lost it entirely.
2. **Server-TZ drift.** `nextOccurrenceAt15(hour)` used `new Date().setHours()`
   — *server* local time. The client sends absolute Unix ms (user's local
   wall-clock intent). On a UTC Docker host running for a PST user, each
   reschedule re-anchored to the wrong TZ and slowly migrated the fire time.
3. **Retry storm.** Every failed wake pushed a new entry into a
   `pendingRetries[]` array, all converging at the same `+5min` instant.
4. **Retry/fire race within a tick.** A freshly fired wake AND a due retry
   could both hit `wakeAllClaudeAccounts()` back-to-back.
5. **No status surface.** Nothing told the user whether scheduled wakes
   actually succeeded.
6. **Only one probe per hour.** A single fire at `:15` can land 14 min off
   the actual rate-window reset moment.

#### Frontend (`packages/frontend/src/lib/components/ClaudeReset.svelte`)
7. **`fadedHours` returned a function, not a Set.** The `$derived` had shape
   `(): Set<number> => {...}` — `blockClass` then called `fadedHours()`
   once per of the 24 buttons, rebuilding the Set 24× per render.
8. **`currentHour` was frozen.** `const currentHour = $derived(new Date().getHours())`
   — `new Date()` is not a reactive read; the value never updated. After
   midnight (or any hour boundary) the "now" highlight stayed on the wrong
   block until reload.
9. **Out-of-order toggles.** Rapid double-clicks fired multiple requests;
   the *last response* won, not the *last click* — so a slow add followed
   by a fast remove could land in the wrong order.
10. **No success/failure feedback.** No surface for whether the most-recent
    wake actually worked.

### What I changed

| # | Bug / Feature | Fix |
|---|---|---|
| 1 | Missed wake silently lost | New `recoverScheduleEntry()` helper: if missed by ≤ 2h fire on next tick; either way roll forward by 24h-multiple steps. |
| 2 | Server-TZ drift | Removed server-local `nextOccurrenceAt15`; rescheduling now uses `nextDailyAfter(previous, now)` — adds 24h × N from the *client-supplied* original ms. |
| 3 | Retry storm | Replaced `pendingRetries: []` with a single shared `pendingRetry: PendingRetry \| null` whose budget resets on subsequent failures. |
| 4 | Retry/fire race | Retry processing skipped on any tick where a fresh wake fired. |
| 5 | No status surface | `GET /wake-schedule` now returns `{ schedule, resetOffsetHours, probeSlotMinutes, lastWake, pendingRetry }`. |
| 6 | One probe/hour | A marked hour expands to 4 slots (`:00 :15 :30 :45`), each its own row. Multiple due slots in the same tick coalesce into one upstream wake. |
| 7 | `fadedHours` was a fn | Now `$derived.by(() => Set)`; passed as a value to `blockClass`. Window length is `resetOffsetHours - 1` (no longer hardcoded 4). |
| 8 | Frozen `currentHour` | Backed by `nowMs = $state(Date.now())`, bumped every 30s via `setInterval`, cleaned up in `onDestroy`. |
| 9 | Out-of-order toggles | Per-hour sequence counter (`inFlightSeq`) + `pendingHours: Set<number>` that disables in-flight buttons; stale responses dropped. |
| 10 | No feedback | New status row: "✓ Last wake N min ago" or "✗ Last wake N min ago — <error>"; pending retry row shows retries-left + next-attempt countdown. |

Also extracted `CLAUDE_RESET_OFFSET_HOURS = 5` and `PROBE_SLOT_MINUTES = [0,15,30,45]`
to a single source of truth in `packages/api/src/wake-scheduler.ts`; the
frontend learns both from the server snapshot.

---

## Files changed

- **New:** `packages/api/src/wake-scheduler.ts` — pure helpers
  (`nextDailyAfter`, `recoverScheduleEntry`, `resetHourFor`,
  `isProbeSlotMinute`, `CLAUDE_RESET_OFFSET_HOURS`,
  `MISSED_WAKE_GRACE_MS`, `DAILY_INTERVAL_MS`, `PROBE_SLOT_MINUTES`,
  `ProbeSlotMinute`).
- **New:** `packages/api/tests/wake-scheduler.test.ts` — 12 unit tests for
  the pure helpers (grace boundaries, multi-day skip, custom grace,
  midnight wraparound).
- **Modified:** `packages/api/src/routes/models.ts` — full rewrite of the
  wake-scheduler section (~280 LoC). Routes preserved
  (`POST /models/wake`, `POST /models/wake-schedule/toggle`,
  `GET /models/wake-schedule`) but request/response payloads expanded.
- **Modified:** `packages/api/tests/routes.test.ts` — +12 HTTP tests for
  the wake-schedule routes (was +9 in the prior commit; rewritten for
  the 4-slot payload).
- **Modified:** `packages/core/src/db/index.ts` — `wake_schedule` schema
  changed; destructive migration drops the old table if the
  `slot_minute` column is missing. Nothing else touched.
- **Modified:** `packages/frontend/src/lib/components/ClaudeReset.svelte`
  — full rewrite of the script section; markup updated for the marked-hour
  summary + the status footer.

---

## Public surface changes

### Database schema

```sql
-- BEFORE
CREATE TABLE wake_schedule (
  hour         INTEGER PRIMARY KEY CHECK (hour BETWEEN 0 AND 23),
  next_wake_at INTEGER NOT NULL
)

-- AFTER
CREATE TABLE wake_schedule (
  hour         INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  slot_minute  INTEGER NOT NULL CHECK (slot_minute IN (0, 15, 30, 45)),
  next_wake_at INTEGER NOT NULL,
  PRIMARY KEY (hour, slot_minute)
)
```

Migration on boot: if `PRAGMA table_info(wake_schedule)` lacks a
`slot_minute` column, `DROP TABLE IF EXISTS wake_schedule` then `CREATE`
the new shape. **No other table is touched** (credentials, api_keys,
usage_cache, tabs, chunks, settings preserved).

### API: `GET /models/wake-schedule`

```json
{
  "schedule": {
    "9": { "0": 1700001500000, "15": 1700002400000, "30": 1700003300000, "45": 1700004200000 }
  },
  "resetOffsetHours": 5,
  "probeSlotMinutes": [0, 15, 30, 45],
  "lastWake": {
    "firedAt": 1700000000000,
    "ok": true,
    "results": [{ "label": "personal", "ok": true }]
  } | null,
  "pendingRetry": {
    "retriesLeft": 5,
    "nextRetryAt": 1700000300000,
    "reason": "scheduled probe(s) 9:15"
  } | null
}
```

### API: `POST /models/wake-schedule/toggle`

**Add** (when hour is not yet marked):

```json
{
  "hour": 9,
  "timestamps": { "0": 1700001500000, "15": 1700002400000, "30": 1700003300000, "45": 1700004200000 }
}
```

All four slot keys are required; each value must be a future Unix ms.
Returns the same expanded snapshot as `GET`.

**Remove** (when hour *is* marked):

```json
{ "hour": 9 }
```

Same shape as before. Deletes all 4 slots for that hour atomically.

Validation: hour must be an integer 0–23. Non-integer / out-of-range
hours → 400. Missing or non-object `timestamps` on add → 400. Missing,
non-finite, or past timestamp in any slot → 400.

### Component props

`ClaudeReset.svelte` props unchanged: still `{ apiBase?: string }`.

### New exported helpers

`packages/api/src/wake-scheduler.ts` exports `nextDailyAfter`,
`recoverScheduleEntry`, `resetHourFor`, `isProbeSlotMinute`,
`CLAUDE_RESET_OFFSET_HOURS`, `DAILY_INTERVAL_MS`,
`MISSED_WAKE_GRACE_MS`, `PROBE_SLOT_MINUTES`, `ProbeSlotMinute`,
`RecoveredEntry`. Not re-exported from `@dispatch/core` — they live in
`@dispatch/api` and aren't intended cross-package surface.

---

## End-to-end traces

### Happy path: mark 9 AM
1. User clicks the "9" AM block.
2. Frontend computes 4 timestamps in **user's local TZ** for the next
   occurrence of `9:00`, `9:15`, `9:30`, `9:45`.
3. `POST /models/wake-schedule/toggle { hour: 9, timestamps: { "0":…, "15":…, "30":…, "45":… } }`.
4. Backend writes 4 rows to `wake_schedule`, returns snapshot. Button
   turns primary, +4 trailing blocks fade.
5. Tick loop runs every 30s. At `9:00` the `0`-minute slot becomes due;
   the tick advances its `next_wake_at` to tomorrow `9:00`, persists,
   and fires *one* coalesced wake. Same dance at 9:15, 9:30, 9:45 —
   each is a separate upstream call (different 15-min windows).
6. If two slots happen to come due in the *same* 30s tick (e.g. the
   scheduler was paused), they coalesce into ONE upstream wake.

### Recovery: API was down when 9:15 fired
1. Server boots at 11:00. Reads 4 rows for hour 9. The `9:00`, `9:15`,
   `9:30`, `9:45` slots all have `next_wake_at` ≤ now, all overdue by
   ≤ 2h → all `shouldFireNow: true`.
2. Each slot's `next_wake_at` is advanced to tomorrow's equivalent
   wall-clock via `nextDailyAfter`. The boot-fire flag is set.
3. First tick runs immediately, sees `needsBootFire`, fires ONE coalesced
   wake. `lastWake` shows ✓ on the panel.

### Recovery: API was down for two days
1. Server boots Wed at 14:00. Slots for Mon 9:00/15/30/45 are overdue by
   > 48h → `shouldFireNow: false`.
2. Each `nextWakeAt` jumps forward by `nextDailyAfter` (ceil-div, single
   step — not a 48-iteration loop) to Thu 9:00/15/30/45.
3. Schedule preserved; no spurious wake; entry resumes normally.

### Rapid double-click
1. User clicks "9" → request A (add, seq=1) in flight; button disabled.
2. User clicks "9" again → request B (remove, seq=2) in flight.
3. Response B arrives → `inFlightSeq[9] === 2` → applied.
4. Response A arrives later → `inFlightSeq[9] !== 1` → dropped.

---

## Verification

### `bun run check`
```
$ biome check .
Checked 142 files in 155ms. No fixes applied.
```

### `bun run test`
```
Test Files  25 passed (25)
     Tests  417 passed (417)
  Start at  09:52:16
  Duration  2.80s
```

(Was 393 tests at branch base; +24 net = 12 helper unit tests + 12 HTTP
route tests for the 4-slot wake schedule.)

### TypeScript strict checks
- `bun --bun tsc -p packages/api/tsconfig.json --noEmit` → exit 0
- `bun --bun tsc -p packages/core/tsconfig.json --noEmit` → exit 0
- `bun run --cwd packages/frontend typecheck` → svelte-check 0 errors, 0 warnings

---

## Assumptions / known gaps

1. **TZ behavior:** absolute `timestamp` from the toggle request is the
   source of truth for *first* fire. On reschedule the slot advances by
   exactly 24h × N from its previous `next_wake_at`. Preserves the user's
   local wall-clock intent regardless of server TZ. **DST transition days
   can drift the fire by ±1h**; self-corrects when the user next toggles
   the hour. A more thorough fix would store hour + IANA TZ and recompute
   each cycle — punted; requires UI for TZ selection.

2. **Missed-wake grace = 2h.** Picked because Claude's typical session
   window is ~5h. Tunable in `wake-scheduler.ts:MISSED_WAKE_GRACE_MS`;
   `recoverScheduleEntry` accepts a custom value (exercised in tests).

3. **Same-tick coalescing.** Hitting `:00 :15 :30 :45` produces 4 wakes
   per hour at steady state. Two slots due in the *same* 30s tick
   coalesce into one upstream call — there's no value in 2 simultaneous
   probes. The advancement-then-fire ordering means a slow upstream
   call can't cause re-firing on the next tick.

4. **"Reset" semantics:** I interpreted the "Reset by HH:00" label as a
   display hint (wake + 5h ≈ when Claude's session window resets), not
   a separate event. The scheduler only fires *wakes*. The `+5h`
   constant lives in `CLAUDE_RESET_OFFSET_HOURS` if it ever needs
   changing.

5. **Recurring daily.** Matches prior behavior; no UI for one-shot
   wakes.

6. **`nowMs` ticker = 30s on the frontend.** Current-hour ring updates
   within at most 30s of the hour boundary. Status "X min ago" labels
   refresh at the same cadence.

7. **Retry budget = 6 × 5min = 30min.** Unchanged from before, just
   consolidated to a single shared slot.

8. **Snapshot polling:** frontend refreshes the snapshot on mount and
   after toggles. `lastWake` / `pendingRetry` rows are therefore stale
   between user actions; the displayed *relative* timestamps DO refresh
   live (driven by the same `nowMs` ticker). Adding a 30s poll would be
   a one-liner if desired — left off to avoid quiet background traffic
   for a panel that's typically only opened intentionally.

9. **Destructive migration.** Per direction: no back-compat. Any
   existing rows in `wake_schedule` from before this branch are dropped
   on first boot. Users will need to re-mark their hours. No other
   tables are touched.

10. **No backend test for `loadScheduleFromDB` recovery branch.** The
    module-level scheduler state is initialized at import time; covering
    the boot-path recovery from a Vitest module requires either DI for
    the DB or spinning up real SQLite. I covered the pure logic via
    `recoverScheduleEntry` unit tests and the route surface end-to-end
    via HTTP tests. A follow-up could refactor `loadScheduleFromDB` to
    take a `db` parameter and write a fixture-backed integration test.
