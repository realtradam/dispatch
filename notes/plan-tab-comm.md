# Implementation Plan: Tab-to-Tab Agent Communication

## Summary

Give every tab a **short, human-readable handle** visible in the UI, and give
agents **two new tools** to talk to each other by that handle:

1. **`send_to_tab`** — deliver a user message to another tab by its short ID.
   - Target **mid-turn** → message is **queued** (identical path to a user message).
   - Target **idle** → message **wakes** the tab and starts a new turn.
   - Fire-and-forget: returns immediately, does not block on a response.
2. **`read_tab`** — return the target tab's **last completed assistant turn** plus
   its current status (`idle` / `running` / `error`). Non-blocking snapshot.

The tools are gated behind two independent permissions (both default off):
**`perm_send_to_tab`** (message other tabs) and **`perm_read_tab`** (read other
tabs), mirroring how `perm_user_agent` gates user-agent spawning. Splitting them
lets an operator grant read-only visibility without also granting the ability to
wake/steer other tabs.

This enables: handing an agent a tab handle and asking it to steer another AI,
chaining agents, and one agent delegating subtasks to a peer tab.

### The short ID is git-style: derived, not stored

We do **not** add a `short_id` column. The handle is the **shortest unique
prefix of the tab's existing UUID**, exactly like git short commit hashes:

- A prefix is valid as long as it uniquely identifies one open tab.
- Minimum display length is 4 hex chars; if two open tabs collide on those 4,
  the displayed handle grows one char at a time until unambiguous.
- Resolution accepts **any length** ≥ a small floor and matches by prefix.

This means the short form is a **pure projection** of data we already store —
no new column, no migration, no backfill, no unique-ID generation/retry, no
collision bookkeeping at insert time. It also can't drift: a prefix is always
computed against the current set of open tabs.

### The good news: the wake/queue machinery already exists

`POST /chat` (`packages/api/src/app.ts`) **already** implements exactly the
routing the wishlist describes:

```ts
if (agentManager.getTabStatus(tabId) === "running") {
    agentManager.queueMessage(tabId, message, queueId);   // mid-turn → queue
} else {
    agentManager.processMessage(tabId, message, ...);      // idle → new turn
}
```

The new `send_to_tab` tool reuses this same decision via a small shared
`AgentManager` method. We are **not** inventing a new delivery mechanism — we're
exposing the existing one to agents and adding addressing by a derived handle.

---

## Current architecture (for context)

- **Tab identity**: tabs are keyed by `crypto.randomUUID()` — a canonical
  **lowercase** hex UUID (verified: both `crypto.randomUUID()` and the frontend's
  non-secure fallback emit lowercase). Created via `createTab()` in
  `packages/core/src/db/tabs.ts`, reached from:
  - `POST /tabs` (frontend "+" button → `createNewTab`)
  - `AgentManager.spawnChildAgent` (summon, sub/user agents)
- **Message delivery**: `AgentManager` owns per-tab state in `tabAgents`
  (`Map<tabId, TabAgent>`). Key methods:
  - `processMessage(tabId, msg, keyId?, modelId?, ...)` — runs a full turn,
    persists chunks, resolves completion promises.
  - `queueMessage(tabId, msg, clientId?)` — pushes to `tabAgent.messageQueue`
    and wakes blocking tools via `queueListeners`.
  - `getTabStatus(tabId)` — `"idle" | "running" | "error"`.
- **Tools**: built per-tab in `getOrCreateAgentForTab`. Two paths — a
  permission-gated path (top-level tabs) and a `toolsOverride` whitelist path
  (child agents). Each tool is a `ToolDefinition` whose `execute` closes over
  **callbacks** supplied by `AgentManager` (see `createSummonTool`,
  `createRetrieveTool`). This is the seam the new tools plug into.
- **History**: a tab's conversation is a flat append-only `chunks` log. The last
  assistant turn is recoverable via `getChunksForTab(tabId)` →
  `groupRowsToMessages(...)` → last `role === "assistant"` message.
- **Permissions**: read in `getOrCreateAgentForTab` via `getSetting("perm_*")`,
  folded into `permKey` (cache-invalidation), surfaced as checkboxes in
  `ToolPermissions.svelte` with defaults in `settings.svelte.ts`.
- **SQLite `LIKE`**: case-insensitive for ASCII by default (no
  `case_sensitive_like` PRAGMA set), so `6FE8` resolves `6fe8…` for free. `%`
  and `_` are wildcards → incoming prefixes MUST be sanitized (see below).

---

## Part A — Git-style short tab handles

### The two halves

A derived-prefix scheme has a **display** side (compute the shortest unique
prefix to show) and a **resolution** side (match an arbitrary-length prefix back
to one tab). They live in different layers:

| Concern | Where | Why |
|---|---|---|
| **Display** — each open tab's shortest unique prefix | Frontend (`tabs.svelte.ts`) | The frontend already holds every open tab's full UUID; computing prefixes client-side needs zero new wire data and updates reactively as tabs open/close |
| **Resolution** — prefix string → real `tabId` | Backend DB (`db/tabs.ts`) | The tools run server-side and must resolve against the authoritative open-tab set |

Because the handle is derived, **nothing new is stored or sent**. No change to
the `tabs` schema, no `tab-created` payload change.

### Display: shortest-unique-prefix (frontend)

`packages/frontend/src/lib/tabs.svelte.ts`
- Add a derived helper, e.g. `shortHandleFor(tabId)`, computed against the
  current open `tabs`:
  - Start at length 4. If any **other** open tab shares that prefix, increment
    until unique (cap at full UUID as the degenerate fallback).
  - Expose as a `$derived` map `{ tabId → handle }` so the tab bar and any
    "Agents" view stay in sync as tabs open/close.
- This naturally yields 4-char handles in the common case and only grows on a
  genuine leading-hex collision among open tabs.

`packages/frontend/src/lib/components/TabBar.svelte`
- Render the handle as a small mono badge next to the title (both the user-tab
  row and the subagent row). This is the human/LLM-visible addressing token.

> Note: the existing debug `shortId` helper in `tabs.svelte.ts` (first-8-char
> slice) is unrelated and stays as-is; the new handle is collision-aware.

### Resolution: prefix → tab (backend)

`packages/core/src/db/tabs.ts`
- New `resolveTabPrefix(prefix: string): { status: "ok"; tab: TabRow } |
  { status: "none" } | { status: "ambiguous"; matches: TabRow[] }`:
  1. **Sanitize**: lowercase; reject/strip anything outside `[0-9a-f-]` so the
     SQLite `LIKE` wildcards `%`/`_` can't be injected. Enforce a min length
     (e.g. 4) to avoid absurdly broad matches.
  2. Query open tabs: `SELECT * FROM tabs WHERE is_open = 1 AND id LIKE $p`
     with `$p = prefix + '%'`.
  3. 0 rows → `none`; 1 row → `ok`; >1 → `ambiguous` (return the matches so the
     caller can list them).
- Scope to `is_open = 1`: closed tabs are not addressable and shouldn't cause
  phantom ambiguity.
- (Exact full-UUID still works — it's just a maximal prefix.)

`packages/core/src/index.ts`
- Re-export `resolveTabPrefix`.

### Why derive instead of store

- **No migration / backfill / column.** Zero schema churn.
- **No insert-time unique-ID generation** (the race-prone part) — UUIDs are
  already unique by construction.
- **Self-correcting.** If two tabs share a 4-char prefix, both just display 5
  chars; when one closes, the other can shrink back to 4. A stored handle would
  go stale here.
- **Resolution is one indexed-ish `LIKE` scan** over open tabs (a handful of
  rows); negligible cost.

---

## Part B — The two tools

Both live in core as `ToolDefinition` factories taking a callbacks object, and
are wired in `AgentManager` exactly like `summon`/`retrieve`.

### Tool shapes

```
send_to_tab({
  tab_id: string,   // required — the short handle (any unique-length prefix) of the target
  message: string,  // required — the user message to deliver
})
-> "Delivered to tab 6fe8 (status: running → queued)"   // or "(idle → started new turn)"

read_tab({
  tab_id: string,   // required — the short handle of the target tab
})
-> "<tab_response tab=6fe8 status=idle>...last assistant turn text...</tab_response>"
```

The `tab_id` parameter accepts any length prefix; the tool resolves it via
`resolveTabPrefix`. On `ambiguous`, the tool returns the competing handles and
asks the agent to add a character — same UX as `git checkout <ambiguous sha>`.

### `send_to_tab` semantics (mirrors `POST /chat`)

1. `resolveTabPrefix(tab_id)`:
   - `none` → error listing currently-open handles (mirrors how `summon` lists
     valid agent slugs on a bad slug).
   - `ambiguous` → error listing the matching handles; ask for one more char.
   - `ok` → proceed with `tab.id`.
2. Reject sending to **self** (no-op footgun) with a clear message.
3. Prefix the delivered text with provenance so the target (and the user) know
   who sent it and can reply back:
   `[message from tab <senderHandle>]\n\n<message>`
4. Route via a new shared `AgentManager.deliverMessage(tabId, message)`:
   - target `running` → `queueMessage(...)` → report `queued`.
   - target `idle`/`error` → hydrate key/model from the live `TabAgent` (warm)
     or the DB tab row (cold), then `processMessage(...)` → report `started`.
5. Return immediately (fire-and-forget). The sender uses `read_tab` later.

### `read_tab` semantics (non-blocking snapshot)

1. `resolveTabPrefix(tab_id)` (same `none`/`ambiguous` handling).
2. Read `getChunksForTab(tab.id)` → `groupRowsToMessages` → last
   `role === "assistant"` message → flatten its text chunks.
3. Return that text plus `status` from `getTabStatus(tab.id)`:
   - `running` → note the turn is still in progress; returns the **previous**
     completed turn (or "no completed turn yet").
   - `idle` → the just-finished turn.
   - empty history → "Tab has no assistant responses yet."

**Why non-blocking:** two agents that block on each other's results would
deadlock. `retrieve` can block because child agents can't summon their parent;
peer tabs have no such guarantee. A snapshot read + explicit re-read is safe.
(An optional `wait: boolean` flag is possible later but deliberately omitted v1.)

### Why a shared `deliverMessage` method

`POST /chat` and `send_to_tab` make the **same** running/idle decision. Factor it
into one `AgentManager.deliverMessage(tabId, message, opts?)` returning
`{ status: "queued" | "started" }`, and call it from both. Avoids drift between
the HTTP path and the tool path. (Refactor `POST /chat` to use it.)

The tools take a **resolver callback** (`resolveShortId`) wired to
`resolveTabPrefix`, plus `deliver`, `getLastResponse`, `getStatus`,
`listOpenHandles`, and `selfTabId` — all closed over by `AgentManager`, same
pattern as `createSummonTool`.

---

## Changes by file

### Core

| File | Change |
|---|---|
| `packages/core/src/db/tabs.ts` | New `resolveTabPrefix(prefix)` (sanitize → `LIKE` over open tabs → ok/none/ambiguous). **No schema/column change.** |
| `packages/core/src/tools/send-to-tab.ts` | **new** — `createSendToTabTool(callbacks)`; `SendToTabCallbacks { resolveShortId, deliver, listOpenHandles, selfTabId }` |
| `packages/core/src/tools/read-tab.ts` | **new** — `createReadTabTool(callbacks)`; `ReadTabCallbacks { resolveShortId, getLastResponse, getStatus, listOpenHandles }` |
| `packages/core/src/tools/summon.ts` | Add `send_to_tab`, `read_tab` to the `tools` enum + description list so agents can grant them to children |
| `packages/core/src/index.ts` | Re-export `resolveTabPrefix` + the two new tool factories |

> Removed from the earlier draft: `short_id` column, migration, backfill,
> `generateShortId()`, `getTabByShortId()`, and the `shortId` field on
> `TabRow`/`tab-created`. All obsolete under the derived-prefix design.

### API

| File | Change |
|---|---|
| `packages/api/src/agent-manager.ts` | Read `perm_send_to_tab` + `perm_read_tab` + add both to `permKey`; gate each tool independently; build `send_to_tab`/`read_tab` in **both** tool paths (permission path always; child path when `toolsOverride` includes them); add `deliverMessage()`; cold-tab key/model hydrate from DB on wake. Wire tool callbacks to `resolveTabPrefix`/`deliverMessage`/`getChunksForTab`/`getTabStatus`, passing `selfTabId = tabId` |
| `packages/api/src/app.ts` | Refactor `POST /chat` to call `deliverMessage()` |

> `tab-created` payload is **unchanged** (no `shortId`), and `routes/tabs.ts`
> needs no change — the frontend derives handles from UUIDs it already receives.

### Frontend

| File | Change |
|---|---|
| `packages/frontend/src/lib/tabs.svelte.ts` | Add derived `shortHandleFor` / `{tabId→handle}` map (shortest-unique-prefix over open tabs). **No `Tab` field added** — it's derived, not stored |
| `packages/frontend/src/lib/components/TabBar.svelte` | Render the derived handle badge on each tab |
| `packages/frontend/src/lib/components/ToolPermissions.svelte` | Add two entries: `{ id: "send_to_tab", label: "Message other tabs" }` and `{ id: "read_tab", label: "Read other tabs" }` |
| `packages/frontend/src/lib/settings.svelte.ts` | Add `send_to_tab: false` + `read_tab: false` to `toolPerms` + `savedToolPerms` defaults |
| `packages/frontend/src/lib/components/AgentBuilder.svelte` *(if it lists tools)* | Include the two new tool names so agent definitions can grant them |

---

## Files NOT changing

| File | Why |
|---|---|
| `packages/core/src/db/index.ts` | **No schema change** — handle is derived, not stored |
| `packages/core/src/types/index.ts` | `tab-created` unchanged; no `shortId` on the wire |
| `packages/core/src/tools/retrieve.ts` | Unchanged — peer reads use the new `read_tab`, not `retrieve` |
| `packages/core/src/agent/agent.ts` | The agent loop already passes `queueCallbacks`/context to tools; no change needed |
| DB `settings` table | Key-value; `perm_send_to_tab` / `perm_read_tab` need no migration |
| Queue internals (`queueMessage`/`dequeueMessages`/`waitForQueuedMessage`) | Reused as-is |

---

## Testing

- **`packages/core/tests/db/`** — `resolveTabPrefix`: exact UUID → ok; 4-char
  unique → ok; colliding prefix → ambiguous with both matches; unknown → none;
  case-insensitive (`6FE8` ↔ `6fe8`); wildcard injection (`%`, `_`) sanitized;
  closed tabs excluded from matches.
- **`packages/core/tests/tools/`** — `send_to_tab`: none → lists open handles;
  ambiguous → asks for more chars; self-send rejected; provenance prefix applied;
  calls `deliver`. `read_tab`: returns last assistant turn; empty history
  message; status surfaced.
- **Frontend** — shortest-unique-prefix: two tabs sharing 4 hex chars both render
  5; closing one lets the other shrink back to 4; single tab renders 4.
- **`packages/api/tests/agent-manager.test.ts`** — `deliverMessage` routes
  running→queue / idle→processMessage; cold-tab wake hydrates key/model from DB;
  `perm_send_to_tab` / `perm_read_tab` each gate their tool independently + invalidate cache.
- **`packages/api/tests/routes.test.ts`** — `POST /chat` still behaves after the
  `deliverMessage` refactor.
- Manual: tab A messages idle tab B (B wakes); A messages running tab B (queued,
  consumed on B's next turn — see dependency below); A `read_tab` B; ambiguous
  prefix prompts for one more char.

---

## Risks / edge cases / dependencies

- **DEPENDENCY — "queue not consumed after turn" bug.** When the target is
  **running**, `send_to_tab` queues the message. Per the separate wishlist item,
  a queued message currently attaches at end-of-turn but does **not** kick off a
  new turn (`agent.ts` end-of-loop pushes it to history then yields `done`). So
  peer messages to a *busy* tab won't get a reply until that fix lands. The
  **idle-wake** path is fully functional today. → Recommend fixing the queue-
  consumption bug alongside, or shipping idle-wake first and calling out the
  busy-tab limitation.
- **Ambiguous prefix is a first-class outcome**, not an error to hide. Surface
  the competing handles and ask for one more char (git's exact UX). Tests must
  cover it.
- **`LIKE` wildcard injection.** `%`/`_` in a raw prefix would broaden the match.
  Sanitize to `[0-9a-f-]` + min length before querying. Covered by a test.
- **Display vs resolution drift window.** The frontend computes a handle from its
  known open tabs; the backend resolves against the DB. If they momentarily
  disagree (a tab opened elsewhere a beat ago), the worst case is a `none`/
  `ambiguous` the agent retries — self-correcting, no corruption.
- **Cold-tab wake loses fallback chain.** An idle tab not in `tabAgents` (e.g.
  after server restart) only has `key_id`/`model_id` in the DB — the agent
  definition's multi-model `agentModels` fallback chain isn't persisted. Waking
  it uses the single stored model (no fallback). Acceptable degradation; note it.
  (Overlaps with the "key switching not migrating context" wishlist item.)
- **Deadlock avoidance.** `read_tab` is intentionally non-blocking so two agents
  can't wait on each other forever.
- **Runaway agent ping-pong (livelock) — MITIGATED.** Two agents that each reply
  to incoming messages (A wakes B wakes A ...) would spend tokens unbounded with
  no human in the loop. Mitigation: an **origin-aware auto-wake budget** in
  `AgentManager.deliverMessage`. Each tab carries `autoWakeBudget` (max
  `MAX_AGENT_AUTO_WAKES = 6`). A `send_to_tab` call delivers with `origin:
  "agent"`; waking an idle tab consumes one unit. At 0, further agent messages
  are **queued but do NOT wake** the tab (`status: "suppressed"`) and a `notice`
  system chunk is emitted; the `send_to_tab` tool returns a "HELD — do not keep
  resending" message so the sender stops. Any human-originated delivery
  (`POST /chat`, `origin: "human"`, the default) **refills the budget to full**,
  so human-driven and bounded multi-hop delegation are unrestricted; only
  unattended machine-to-machine cascades are capped. Messages are never dropped.
- **Footguns behind a permission.** An agent could spam or wake the user's
  personal tabs. Mitigations: `perm_send_to_tab` / `perm_read_tab` default **off**; self-send
  blocked; provenance prefix makes the source visible to the user.
- **Stale handle in tool description.** Unlike `summon`'s agent catalog, we do
  NOT bake the live tab list into the tool description (it changes constantly).
  Discovery is via the UI badge + the open-handle list returned on none/ambiguous.

---

## Suggested phasing

1. **Phase 1 — Derived handles (Part A).** `resolveTabPrefix` (backend) +
   shortest-unique-prefix display + TabBar badge. No schema change; shippable on
   its own (useful even before the tools).
2. **Phase 2 — Tools (Part B).** `send_to_tab` + `read_tab`, `deliverMessage`
   refactor, `perm_send_to_tab` + `perm_read_tab`, permission UI + defaults, summon whitelist.
3. **Phase 3 — Polish.** Optional "Agents" sidebar view; fix the
   queue-consumption bug so busy-tab delivery replies without a nudge; optional
   `wait` flag on `read_tab`.
