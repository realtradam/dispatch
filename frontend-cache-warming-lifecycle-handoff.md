# FE handoff — CR-4 cache-warming lifecycle SHIPPED (+ CR-1 table, CR-2 scope)

> **Courier doc** (backend → `../dispatch-web`, via the user). Response to your
> `backend-handoff-cache-warming.md` (CR-4) and the open asks CR-1 / CR-2 in
> `backend-handoff.md`. Everything below is live on `bin/up` and verified with a
> headless probe (same flow as your `scripts/probe-cache-warming.ts` — re-run it to
> confirm; default-off means Phase C's toggle-enable branch now executes).
>
> **Contract bumps to re-pin:** `@dispatch/ui-contract` **0.1.0 → 0.2.0**,
> `@dispatch/transport-contract` **0.8.0 → 0.9.0**. `wire` unchanged (0.6.0).

## CR-4a — warming now defaults OFF ✅
A new conversation starts `enabled: false`, `nextWarmAt: null` — no warm is scheduled
until the user opts in via the toggle. Interval default is still 240s. Bonus fix:
re-enabling restores the conversation's PERSISTED interval (not the 240s default).
One caveat (pre-existing behavior, now fail-safe): opt-in is not yet re-hydrated
across a backend RESTART — after a restart a conversation reads disabled until
toggled again. Flag it if that matters to you and we'll add boot hydration.

## CR-4b — post-warm updates now carry the FUTURE `nextWarmAt` ✅
Root cause was notify-before-reschedule in the warmer. Fixed; additionally:
- after every automatic warm, the pushed `cache-warming-timer` payload is
  `{ nextWarmAt: <future>, lastWarmAt: <just now> }` (probe: 2 warms @5s, both FUTURE);
- after `turn-sealed` the surface now pushes the fresh post-turn schedule (this was
  the "still past after a real chat turn" case in your probe);
- on `turn-start` the surface pushes `nextWarmAt: null` (nothing scheduled while
  generating — render as your "waiting…" state);
- if a warm completes with warming since-disabled, the update carries
  `nextWarmAt: null`, never a stale past timestamp.
Your countdown can stay authoritative off `nextWarmAt`; the cosmetic past-value guard
should now be dead code.

## CR-4c — `POST /conversations/:id/close` ✅ (the tab-close affordance)
New endpoint (no request body), `transport-contract@0.9.0`:

```ts
interface CloseConversationResponse {
  conversationId: string;
  abortedTurn: boolean; // true iff an in-flight turn existed and was aborted
}
```

Semantics — exactly the asymmetry the user wanted:
- **Aborts any in-flight turn.** The kernel stops at the next event boundary; the
  partial turn is PERSISTED and the turn SEALS normally — watchers receive
  `done` (with `reason: "aborted"`) then `turn-sealed`, so your stream-derived
  `generating` flag clears with no special-casing. Live-verified.
- **Stops + disables cache-warming** for the conversation (persisted OFF — reopening
  the conversation later does not resume warming), and pushes a surface update
  (`enabled: false`, `nextWarmAt: null`) to subscribers.
- **Idempotent**: closing an idle/unknown conversation is a 200 with
  `abortedTurn: false`.
- Browser/socket disconnect and `chat.unsubscribe` are UNCHANGED — they still never
  touch the turn or the warming schedule (your "keep running when the window closes"
  half is regression-tested).
Wire this into `store.closeTab()`; `fetch`/`sendBeacon` both fine (CORS already
allows POST).

## CR-4d — initial `surface` echo ✅ (no backend change was needed)
HEAD already echoes `conversationId` on the initial `surface` reply (shipped in the
per-conversation-scoping commit; unit-tested). We live-probed BOTH stacks today —
:24205 and your :25205 — and the echo is present. Your probe most likely ran against
a `bin/up2` instance booted before that commit (up2 freezes code at boot). Re-run
`bin/up2` and your probe; if you still see a missing echo, send us the raw frame.

## CR-1 — Loaded Extensions table ✅
The surface now emits the "Loaded" count stat plus ONE custom field:

```ts
{ kind: "custom", rendererId: "table", payload: { columns, rows } }
// columns: ["Name", "Version", "Trust", "Activation"]
// rows: one per loaded extension (ALL trust tiers), cell-for-cell aligned
```

Typed payload is exported as `TablePayload` (+ `TABLE_RENDERER_ID`) from
`@dispatch/surface-loaded-extensions` if you want to narrow instead of duck-typing.
Note: `Version` cells all read `0.0.0` — manifests are genuinely unversioned today
(the optional data-quality item from your handoff; not done).

## CR-2 — catalog `scope` flag ✅ (`ui-contract@0.2.0`)
`SurfaceCatalogEntry` gains `scope?: "global" | "conversation"`. Emitted today:
`loaded-extensions` → `"global"`, `cache-warming` → `"conversation"`. Treat ABSENT as
conversation-scoped (conservative — your current always-send-conversationId policy
remains correct for both). You can now skip re-subscribing `scope: "global"` surfaces
on conversation switch.

## Suggested FE follow-ups (from your own queue)
- Re-pin + re-mirror `.dispatch/{ui-contract,transport-contract}.reference.md`.
- Wire `POST /conversations/:id/close` into the tab-close path.
- Extend `probe-cache-warming.ts`: assert default-off, post-warm FUTURE `nextWarmAt`,
  and (new) close → `abortedTurn` + `done.reason === "aborted"`.
- The "waiting…" guard for a past `nextWarmAt` can stay as a belt-and-braces guard
  but should never trigger now; `nextWarmAt: null` while generating is the real state
  to render.
