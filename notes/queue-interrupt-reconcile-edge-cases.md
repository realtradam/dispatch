# The Queue / Interrupt / Reconcile Path Is an Edge-Case Magnet

> Status: living document. Started after the chunk-native frontend rewrite, when
> three consecutive independent code-review passes each surfaced a *new* Blocker
> in the same ~40 lines of code. This note explains **why** that area is fragile,
> catalogs the bugs found so far, states the invariants that must hold, and
> records the recommended longer-term fix so the next person doesn't relearn it
> the hard way.

## TL;DR

The frontend turn-completion reconcile (`reconcileSealedTurn` →
`reloadChunksFromApi`) decides which transient `live` rows to **keep** vs **drop**
when a turn's durable chunks arrive. It makes that decision from a tangle of
loosely-coupled signals — `turnId` present/absent, the `queued-` id prefix,
`queuedMessages` membership, `liveTurnId`, scroll state — that are mutated by
**six** asynchronous events arriving in non-deterministic order, sometimes from
**other clients**. Every signal is a *proxy* for the real question ("is this row
already durable in `chunks`?"), and every bug so far has been a case where the
proxy disagreed with reality. The result: either a row is **lost** (dropped but
not yet sealed) or **duplicated/lingers** (kept but already sealed).

**If you touch this code, re-read "Invariants" and "Why it keeps breaking" below,
and add a test for the exact interleaving you're changing.**

---

## The moving parts

### State (per tab, frontend store `tabs.svelte.ts`)
- `tab.chunks: ChunkRow[]` — SEALED, durable history (real DB `seq`). Source of truth.
- `tab.live: ChatMessage[]` — TRANSIENT buffer for the in-flight turn + optimistic
  / queued user rows not yet folded into `chunks`.
- `tab.renderGroups` — DERIVED: `groupRowsToMessages(chunks) ++ live`. What the UI shows.
- `tab.queuedMessages: QueuedMessage[]` — messages the user sent while the agent was
  busy, awaiting consumption.
- `tab.liveTurnId` / `tab.currentAssistantId` — the in-flight turn + its streaming row.
- per-row `turnId` — set once the row is bound to a concrete turn; `undefined` while
  still optimistic/pending.
- per-row id convention — a still-pending queued row has id `queued-<queueId>`.

### Events (arrive over WS, order NOT guaranteed relative to each other)
- `turn-start { turnId }` — fired **once per user-initiated `processMessage`**
  (`agent-manager.ts`), which persists **exactly one** user chunk row
  (`explodeUserText`). **A queued message NEVER gets its own `turn-start`.**
- `text-delta` / tool events — stream content into the live assistant row.
- `message-queued { messageId }` — a send was queued (this client or another).
- `message-consumed { messageIds }` — the agent drained queued message(s) **into the
  running turn**: either injected as a `[USER INTERRUPT]` block inside a tool result,
  or appended as trailing history (`agent.ts` — the two `dequeueMessages()` sites).
- `status { idle | running | error }` — note: `idle` fires **before** the DB write.
- `turn-sealed { turnId }` — fired **after** `flushAssistant` (the durable write).
  This is the only safe trigger for reconcile.

### The reconcile decision (`reloadChunksFromApi`)
On `turn-sealed` (deferred while the user is scrolled up, via `pendingReconcileTabs`),
refetch the chunk window and recompute `live` as `keptLive`:

```
keptLive = live.filter(m =>
  (preserveTurnId !== null && m.turnId === preserveTurnId) // a NEWER in-flight turn
  || (m.turnId === undefined && m.role === "user")         // optimistic/queued, not yet sealed
)
```

Everything else is assumed already-durable in `chunks` and dropped.

---

## Why it keeps breaking

The reconcile filter answers **"is this live row already in the sealed chunks?"**
but it has no direct way to know. It infers the answer from `turnId` and the
`queued-` prefix. That inference is correct **only if tagging is perfectly
exhaustive and perfectly conservative**:

- **Exhaustive:** every row that *is* (or will be) sealed into a turn's chunks must
  carry that `turnId` *before the turn seals*. Miss one → it stays "untagged" → kept
  → **duplicate** (it's also in `chunks`), and it lingers forever because nothing
  ever tags it later.
- **Conservative:** every row that is *not* part of any sealed turn (a pending queued
  message, an optimistic initiator before `turn-start`) must stay untagged. Over-tag
  one → it looks sealed → dropped → **the user's message vanishes**.

Both failure modes hinge on the *same* `turnId`-presence bit, pulled in opposite
directions, mutated by events whose ordering we don't control. That is the whole
problem in one sentence. Add multi-client (events for turns this client never
initiated) and deferred reconcile (state mutates *while* a reconcile is pending),
and the interleaving space explodes.

---

## Catalog of bugs found (one per review pass, same ~40 lines)

| # | Pass | Failure mode | Root cause | Fix |
|---|------|--------------|-----------|-----|
| A | 1 | A newer, still-streaming turn got **wiped** when an earlier turn's deferred reconcile flushed. | reconcile blindly cleared the whole live tail. | `preserveTurnId`: keep rows whose `turnId === liveTurnId` when `liveTurnId !== sealedTurnId`. |
| B | 1 | Optimistic **queued** user bubble **dropped** on reconcile. | filter didn't keep untagged user rows. | keep `turnId === undefined && role === "user"`. |
| C | 2 | `turn-start` backfill **over-tagged** trailing `queued-` rows with the new turnId → **wiped** on seal. | backfill tagged *every* trailing untagged user row. | skip `queued-` rows; tag only the single most-recent non-queued initiator; then `break`. |
| D | 3 | **Consumed** interrupt bubble **lingered forever** + **duplicated** the `[USER INTERRUPT]` text in the sealed tool result. | `message-consumed` stripped the `queued-` prefix to a *plain untagged* row, which rule B then preserved on every reconcile. | bind the consumed row to `liveTurnId` so reconcile drops it (collapse to persisted shape). |

Notice the chain reaction: the **rule B fix** ("keep untagged user rows") is the
hinge that **both C and D** then bent. C was about *creating* wrongly-tagged rows;
D was about *failing to tag* rows that should have been. Each fix narrowed the
definition of "untagged ⇒ keep" without ever making it airtight.

---

## Invariants (the contract reconcile depends on)

1. **No loss.** A live row that is not yet represented in `chunks` must survive
   reconcile. (Pending queued messages, optimistic initiators pre-`turn-start`.)
2. **No duplicate / no linger.** A live row whose content has been sealed into
   `chunks` (as a user row OR folded into a tool result) must be dropped on the
   sealing turn's reconcile.
3. **Newer turn preserved.** A turn that started streaming *after* the one being
   reconciled must not be touched; only the sealed turn folds into `chunks`.
4. **Idempotent + deferral-safe.** Reconcile may run late (after the user scrolls
   back to the bottom) and may be preceded by arbitrary further events. Re-running it
   must not violate 1–3. Key reconcile off `turn-sealed` (post-write), never `status:idle`.

Corollaries that are easy to forget:
- A consumed/interrupt message is sealed **inside a tool result**, not as its own
  user chunk row — yet its optimistic bubble must still be dropped (invariant 2).
- A freshly-created tab defaults to `agentStatus: "running"`, so the *first* user
  send may be treated as queued unless the tab is known-idle.

---

## Recommended longer-term fix (not yet done)

Stop inferring "is this sealed?" from `turnId` presence. Make preservation key off
**explicit, positive membership** instead of the absence of a tag:

> Keep a live row iff it belongs to a turn we are explicitly preserving
> (`turnId === preserveTurnId`) **or** it is still a *pending* queued message
> (its `queueId` is still in `tab.queuedMessages`). Drop everything else.

This flips the dangerous default. Today "untagged ⇒ keep" means *any* tagging gap
causes a linger/dup (bugs C/D class). With membership-based keep, an untagged row
that is *not* a pending queued message is dropped — which is correct, because the
only rows that should outlive a reconcile are (a) the explicitly-preserved newer
turn and (b) genuinely-pending queue entries, both of which have positive signals.
It also makes the `turn-start` backfill purely cosmetic (stable render keys), so a
tagging miss there can no longer lose or duplicate data.

Until that refactor lands, treat this path as **high-touch**: any change needs a
targeted interleaving test.

---

## Testing guidance

Property/interleaving coverage beats one-off scenario tests here. Suggested:
- A randomized sequence generator over `{turn-start, text-delta, message-queued,
  message-consumed, status, turn-sealed, scrollUp/Down}` with multiple concurrent
  turns and a simulated second client, asserting invariants 1–3 after every
  `turn-sealed` + final state.
- Scenario tests that already exist in `packages/frontend/tests/chat-store.test.ts`
  and should stay green (named for the bugs above):
  - deferred reconcile preserves a concurrent newer turn (A)
  - optimistic queued user message survives an earlier turn's reconcile (B)
  - `turn-start` backfill skips a pending queued row, tags only the initiator (C)
  - a consumed interrupt message collapses into the sealed turn — no lingering bubble (D)
- Always assert **both** directions: the kept row is still present (no loss) AND the
  sealed rows are not duplicated (no linger).

## Pointers

- Frontend store: `packages/frontend/src/lib/tabs.svelte.ts`
  (`reloadChunksFromApi`, `reconcileSealedTurn`, `handleEvent` cases
  `turn-start` / `turn-sealed` / `message-queued` / `message-consumed` / `status`,
  `setScrolledUp`, `pendingReconcileTabs`).
- Render keying: `packages/frontend/src/lib/components/ChatPanel.svelte`
  (`${turnId}:${role}:${n}`).
- Backend event emission: `packages/api/src/agent-manager.ts` (`processMessage`,
  `dequeueMessages`, `turn-start` / `turn-sealed`); `packages/core/src/agent/agent.ts`
  (the two `dequeueMessages()` consumption sites).
- Review records: `notes/gemini-chunk-eviction-review.md` (Pass 1, bugs A+B),
  `notes/gemini-chunk-eviction-review-2.md` (Pass 2, bug C),
  `notes/gemini-chunk-eviction-review-3.md` (Pass 3, bug D).
</content>
</invoke>
