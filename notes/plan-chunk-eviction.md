# Plan: Chunk-Native Frontend (per-chunk eviction + pagination)

Closes `eviction-limitation.md`. Kills the frontend `ChatMessage[]` "message"
structure entirely. The frontend's state becomes a **flat chunk log**; memory is
bounded by a **rolling per-chunk eviction**; history is **paginated as raw
chunks** from the backend.

## Locked decisions (from the design discussion)

1. **No stored "message" structure on the frontend.** The store holds a flat
   chunk list. Any grouping into bubbles is a *render-time* projection only
   (see "Rendering" — the one item still to confirm).
2. **Rolling per-chunk eviction.** When a chunk completes while streaming and the
   in-memory chunk count is at `chunkLimit`, drop the oldest chunk. Pure
   count-based window. The only chunk never evicted is the single one currently
   receiving deltas (the open chunk). No turn pinning, no "keep last pair."
3. **Per-turn persistence stays** (backend unchanged in timing). It is the more
   performant choice for a low-RAM/low-IO backend: peak RAM is dominated by the
   agent's in-memory conversation context (required for the cache prefix) which
   both strategies share, while per-seal would multiply fsyncs across the
   streaming loop. One cheap win: wrap the end-of-turn write in a single SQLite
   transaction.
4. **Mid-stream reload is deferred, not engineered away.** A still-streaming turn
   isn't in the DB until it seals. If the user scrolls up into chunks that were
   roll-evicted from the *current* turn, the refetch waits until the turn's write
   lands (the running→idle signal). Accepted.

## The dominating constraint (unchanged)

**Cache cohesion is built 100% server-side and must not be touched.** The
Anthropic wire prefix comes from `toModelMessages` + `applyAnthropicCaching` in
`packages/core/src/agent/agent.ts`, built from the agent's in-memory history
(rebuilt from the chunk log) + the live turn — never from anything the frontend
holds or the WS sends. So **everything here is frontend + one additive raw API
endpoint**; it cannot regress the cache. Out of scope, do not edit: `agent.ts`
wire/folding/caching/interrupt code, `explodeTurn` row ordering, and the
backend's use of `groupRowsToMessages` for *agent history rebuild*.

## Already done (reuse, don't rebuild)

- `getChunksForTab(tabId,{limit,before})` (`db/chunks.ts`) already paginates the
  flat log by `seq`.
- `explodeTurn` and `groupRowsToMessages` (`chunks/transform.ts`) are DB-free,
  browser-importable, and orphan-tolerant (a turn split across a page boundary
  groups correctly). `explodeTurn` emits a **role per draft** — we use that.
- `appendEventToChunks` (`chunks/append.ts`) folds a delta stream into render
  `Chunk[]` correctly (text/thinking/metadata/tool-result/shell-output ordering).
- Chunk table schema already has `seq, turnId, step, role, type, data`.
  **No DB migration, no chat-history reset needed.**

---

## Frontend architecture (chunk-native)

### Store state (per tab) — `tabs.svelte.ts`

```
chunks         : ChunkRow[]        // SEALED history, real per-tab seq, oldest→newest.
                                   // The growing / evictable / paginated structure.
liveRender     : Chunk[]           // transient fold buffer for the CURRENT turn only,
                                   // built by the EXISTING appendEventToChunks.
liveTurnId     : string | null     // turn_id of the in-flight turn (for stable keys).
liveAssistantId: string | null     // == currentAssistantId today.
oldestLoadedSeq: number | null     // min seq in `chunks` (pagination cursor).
totalChunks    : number            // backend total (drives "more to load?").
// DELETED: messages, currentAssistantId(renamed→liveAssistantId), the turnId-merge state.
// Untouched: queuedMessages, cacheStats, agentStatus, model/agent fields, etc.
```

There is **no `messages` field.** The live turn is not a "message" — it's a
one-turn streaming buffer that is reconciled into `chunks` (as real-seq rows) the
moment the turn seals.

### Unified flat view (derived, for render + eviction count)

```
liveFlat = liveTurnId ? explodeTurn(liveTurnId, liveRender)
                          .map((d,i) => ({...d, id:`${liveTurnId}:${i}`, seq:null, live:true}))
                       : []
log      = [...chunks, ...liveFlat]            // one flat, chunk-native list
```

`explodeTurn` is the *same* transform the backend persists with, so the live flat
chunks are byte-for-byte what will land in the DB → reconciliation at seal is
seamless and symmetric. `log` is what we render and count for eviction.

### Streaming (reuse, no new reducer)

- Content events (`text-delta`/`reasoning-*`/`tool-call`/`tool-result`/
  `shell-output`/`error`/`notice`/`model-changed`/`config-reload`) fold into
  `liveRender` via the existing `appendEventToChunks` + `$state.snapshot` clone
  (the documented Svelte-5 proxy hazard — keep it).
- `turn-start` (new tiny WS event, see backend) sets `liveTurnId` /
  `liveAssistantId` so live-flat ids match the sealed rows' turn → no remount at
  seal. Without it, a one-frame remount at seal with identical content; harmless.
- Optimistic user message: on send, append a provisional user row to `chunks`
  with `seq:null, live:true` (or carry it in a tiny `pendingUser` slot). It is
  replaced by the real user row at reconcile.

### Rendering — `ChatPanel.svelte` / `ChatMessage.svelte`

```
renderGroups = groupRowsToMessages(log)   // ephemeral, render-time ONLY
{#each renderGroups as g (g.id)}  <ChatMessage .../>  {/each}
```

Grouping pairs `tool_call`+`tool_result` by `callId` and wraps a turn's
assistant chunks into a bubble — **purely a view projection of the flat log**,
never stored, never used for eviction/pagination. `ChatMessage.svelte` is largely
unchanged (it already renders a grouped turn's `Chunk[]`).

> **DECISION TO CONFIRM (rendering):** default = keep the current bubble look via
> this render-time grouping (chunk-native state, same UX). Alternative = render
> each chunk as a standalone element (fully flat, no assistant-bubble wrapper).
> I'm proceeding with the default; say the word to go fully flat (smaller view
> change, different look).

### Eviction (`evictChunks`, replaces `evictMessages`)

```
limit = appSettings.chunkLimit; if !finite or ≤0 → return
if scrolledUp and !force → return                       // unchanged suppression
total = chunks.length + liveFlat.length
while total > limit:
    if chunks.length > 0 and chunks[0] is not the open chunk:
        drop chunks[0]; total--                          // evict sealed front first
    else if liveRender has a non-open leading chunk:
        drop oldest liveRender chunk; recompute liveFlat; total = chunks.length+liveFlat.length
    else break                                           // only the open chunk remains
oldestLoadedSeq = min seq remaining in chunks (or unchanged if chunks emptied)
```

This trims a huge **old** turn chunk-by-chunk (the fix) and even trims within a
huge **live** turn (bounding memory mid-stream), never evicting the open chunk.
Triggered on each content event (chunk completion) and after load/reconcile.

### Pagination (`loadOlderChunks`, replaces `loadMoreMessages`)

```
if oldestLoadedSeq == null or ≤ 0 → nothing older
GET /tabs/:id/chunks?limit=50&before=oldestLoadedSeq
merge rows into `chunks`, DEDUPE BY seq, keep seq-sorted
oldestLoadedSeq = min seq held; totalChunks = resp.total
```

The old `turnId`-merge hack (`tabs.svelte.ts:440-462`) is **deleted** — raw rows
in one seq-sorted array make `groupRowsToMessages` rejoin a boundary-split turn
automatically. Overlap is fine; dedupe-by-seq is trivial.

### Turn-completion reconcile (the one new flow) — on running→idle for the tab

```
refetch GET /tabs/:id/chunks?limit=chunkLimit         // tail, real seqs (write already landed)
drop all live entries (liveRender=[], liveTurnId=null) and provisional user row
merge refetched rows into `chunks`, dedupe by seq, seq-sort
oldestLoadedSeq = min seq; evictChunks()
if scrolledUp: defer this refetch until the user returns to bottom
```

This single mechanism (a) gives the just-completed turn **real seqs** (so the
log never accumulates seq-less middles that break pagination), and (b) **recovers
any live chunks roll-evicted mid-stream** — they come back from the DB now that
the write landed. Exactly the "delay the reload until the write lands" model.
Keying render groups by `turnId` makes the swap from live→sealed flicker-free.

---

## Backend changes (additive, cache-neutral, low-cost)

1. **`routes/tabs.ts`** — add `GET /tabs/:id/chunks?limit&before` →
   `{ chunks: ChunkRow[], total, oldestSeq }` (raw rows; no grouping). Leave
   `/messages` as-is (unused by the new frontend; harmless).
2. **`db/chunks.ts`** — wrap the `appendChunks` insert loop in a single
   `db.transaction(...)` (one fsync per turn instead of N). Pure perf; no behavior
   change.
3. **`types/index.ts` + `agent-manager.ts`** — add a tiny
   `{ type:"turn-start"; turnId; assistantId }` event, emitted at turn start
   (`agent-manager.ts:1120-1122`). Optional but recommended (stable keys → no
   seal remount). `appendEventToChunks` lists it in its no-op branch for
   exhaustiveness.
4. **WS:** nothing — `index.ts:25-26` forwards all emitted events to the browser.

No change to persistence *timing*, `explodeTurn`, the agent wire, or the caching
path. (Optional future optimization, not in this plan: a `chunk-rows` push at
seal to avoid the per-turn reconcile GET. The reconcile-refetch is simpler and
matches the agreed "reload" model, so we ship that.)

---

## Test plan

Rewrite frontend tests from `tab.messages` assertions to **chunk-log** assertions
(the store no longer has `messages`). Cover:

- **Rolling eviction (headline):** stream a turn of `chunkLimit + N` chunks;
  assert in-memory `log` length stays `≤ chunkLimit` (open chunk exempt) and the
  oldest entries are dropped — including dropping the *leading chunks of a single
  giant turn* (the exact case the limitation was about).
- **Pagination + dedupe:** `loadOlderChunks` prepends older rows, dedupes by seq,
  updates `oldestLoadedSeq`; a turn split at the window boundary renders as one
  group (no merge hack, no duplication).
- **Turn-completion reconcile:** stream a turn (live, seq=null) → running→idle →
  assert live entries are replaced by real-seq rows from the refetch, `log`
  content identical, render-group identity stable (no remount), and a mid-stream-
  evicted chunk is recovered.
- **Deferred reload while scrolled up:** reconcile is deferred until return-to-
  bottom; nothing yanks the viewport.
- **Streaming fidelity:** the existing delta→chunk behaviors (coalescing,
  thinking metadata seal, tool-result fill, shell-output) still hold on
  `liveRender` (these reuse `appendEventToChunks`, so port the assertions to read
  the live flat view).
- **Cache untouched:** the 3-step byte-identical cache-stability test in
  `packages/core/tests/agent/agent.test.ts` passes unchanged; `routes.test.ts`
  gains `/chunks` coverage.

## Phasing (each phase: `bun run check` + `bun run test` green)

- **P1 — Backend additive:** `GET /chunks` raw endpoint; wrap `appendChunks` in a
  transaction; add `turn-start`. Tests for endpoint + event. (Cache test must
  still pass byte-for-byte.)
- **P2 — Frontend store core:** introduce `chunks`/`liveRender`/`liveTurnId`;
  retarget every streaming handler from `messages` to `liveRender`; build the
  derived `log` + render groups; delete the `messages` field. Port streaming
  tests.
- **P3 — Eviction + pagination + reconcile:** `evictChunks`, `loadOlderChunks`
  (delete turnId-merge), running→idle reconcile-refetch, load paths
  (`hydrateFromBackend`/`openAgentTab`/`reloadTabMessagesFromApi`) switched to
  `GET /chunks`. New tests.
- **P4 — Cleanup:** delete dead code (`oldestSeqOf` if unused, old eviction
  comment, `loadMoreMessages` name), update `eviction-limitation.md` →
  resolved, full `bun run test` + `bun run check`.

## Risks / open items

- **Rendering decision** (above) — the one thing to confirm; proceeding with
  render-time grouping (preserves UX).
- **Interrupt turns at reconcile.** The live UI shows an interrupt as a split
  (`message-consumed` handler); the persisted turn keeps the interrupt inside a
  tool result (cache-safe, prior decision). So at reconcile the bubble re-renders
  to the persisted shape. Cosmetic; documented; not fixed (fixing touches the
  wire/cache).
- **shell-output live placement.** `appendEventToChunks` attaches live shell
  output to the running tool call; `explodeTurn` places it on the `tool_result`
  row. The live flat view and the post-reconcile rows therefore differ only in
  where shellOutput hangs until seal — render reads it from the paired call/result
  either way. Minor; assert in a test.
- **Scrolled-up during reconcile** — deferred (handled above); verify no viewport
  jump using ChatPanel's existing scroll-anchor logic.
- **Renames ripple:** `totalMessages→totalChunks`, `currentAssistantId→
  liveAssistantId`, `evictMessages→evictChunks`, `loadMoreMessages→
  loadOlderChunks` touch a few call sites + tests.
