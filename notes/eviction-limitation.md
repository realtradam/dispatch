# Known Limitation: Frontend eviction is whole-message, not per-chunk

Status: **RESOLVED.** Fixed by the chunk-native frontend store (see
`plan-chunk-eviction.md`). The frontend's source of truth for history is now a
flat `ChunkRow[]` (`tab.chunks`, real per-tab `seq`); the live turn is a
transient tail (`tab.live`) reconciled into the sealed log on a `turn-sealed`
event. Eviction (`evictChunks`) is a rolling per-chunk trim of the oldest rows —
so a single oversized turn is trimmed chunk-by-chunk instead of pinned whole.
Pagination loads raw chunks (`GET /tabs/:id/chunks`), deduped by `seq`. The
historical analysis below is retained for context.

---

Documented from the append-only chunk-log work (see `plan-chunk-log.md`). The
backend was not the problem — this was purely a frontend in-memory concern.

## TL;DR

The append-only chunk log made **loading** per-chunk (you fetch the last N
*chunks*, not N whole turns), but the frontend's in-memory **eviction** still
drops whole *messages* (turns). A single pathological turn (e.g. the 150-tool-call
incident — one assistant message holding ~150 chunks) therefore stays resident in
browser memory in full until it scrolls out of the protected window. On a
memory-constrained device, one giant turn can still blow the budget.

So: the chunk log helps long *histories* (many normal turns), but does **not**
yet help a single oversized *turn*.

## What "eviction" is (for the record)

`evictMessages` (`packages/frontend/src/lib/tabs.svelte.ts:345`) trims a tab's
in-memory `messages` array when its total chunk count exceeds
`tab.chunkLimit`, to bound browser RAM. It never deletes anything from the DB —
the `chunks` table is the durable source of truth and evicted content is
re-fetched on scroll-up via `loadMoreMessages`
(`tabs.svelte.ts:402`). The active/streaming turn and the last user+assistant
pair are pinned; eviction is suppressed while the user is scrolled up.

## Root cause

Eviction operates at message granularity and explicitly refuses to trim within a
message. From `tabs.svelte.ts` (the `evictMessages` comment, ~`:360-372`):

> We never trim chunks from WITHIN a message: messages are the
> persistence/pagination unit ... Whole-message eviction from the front is the
> correct granularity.

That comment is now stale in spirit: persistence/pagination is per-**chunk**
(the flat `chunks` table + `GET /messages` windowing by chunk `seq`), but the
in-memory store still holds **grouped `ChatMessage[]`** as its source of truth,
so the smallest evictable unit is a whole turn.

```
DB / wire:      per-chunk  ✅  (chunks table, chunk-seq pagination)
Frontend load:  per-chunk  ✅  (GET /messages?limit=N windows the chunk log)
Frontend evict: per-MESSAGE ❌ (tab.messages is grouped; a turn is atomic)
```

## Why it wasn't fixed in this pass

True per-chunk eviction requires the frontend store's **source of truth to be the
flat chunk list**, with `messages` derived for rendering (this was P5 in
`plan-chunk-log.md`). That means:

- store `tab.chunks: ChunkRow[]` (+ the in-flight live turn) instead of
  `tab.messages: ChatMessage[]`;
- rewrite every streaming handler (`applyChunkEvent`, `routeSystemEvent`, the
  `done` / `status` / `statuses` / error paths) to mutate the flat list;
- derive `messages` via `groupRowsToMessages` for the render layer.

That touches ~10 handler sites in `tabs.svelte.ts` and the ~60 frontend tests in
`chat-store.test.ts`, all of which currently assert against the grouped
`tab.messages` model. It was deferred to keep the test suite green and the
diff bounded. The hard part (flat storage + DB-free `explode`/`group` transforms
in `packages/core/src/chunks/transform.ts`) is already done and reusable.

## Fix options (later)

1. **Flat-chunk store + derived messages (recommended, the "proper" fix).**
   Make `tab.chunks: ChunkRow[]` the source of truth; derive `messages` with
   `groupRowsToMessages` (already shared from
   `@dispatch/core/src/chunks/transform.js`). Eviction then trims the flat array
   at chunk granularity; pin the in-flight turn + the tail. Re-fetch on
   scroll-up by chunk `seq` (already supported). Highest effort (handler +
   test rewrite), but fully solves it and matches `plan-chunk-log.md` P5.

2. **Partial trim of an oversized message (incremental, lower effort).**
   Keep the grouped model, but when the *oldest* in-memory message alone exceeds
   the limit, drop its leading chunks (whole `text`/`thinking`/`tool-batch`
   units) and record a per-message `oldestChunkSeq` so `loadMoreMessages` can
   re-hydrate it. Caveat: must keep the message renderable and merge correctly on
   scroll-up (the `turnId` merge in `loadMoreMessages` already handles the
   boundary case). A pragmatic stopgap.

3. **Render virtualization (separate concern).**
   Windowing the *DOM* (only mount visible bubbles) reduces render cost but not
   the JS-heap cost of holding the chunks. Complementary to 1/2, not a
   substitute.

## Acceptance check for whichever fix

Load a tab whose history contains one turn with ≫ `chunkLimit` chunks; confirm
in-memory chunk count stays ≤ `chunkLimit` (± the pinned tail) while scrolled to
the bottom, and that scrolling up re-hydrates the trimmed chunks of that same
turn without duplication.
