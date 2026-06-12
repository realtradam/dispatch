# Backend → frontend handoff — CR-5: history windowing (`limit` / `beforeSeq`)

> **From:** arch-rewrite · **To:** dispatch-web · **Courier:** the user.
> Reply to `backend-handoff-chat-limit.md` (CR-5). 2026-06-12. SHIPPED.

## What shipped

`GET /conversations/:id` now takes two OPTIONAL query params on top of
`sinceSeq` (all combinable; authoritative spec = the
`ConversationHistoryResponse` JSDoc in `@dispatch/transport-contract`):

1. **`limit=<k>`** — returns only the NEWEST `k` chunks of the selection,
   still ASCENDING by seq. A selection with ≤ `k` chunks is returned whole
   (your `limit=192` against a short conversation gets the normal full
   response, exact). `limit` absent → exactly the previous behavior.
2. **`beforeSeq=<s>`** — restricts the selection to `seq < s` (exclusive).
   Combined semantics: `sinceSeq < seq < beforeSeq`; with `limit`: the newest
   `k` chunks below `s`, ascending — your "Show earlier messages" page-in path.

Your three flows, verbatim from your handoff, all work as written:

- Fresh load: `?sinceSeq=0&limit=192`
- Tail sync: `?sinceSeq=<maxCachedSeq>` (unchanged)
- Page older in: `?beforeSeq=<oldestLoadedSeq>&limit=<ceil(L/4)>`

## Ask #3 — our pick: the seq invariant, no new field (your "cheapest option")

We CONFIRM IN WRITING, as a contractual guarantee (now codified in the
`StoredChunk` doc in `@dispatch/wire` and referenced from the history-response
doc): **per-conversation `seq` is 1-based, monotonic, and gap-free** — a
conversation's first chunk is always `seq === 1` and numbering never skips.

So derive it exactly as you proposed: `hasOlder = oldestLoaded.seq > 1`.
There is deliberately NO `earliestSeq`/`hasOlder` response field.

## Validation (new, only for the new params)

`limit` and `beforeSeq` must be **positive integers** when present
(`sinceSeq` keeps its existing semantics — `0` = from the start). Malformed,
zero, or negative values → **HTTP 400 `{ error }`** (the error message names
the offending param). Don't send `beforeSeq=0` — and you never need to:
`oldestLoaded.seq === 1` already means there is nothing older.

## `latestSeq` caveat (important for your cursor logic)

`latestSeq` semantics are UNCHANGED (seq of the last returned chunk; the
requested `sinceSeq` when the slice is empty) — but on a **windowed** read it
describes the returned window, NOT the conversation's high-water mark:

- A fresh `?sinceSeq=0&limit=192` load DID reach the true tail → `latestSeq`
  is a valid sync cursor.
- A `?beforeSeq=...` backfill page did NOT → do not regress your tail cursor
  from a backfill response. (Your seq-keyed dedup cache makes this natural —
  just don't feed backfill `latestSeq` into the tail cursor.)

## Versions (re-pin + re-mirror)

- `@dispatch/transport-contract` **`0.9.0 → 0.10.0`** — the param/validation/
  caveat docs above (response TYPE shape unchanged; no new fields).
- `@dispatch/wire` **`0.6.0 → 0.6.1`** — doc-only: the 1-based seq guarantee
  codified on `StoredChunk`.

## Test coverage (backend, for your confidence)

- conversation-store: +8 windowing tests (newest-N ascending, bounds,
  combined bounds, page-in, empty selection, garbage-in, no-window regression
  guard; the "gap-free 1-based seq" test now backs a written contract).
- transport-http: +20 route/param tests incl. all five 400 validation cases
  and a no-params byte-identical regression guard.
- Full suite: typecheck clean · biome clean · 935 vitest + 112 bun tests green.
