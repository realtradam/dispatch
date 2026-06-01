# Handoff — n2/ntfy-notifications

## Summary

Adds **ntfy.sh push notifications** to Dispatch: a configurable per-event
notification dispatcher that POSTs to a user-supplied ntfy topic URL when
notable events happen in the running agent process.

The architecture is intentionally layered so a future transport (email,
Slack webhook, custom backend) plugs in without touching call sites:

```
AgentManager.onEvent ─┐                       ┌─→ sendNtfy (fetch)
                      ├─→ NotificationDispatcher.notify(event)
PermissionMgr ────────┘   (filter / dedupe)   └─→ (other transports later)
.onPromptAdded
```

### Event taxonomy

The user toggles each one independently in Settings:

| event                 | trigger                                                                  | default | priority | tags             |
|-----------------------|--------------------------------------------------------------------------|---------|----------|------------------|
| `turn-completed`      | assistant `done` event (one per cleanly-finished turn)                   | on      | 3        | white_check_mark |
| `turn-error`          | assistant `error` event (final, after all fallback retries)              | on      | 4        | rotating_light   |
| `permission-required` | `PermissionManager` newly admits a prompt to its pending list            | on      | 4        | lock             |
| `agent-spawned`       | `tab-created` for a **top-level user agent** (parent=null, slug present) | off     | 2        | sparkles         |

Each notification carries a short tab tag (`tab-<first8>`) so multi-tab users
can tell which conversation pinged them.

### Design notes

- **Non-blocking**: `dispatcher.notify` does `void Promise.resolve(send(...)).catch(warn)`.
  A slow or unreachable ntfy server never stalls a turn. Worst case is a
  10s per-request abort timeout in the transport.
- **Dedupe**: 5 s in-memory window keyed by `dedupeKey`. Used for
  `permission-required` because the permission system rebroadcasts the
  whole pending list on every change (we'd otherwise re-fire on every
  unrelated mutation).
- **Master switch + per-event toggle**: both must allow before a send.
  Disabled config is a fast no-op (no fetch, no `loadConfig` work past
  the early return).
- **Single global config**: matches the rest of the codebase's settings
  table (`perm_*`, `title_model_*` are also global). Stored as one JSON
  blob under `settings.key = 'ntfy_config'`.
- **Auth token round-trip**: `GET /notifications` redacts the token but
  surfaces `hasAuthToken: boolean`. `PUT /notifications` semantics:
  `authToken === undefined` keeps the stored value, `""` clears it, any
  other string replaces it. The frontend's "Clear stored token" button
  uses the explicit-`""` path.
- **Header injection guard**: CR/LF and control chars are stripped from
  `Title`/`Tags` before they go into `fetch` headers.
- **Permission "added" detection**: `PermissionManager.broadcastPending`
  now diffs the current pending-id set against an `announcedPromptIds`
  set and fires `onPromptAdded` only for genuinely new ids. Resolved ids
  are pruned. This keeps the contract "one notification per prompt".

## Files changed / added

```
packages/core/src/notifications/types.ts            +97   (new)
packages/core/src/notifications/ntfy.ts             +125  (new)
packages/core/src/notifications/config.ts           +73   (new)
packages/core/src/notifications/dispatcher.ts       +238  (new)
packages/core/src/notifications/index.ts            +29   (new)
packages/core/src/index.ts                          +2    (barrel re-export)
packages/core/tests/notifications/ntfy.test.ts      +173  (new, 16 tests)
packages/core/tests/notifications/config.test.ts    +130  (new, 10 tests)
packages/core/tests/notifications/dispatcher.test.ts +325 (new, 13 tests)

packages/api/src/permission-manager.ts              ~98   (+ onPromptAdded contract)
packages/api/src/routes/notifications.ts            +82   (new — GET/PUT/POST routes)
packages/api/src/app.ts                             +18   (wire dispatcher + mount routes)
packages/api/tests/permission-manager.test.ts       +103  (new, 4 tests)
packages/api/tests/routes.test.ts                   +51   (add mocks for new core exports)

packages/frontend/src/lib/components/SettingsPanel.svelte  +256  (new ntfy section)
```

Three commits on `n2/ntfy-notifications`:

```
786bc43 feat(frontend): ntfy.sh settings block in SettingsPanel
21cdb11 feat(api): wire notification dispatcher into app + /notifications routes
5e72191 feat(core): ntfy.sh notification dispatcher module
```

## Public surface added

### New config (persisted in `settings` table)

- `settings.key = "ntfy_config"` → JSON-serialized `NtfyConfig`:
  ```ts
  {
    enabled: boolean,
    topicUrl: string,
    authToken: string,
    events: {
      "turn-completed": boolean,
      "turn-error": boolean,
      "permission-required": boolean,
      "agent-spawned": boolean,
    },
  }
  ```

### New API routes

- `GET  /notifications` →
  `{ config: NtfyConfig & { hasAuthToken: boolean }, eventTypes: string[], defaults: NtfyConfig }`
  (authToken is always returned as `""`; `hasAuthToken` reflects what's stored)
- `PUT  /notifications` → accepts partial `NtfyConfig`. Validates topic URL
  when `enabled === true`. Returns the saved (redacted) config or `400`.
- `POST /notifications/test` → sends a `turn-completed`-typed test
  notification using the saved config. Returns `{ ok, status?, error? }`,
  or `400` if disabled / invalid topic / event-type disabled, or `502` on
  ntfy server failure.

### New core exports (via `@dispatch/core` barrel)

Types: `NotificationEvent`, `NotificationEventType`, `NtfyConfig`,
`NtfyPriority`, `NtfySendResult`, `FetchLike`, `DispatcherOptions`,
`AgentEventSource`, `PermissionPromptSource`, `TabTitleLookup`.

Values: `NotificationDispatcher`, `sendNtfy`, `validateTopicUrl`,
`loadNtfyConfig`, `saveNtfyConfig`, `clearNtfyConfig`,
`normalizeNtfyConfig`, `defaultNtfyConfig`, `redactNtfyConfig`,
`NTFY_EVENT_TYPES`, `NTFY_DEFAULT_EVENTS`, `NTFY_DEFAULT_PRIORITIES`,
`NTFY_DEFAULT_TAGS`, `NTFY_CONFIG_KEY`.

### New API surface on `PermissionManager`

- `onPromptAdded(listener) => unsubscribe` — fires exactly once per
  genuinely-new pending prompt id (with `{ id, permission, description, metadata }`).

### New exported singleton in `packages/api/src/app.ts`

- `notificationDispatcher: NotificationDispatcher` — already wired to
  the module-level `agentManager` and `permissionManager`. Exposed so
  tests / future callers can `dispose()` or `notify(...)` directly.

### Frontend

No new exported props — the change is entirely inside `SettingsPanel.svelte`
and uses its existing `{ keys, apiBase }` props.

## Verification status

### `bun run check`

```
$ biome check .
Checked 150 files in 175ms. No fixes applied.
```

✅ Pass (0 errors, 0 warnings).

### `bun run test`

```
Test Files  28 passed (28)
     Tests  436 passed (436)
  Duration  2.93s
```

✅ Pass. Baseline was 393 tests in 24 files; this branch adds 43 tests
across 4 new files (`notifications/ntfy.test.ts` ×16,
`notifications/config.test.ts` ×10, `notifications/dispatcher.test.ts` ×13,
`permission-manager.test.ts` ×4) and modifies 0 existing tests.

### Per-package strict typecheck

```
@dispatch/core   tsc --noEmit             — 0 errors
@dispatch/api    tsc --noEmit             — 0 errors
@dispatch/frontend svelte-check           — 0 errors, 0 warnings
```

### Manual smoke test

Verified end-to-end against the real `ntfy.sh` server with no auth:

```
$ bun -e 'import { sendNtfy } from "./packages/core/src/notifications/ntfy.js"; ...'
Sending to: https://ntfy.sh/dispatch-smoke-ofntnrp4
{"ok":true,"status":200}
```

(Topic was throwaway and only used for this smoke test.) Full UI flow
(Settings → topic URL → Save → Send test → push lands in ntfy app)
was not executed because that requires a live `bun run dev:api` plus
`dev:frontend` plus a phone with the ntfy app — but the same code path
that the "Send test" button exercises is what the smoke test above hit,
and the route logic on top of it is covered by unit tests.

## Assumptions / known gaps

Decisions made without product input (the spec said "ask if ambiguous";
each of these felt unambiguous in the context of Dispatch's current
single-user, single-process design):

1. **Single global config, not per-user.** The existing `settings` table
   is global (e.g. `title_model_*`, `perm_*` — all single-tenant). When
   Dispatch grows real multi-tenancy this'll need a `user_id` column and
   a load-by-user helper, but that's a much bigger refactor than this
   feature.

2. **Auth token persisted in plain text.** Same as the existing
   `credentials` / `api_keys` tables in this DB; SQLite at-rest
   encryption isn't a thing in this codebase. Token never leaves the
   DB on the read path (`GET /notifications` redacts).

3. **No rate-limiting or burst grouping** beyond the 5 s permission
   dedupe. Notification-worthy events are human-scale infrequent (one
   per turn, one per permission prompt). If someone hammers `summon` and
   ships 50 user agents in 10 seconds, they'll get 50 pushes — that
   matches "agent-spawned is off by default" being the right call.

4. **No click-URL deep-link to the originating tab.** The frontend
   doesn't currently route tabs by URL (`router.svelte.ts` just toggles
   between `dashboard` and `agent-builder`), so I left `clickUrl`
   plumbing in the transport layer for callers but didn't synthesize
   one in the dispatcher. A future "open this tab" router change would
   make this a 4-line addition in `buildTurnCompleted` / etc.

5. **Event taxonomy is intentionally small.** I considered `model-changed`
   and `queue-overflow`/`auto-wake-budget-exhausted` notices but they
   felt like "annoying push" rather than "useful push"; easy to add
   later by extending `NotificationEventType`, `NTFY_DEFAULT_EVENTS`,
   and adding a builder + dispatch hook.

6. **Subagent completions don't notify.** `attachToAgentManager` filters
   `agent-spawned` to `parentTabId === null && agentSlug` (top-level user
   agents only). `turn-completed`/`turn-error` fire for any tab including
   subagents, which is technically what the user asked for (turn
   completion) but could be noisy if someone runs a parent agent that
   spawns many short-lived subagents. Toggle-off-`turn-completed` is the
   escape hatch today; a separate "include subagents" toggle would be a
   trivial follow-up.

7. **Ntfy server-side validation is minimal.** We only check that the
   topic URL is a syntactically-valid `http(s)://host/topic`. We don't
   ping the server on save (would slow the UI and confuse users behind
   captive portals). The "Send test" button is the integration check.

Working tree is clean; three commits on `n2/ntfy-notifications`; nothing
merged.
