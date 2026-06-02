# Handoff — cr/claude-reset-fix

## Objective
Make the Claude Wake Schedule ("Claude reset") system work reliably end to end.

## Root cause found
The two issues named in the task brief (toggle endpoint ignoring client intent;
server-side request reordering desyncing the UI) were **already fixed** in this
worktree from prior rounds — the toggle endpoint requires an explicit
`action: 'on' | 'off'`, and the frontend serializes mutations behind a global
`pendingHour` lock (verified: tests + code present, suite green).

The *actual* live failure (reproduced by the user: `✗ Last wake 4 min ago —
failed`, blank reason, then `Retrying (6 left…)`) was in the **wake probe
itself**, not the scheduler or UI:

`wakeAllClaudeAccounts()` POSTed a bare body
`{ model, max_tokens, messages: [{role:"user",content:"hi"}] }` with **no
`system[]`**. These accounts are OAuth (Claude Pro/Max) subscriptions, and
Anthropic validates `system[]` on Claude-Code-billed OAuth requests — it
rejects (401/403) any request whose system block lacks the verbatim Claude Code
identity string. So **every** scheduled wake and the manual "Wake now" button
failed. The old code recorded only `ok: res.ok` with no error text, surfacing as
a blank "— failed" that then burned the 6×5-min retry budget.

## Files changed
- **`packages/core/src/credentials/claude.ts`** — new pure
  `buildWakeProbeBody(model)` that mirrors a genuine Claude Code request:
  `system: [{billing-header}, {identity}]` + `messages:[{role:"user",content:"hi"}]`,
  `max_tokens: 16`. Reuses existing `buildBillingHeaderValue` + `SYSTEM_IDENTITY`.
- **`packages/core/src/credentials/index.ts`** — export `buildWakeProbeBody`
  (reachable as `@dispatch/core`).
- **`packages/api/src/routes/models.ts`** — `wakeAllClaudeAccounts` now sends
  `buildWakeProbeBody(WAKE_PROBE_MODEL)` plus the CLI session headers
  (`X-Claude-Code-Session-Id`, `x-client-request-id`), and on `!res.ok` records
  `HTTP <status>: <message>` via new `describeFailedResponse(res)` so the panel
  never shows a bare "failed" again and breakage stays debuggable.
- **`packages/core/tests/credentials/wake-probe.test.ts`** — new: 4 unit tests
  asserting the probe body shape (model/tokens, billing-first/identity-second
  system[], single "hi" user message, determinism).

## Public surface changed
- New export `@dispatch/core` → `buildWakeProbeBody(model: string)`.
- No API route signatures changed. `POST /models/wake`, `POST
  /models/wake-schedule/toggle`, `GET /models/wake-schedule` request/response
  shapes are unchanged. The only externally visible behavior change: failed
  wakes now carry a descriptive `error` string (`HTTP <status>: <message>`)
  instead of an empty one, which the panel already renders.
- DB schema: unchanged.

## Verification
- `bun run check` (biome) → clean, 164 files.
- `bun run test` (vitest) → **568 passed** (post-merge with dev; +4 from this
  branch's new probe-body tests).
- `tsc -p packages/core` and `tsc -p packages/api` → exit 0.
- `svelte-check` (frontend) → 0 errors, 0 warnings.

## Published
Yes. Merged `dev` down into `cr/claude-reset-fix` (clean merge, no conflicts),
re-verified all-green, then `git push . HEAD:dev` (fast-forward, accepted).

## Assumptions / known gaps
- **Live API not testable from the agent sandbox.** The fix is verified offline
  (body shape + headers match the real `transformClaudeOAuthBody` provider path
  and unit tests). The actual "200 OK wake" requires real OAuth credentials and
  was deferred to the user-test gate. If a probe still fails, the panel now shows
  a concrete `HTTP <status>: <message>` reason to diagnose from.
- **Probe model** is hardcoded `claude-3-5-haiku-20241022` (`WAKE_PROBE_MODEL`
  in `models.ts`). Cheap/small by design — only needs to register activity.
- **Deferred (unchanged design trade-offs, pre-existing):** DST drift on the
  24h advance; no background snapshot polling (UI may show stale "Retrying…"
  until next user interaction); retry storm re-probes already-succeeded accounts.
  None of these block reliable wakes; the probe fix addresses the live failure.
