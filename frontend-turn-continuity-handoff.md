# FE handoff — turn continuity + multi-client live view

Courier to `../dispatch-web` (cross-repo; `lsp references` does not span repos —
ORCHESTRATOR §7). Backend is implemented + live-verified against flash. This unblocks
the "turn keeps running when the browser is backgrounded/reloaded" + "watch the same
chat from a second device" behavior.

## What changed in the backend (principle now enforced)

A turn is **no longer bound to the WebSocket connection**. It runs to completion on the
server regardless of any client, and **any number of connections can watch the same
conversation's live events** — including a client that connects mid-turn (late-join
replay). The old behavior (socket close → `AbortController.abort()` → turn killed) is
gone.

## New WS protocol (additive — `@dispatch/transport-contract` `0.6.0 → 0.7.0`)

Two new client→server messages on the existing socket:

```ts
{ type: "chat.subscribe";   conversationId: string }   // start watching a conversation's turns
{ type: "chat.unsubscribe"; conversationId: string }   // stop watching (does NOT stop the turn)
```

Server→client is UNCHANGED: turn events still arrive as
`{ type: "chat.delta", event: AgentEvent }` (and `{ type: "chat.error", ... }`). Both
replayed and live events use `chat.delta`.

Semantics:
- **`chat.subscribe`** registers this connection to receive the conversation's turn
  events. If a turn is in-flight, the server immediately **replays that turn's events so
  far** (from its `turn-start`) as `chat.delta`, then streams live ones. If idle, nothing
  is replayed (rely on the history read).
- **`chat.send`** still starts a turn AND **auto-subscribes the sending connection** — so
  the sender needs no separate `chat.subscribe`. (If a turn is already generating for that
  conversation, the server replies `chat.error` "a turn is already generating…" and you
  stay subscribed to watch the running one.)
- **`chat.unsubscribe`** / socket close → the server drops this connection's subscription
  but **never stops the turn**.
- Subscriptions **persist across turns** on the backend: subscribe once and you receive
  every subsequent turn on that conversation until you unsubscribe/close.

## What the FE must change (from the FE investigation)

1. **On WS (re)connect — re-subscribe chat, not just surfaces.** Today `onReopen`
   (`src/app/store.svelte.ts`) only re-sends *surface* subscriptions. It must ALSO, for
   every open conversation, send `chat.subscribe { conversationId }`. This is what makes a
   backgrounded/reconnected client re-attach to a still-running turn and resume live
   streaming. (Pair it with a `syncTail()` so any turn that sealed while you were gone is
   committed from history.)
2. **On page load — subscribe each restored tab's conversation** (in addition to the
   existing IndexedDB + `GET /conversations/:id?sinceSeq=` rehydrate). After a reload
   mid-turn you'll get the in-flight turn replayed and can keep rendering it live.
3. **Render a real "running" state.** Derive it from the stream: a `turn-start` (or any
   delta) with no matching `done`/`turn-sealed` yet = generating. Today the Composer status
   is hard-wired idle and the `status` AgentEvent is a no-op reducer — wire it up so a
   watching device shows "generating…".
4. **Don't lose a missed `turn-sealed`.** If you reconnect after the turn sealed while you
   were away, you won't get a live `turn-sealed`; `syncTail()` on (re)connect (point 1)
   commits the finished turn from history. If you reconnect WHILE it's still running, the
   replay + live tail carry you to the real `turn-sealed`.
5. **Multi-device handoff (the goal):** opening the same conversation on device B is just
   `chat.subscribe { conversationId }`. B will see the in-flight turn (replayed) and watch
   it finish — even if device A (the sender) closed. No special handling beyond points 1–3.

## Out of scope (backend will NOT do these yet)

- **Per-step persistence / crash-resume:** if the backend PROCESS crashes mid-turn, the
  in-flight turn is still lost (the in-flight buffer is in-memory; only sealed turns are
  persisted). Reconnecting to a *running* turn works; surviving a *backend crash* mid-turn
  does not. Separate durability milestone (R1).
- **Concurrent-send arbitration:** sending from two devices at once is not handled (by
  product decision — won't happen). A second `chat.send` while generating gets a
  `chat.error`.
- **Explicit "stop generating":** there is no stop op (disconnect no longer stops a turn).
  A future `chat.stop` would be deliberate.

## Quick manual check (mirrors the backend live test)

Open two WS connections, `chat.subscribe` the same `conversationId` on both, `chat.send`
on one → both receive identical `chat.delta` streams. Close the sender mid-turn → the other
keeps receiving through `done`. Connect a third mid-turn + `chat.subscribe` → it receives
`turn-start` replayed then the rest.
