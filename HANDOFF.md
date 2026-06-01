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

**Subagent gating**: `turn-completed` and `turn-error` from subagent tabs
(any tab with a `parentTabId`) are suppressed by default — a parent
agent that spawns 8 subagents would otherwise push 9 "Turn complete"
notifications per round. Toggle on "Include subagent tabs" in Settings
to opt in. `permission-required` is deliberately NOT gated: a
subagent's permission prompt still needs a human tap to proceed, so
suppressing it would silently hang the subagent. `agent-spawned` is
already top-level-only by construction.

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
  uses the explicit-`""` path **and awaits the server response** before
  flipping local UI state (post-review fix — see Review section).
- **Auth header scheme**: tokens that already start with a scheme
  (`Bearer foo`, `Basic dXNlcjpwYXNz`) pass through verbatim; bare tokens
  get a `Bearer ` prefix automatically. Lets users of private ntfy
  servers use any HTTP auth scheme without code changes.
- **Topic-URL validation**: tightened to ntfy's actual constraints —
  exactly one path segment, 1–64 chars, `[A-Za-z0-9_-]` only. Catches
  topics that would silently 404 at publish time.
- **Header injection guard**: CR/LF and control chars are stripped from
  every header value the transport writes (`Title`, `Tags`, `Click`,
  `Authorization`).
- **Permission "added" detection**: `PermissionManager.broadcastPending`
  now diffs the current pending-id set against an `announcedPromptIds`
  set and fires `onPromptAdded` only for genuinely new ids. Resolved ids
  are pruned. This keeps the contract "one notification per prompt".

## Files changed / added

```
packages/core/src/notifications/types.ts             (new)
packages/core/src/notifications/ntfy.ts              (new)
packages/core/src/notifications/config.ts            (new)
packages/core/src/notifications/dispatcher.ts        (new)
packages/core/src/notifications/index.ts             (new)
packages/core/src/index.ts                           (barrel re-export)
packages/core/tests/notifications/ntfy.test.ts       (new, 22 tests)
packages/core/tests/notifications/config.test.ts     (new, 10 tests)
packages/core/tests/notifications/dispatcher.test.ts (new, 13 tests)

packages/api/src/permission-manager.ts               (+ onPromptAdded contract)
packages/api/src/routes/notifications.ts             (new — GET/PUT/POST routes)
packages/api/src/app.ts                              (wire dispatcher + mount routes)
packages/api/tests/permission-manager.test.ts        (new, 4 tests)
packages/api/tests/routes.test.ts                    (add mocks for new core exports)

packages/frontend/src/lib/components/SettingsPanel.svelte  (new ntfy section)
```

Seven commits on `n2/ntfy-notifications`:

```
<new> docs: update HANDOFF.md with notifySubagents
9c93086 feat(notifications): add notifySubagents toggle to suppress subagent turn pings
4185789 docs: update HANDOFF.md with Gemini review triage + post-fix state
1870d0b fix(notifications): address Gemini review — tighten validation, sanitize Click, support Basic auth, non-optimistic UI clear
29bdd00 docs: add HANDOFF.md for ntfy notifications feature
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
    notifySubagents: boolean,  // default false; gates turn-* from subagent tabs
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
Checked 150 files in 158ms. No fixes applied.
```

✅ Pass (0 errors, 0 warnings).

### `bun run test`

```
Test Files  28 passed (28)
     Tests  451 passed (451)
  Duration  2.85s
```

✅ Pass. Baseline was 393 tests in 24 files; this branch adds 58 tests
across 4 new files (`notifications/ntfy.test.ts` ×22,
`notifications/config.test.ts` ×13, `notifications/dispatcher.test.ts` ×19,
`permission-manager.test.ts` ×4) and modifies 0 existing tests.

### Per-package strict typecheck

```
@dispatch/core    tsc --noEmit       — 0 errors
@dispatch/api     tsc --noEmit       — 0 errors
@dispatch/frontend svelte-check      — 0 errors, 0 warnings
```

### Manual smoke test

Verified end-to-end against the real `ntfy.sh` server twice (initial
build + post-review):

```
$ bun -e 'import { sendNtfy } from "./packages/core/src/notifications/ntfy.js"; ...'
validate: null
{"ok":true,"status":200}
```

Topics were throwaway and only used for these smoke tests. Full UI flow
(Settings → topic URL → Save → Send test → push lands in ntfy app)
was not executed because that requires a live `bun run dev:api` plus
`dev:frontend` plus a phone with the ntfy app — but the same code path
that the "Send test" button exercises is what the smoke test above hit,
and the route logic on top of it is covered by unit tests.

## Second-opinion review (Gemini)

After the initial implementation I ran a broad, open-ended code review
via `gemini-3-flash-preview` in YOLO mode (read-only, instructed to find
bugs/flaws/edge-cases). Findings were triaged as follows:

| # | Severity | Finding | Action |
|---|----------|---------|--------|
| 1 | Medium | "Duplicate error+done notifications on LLM fallback retries" | **Rejected.** Verified against `agent-manager.ts:1525–1532` and `:1611`: inner per-attempt errors set `attemptError` and `break` out of the stream loop; only the final terminal error is `this.emit({type:"error"})`-ed. The dispatcher cannot see intermediate retry errors. |
| 2 | Medium | "Loose topic URL validation" | **Fixed.** `validateTopicUrl` now enforces one segment + `[A-Za-z0-9_-]{1,64}`. |
| 3 | Low | "`Click` header not sanitized" | **Fixed.** Passed through `sanitizeHeader`. |
| 4 | Low | "Use JSON publishing for UTF-8 safety in headers" | **Deferred.** Per ntfy docs UTF-8 in `Title` is supported and works in practice; the only realistic risk is non-ASCII tab titles being mangled by an exotic intermediate proxy. Switching to JSON-body publishing would re-architect the transport (and invalidate all header-shape tests) for a hypothetical edge case. Worth a follow-up if anyone reports mangled titles. |
| 5 | Low | "Optimistic UI clear of auth token" | **Fixed.** `clearNtfyAuthToken` now awaits the response and only mutates local state on success; failures surface via the existing error banner. Added a `ntfyClearingToken` loading flag so the button disables + spins during the request. |
| 6 | Nit | "DB read on every notify()" | **Skipped.** SQLite reads are sub-millisecond, events are human-scale infrequent (one per turn at most, dominated by an LLM round-trip taking seconds). Cache adds invalidation complexity for no measurable win. |
| OQ | — | "Support Basic auth, not just Bearer" | **Fixed.** Tokens with a scheme prefix already (`Bearer xyz`, `Basic dXNlcjpwYXNz`) now pass through verbatim; bare tokens still get the `Bearer ` prefix. |

The other open questions: click-URL deep link is still a known gap
below; subagent noise was follow-up-fixed in commit 9c93086 (the
`notifySubagents` flag, off by default).

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
   plumbing in the transport layer (now sanitized as of the Gemini-fix
   commit) but didn't synthesize one in the dispatcher. A future "open
   this tab" router change would make this a 4-line addition in
   `buildTurnCompleted` / etc.

5. **Event taxonomy is intentionally small.** I considered `model-changed`
   and `queue-overflow`/`auto-wake-budget-exhausted` notices but they
   felt like "annoying push" rather than "useful push"; easy to add
   later by extending `NotificationEventType`, `NTFY_DEFAULT_EVENTS`,
   and adding a builder + dispatch hook.

6. **Ntfy server-side validation is minimal.** We only check that the
   topic URL is a syntactically-valid `http(s)://host/topic-segment`
   matching ntfy's documented topic-name rules. We don't ping the server
   on save (would slow the UI and confuse users behind captive portals).
   The "Send test" button is the integration check.

7. **Header-based publishing (vs. JSON-body publishing).** Per the
   Gemini-review triage above, the transport sends `Title`/`Tags`/`Click`
   as HTTP headers. UTF-8 titles work against ntfy.sh itself; non-ASCII
   tab titles through an exotic intermediate proxy could theoretically
   be mangled. Switching to ntfy's JSON publish mode (`Content-Type:
   application/json`, body `{topic, message, title, ...}`) would side-
   step that entirely — leaving as a follow-up if anyone hits it.

Working tree is clean; seven commits on `n2/ntfy-notifications`; nothing
merged.
