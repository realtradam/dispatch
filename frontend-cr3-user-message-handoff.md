# FE handoff — CR-3 fixed: user prompt is now on the turn's event stream

Courier to `../frontend`. This resolves CR-3 from `backend-handoff.md` ("a watcher can't see
the turn's USER prompt until seal"). **Option B implemented + live-verified.** Your staged-but-inert
consumption can now be turned on.

## What shipped (backend)

A new **additive** `AgentEvent` variant carries the user prompt INTO the turn's outward stream:

```ts
// @dispatch/wire — added to the AgentEvent union
interface TurnInputEvent {
  type: "user-message";
  conversationId: string;
  turnId: string;
  text: string;          // the raw prompt, exactly as sent
}
```

`session-orchestrator` emits it via the broadcast/buffer path as the **FIRST event of every turn**
(before `turn-start`), so it is replayed to every subscriber — live AND late-join — and arrives on
the HTTP/NDJSON path too. Persistence is unchanged (the user message is still appended atomically at
seal); this only adds a buffered/broadcast event. Metrics are unaffected (it is not usage).

## Version bumps (re-pin both)

- `@dispatch/wire` **`0.5.0 → 0.6.0`** (additive union member).
- `@dispatch/transport-contract` **`0.7.0 → 0.8.0`** (re-exports `AgentEvent`/`chat.delta`, which now
  carries `user-message`; no other transport-contract change).

Re-mirror `.dispatch/{wire,transport-contract}.reference.md` and add `user-message` to the FE
exhaustiveness guard.

## FE action

Flip on the already-staged `core/chunks` branch that folds a `user-message` event into a provisional
user chunk for watchers, with your text dedup against the sender's optimistic echo. After re-pin:
- a **pure watcher** (second device / `chat.subscribe` only) now shows the user bubble the moment the
  turn starts, not at seal;
- the **sender** is unchanged (its optimistic echo dedups against the replayed `user-message`);
- a **late-joiner** gets `user-message` first in the replay, then the rest of the in-flight turn.

## Live-verified (backend, vs flash)

Two WS clients on one conversation; client B subscribed but never sent. On A's `chat.send`, B received
`chat.delta { event:{ type:"user-message", text:"…", turnId, conversationId } }` as its **first** delta
(index 0), **before** `turn-sealed`, with `text` equal to A's prompt, then the streaming reply. `RESULT: OK`.

## Note

The ordering guarantee is: `user-message` is the first event of the turn, immediately followed by
`turn-start`, then the usual deltas → `done` → `turn-sealed`. Treat `user-message` as turn-scoped
(it carries `turnId`) so a multi-turn transcript attributes each prompt to its turn.
