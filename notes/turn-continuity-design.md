# Turn continuity — detached turns + multi-client live view

> Status: DESIGN (locked) → backend implementation in progress. FE work couriered
> to `../frontend`. See ORCHESTRATOR §7 (cross-repo).

## Problem (confirmed by code trace)

A chat turn's lifetime is bound to the **WebSocket connection**. `transport-ws`
creates one `AbortController` per connection (`extension.ts:142`), passes its signal
into the turn (`extension.ts:121` → `orchestrator.handleMessage` → `runTurn`), and
**aborts it on socket close** (`extension.ts:279`). When a mobile browser
backgrounds / reloads, the socket closes → the signal fires → `runTurn` breaks at
the next step/stream boundary (`kernel/run-turn.ts:490,529`) with
`finishReason:"aborted"`, returns the partial result, and the orchestrator persists
that partial turn (`orchestrator.ts:198`). Symptom: refresh shows "a bit more"
(the persisted partial), generation is stopped, user must send "continue".

This violates the product principle: **the frontend is only a control interface;
the AI must keep running independent of it.**

## Principle / requirements

1. A turn, once started, **runs to completion regardless of any connection** —
   including zero connected clients.
2. **Multiple clients may view the same conversation simultaneously** (multi-device
   handoff). All subscribers receive the same live event stream.
3. A client that connects/reloads **mid-turn** can attach and see the in-flight turn
   (late-join), then watch it finish live.
4. **Concurrent SENDS are out of scope** (user will not send from two devices at
   once) — no send arbitration / locking beyond the existing single-flight guard.

## Decisions (locked)

- **D1 — The turn-broadcast hub lives in the CORE (`session-orchestrator`), not in a
  transport.** "Independent of the interface" means turn ownership must not sit in
  any transport. Transports become thin subscribers. (Rejected: hub in transport-ws
  — would re-couple turns to the WS layer and exclude other transports.)
- **D2 — Additive handle (small blast radius).** Keep `handleMessage` (HTTP/CLI one
  shot) working; ADD a detached broadcast API to the same `SessionOrchestrator`
  interface. `handleMessage` becomes a thin convenience over it.
- **D3 — Persist at turn-seal (unchanged); incremental per-step persistence (R1,
  `restructure-plan.md:712`) is DEFERRED.** Late-join is served by an in-memory
  **in-flight buffer**, not by partial DB reads. The in-flight turn lives entirely
  in the buffer until seal; sealed turns live entirely in history → a clean disjoint
  boundary, no seq-overlap, no double-apply. (Cost: a backend *crash* mid-turn still
  loses the in-flight turn — the pre-existing R1 gap, separately deferred.)
- **D4 — Drop caller-driven turn cancellation.** The per-connection AbortController
  no longer touches turns. There is no caller `signal` on the turn path. A future
  explicit "stop generating" is a deliberate `chat.stop` op, not a disconnect — out
  of scope now.
- **D5 — Subscription is decoupled from sending.** A client can watch a conversation
  it did not send to, via a new `chat.subscribe` WS op.

## Target contract — `SessionOrchestrator` (owned by session-orchestrator)

```ts
interface StartTurnInput { conversationId: string; text: string; modelName?: string; cwd?: string; }
type StartTurnResult = { started: true; turnId: string } | { started: false; reason: "already-active" };
type TurnEventListener = (event: AgentEvent) => void;

interface SessionOrchestrator {
  /** Start a turn DETACHED from any caller/connection. Runs to completion regardless
   *  of subscribers (incl. zero). Broadcasts every AgentEvent to all current + future
   *  subscribers (buffered for late-join). Rejected ("already-active") if a turn is
   *  already in-flight for the conversation (single-flight; no send arbitration). */
  startTurn(input: StartTurnInput): StartTurnResult;

  /** Subscribe to a conversation's turn events. On subscribe, the current in-flight
   *  turn's events SO FAR are replayed to `listener` synchronously (late-joiner sees
   *  the whole running turn), then live events follow. Returns unsubscribe. Does NOT
   *  start or affect a turn. Replay-then-attach must be atomic (no gap/dup): snapshot
   *  buffer → deliver → add listener, all synchronously (safe in single-threaded JS;
   *  emits only occur at turn await-points). */
  subscribe(conversationId: string, listener: TurnEventListener): () => void;

  /** Whether a turn is currently in-flight for the conversation. */
  isActive(conversationId: string): boolean;

  /** Convenience one-shot (HTTP/CLI): subscribe + startTurn + await terminal, via
   *  onEvent. Same observable behavior as before for a single caller. NO `signal`. */
  handleMessage(input: {
    conversationId: string; text: string;
    onEvent: (event: AgentEvent) => void; modelName?: string; cwd?: string;
  }): Promise<void>;
}
```

**Hub internals (session-orchestrator) — subscribers OUTLIVE turns.** This is the
load-bearing invariant: a client subscribes to a CONVERSATION (and watches every
turn on it), NOT to a single turn. So the subscriber set must be **persistent and
independent of any turn's lifecycle** — the normal flow is `subscribe` (no turn yet)
→ `startTurn`, and the subscriber MUST receive that turn's events.

Keep TWO separate maps:
- `subscribers: Map<conversationId, Set<TurnEventListener>>` — persistent. `subscribe`
  adds to it (creating the set if absent) and returns an unsubscribe that removes from
  it. NEVER cleared by turn start/seal. A conversation may have subscribers with no
  active turn (idle, waiting) — that's normal.
- `activeTurns: Map<conversationId, { buffer: AgentEvent[]; turnId }>` — per in-flight
  turn only. Created by `startTurn`, deleted on seal. The buffer is ONLY for late-join
  replay. `isActive` = this map has the conversation.

`startTurn` runs the existing pipeline detached (async IIFE); each emitted event is
appended to the active turn's `buffer` AND broadcast to **`subscribers.get(cid)`**
(the persistent set — do NOT reset/replace it). On terminal (`turn-sealed`, or error)
persist as today, then in a `finally` delete the `activeTurns` entry + the
`activeConversations` entry — but LEAVE `subscribers` intact.

`subscribe(cid, listener)`: add `listener` to `subscribers.get(cid)` (create set if
needed); THEN, if a turn is active, synchronously replay its `buffer` to `listener`
(snapshot → deliver → it is already in the live set, so no further attach needed; take
care not to double-deliver — add to the set first, then replay the buffer snapshot
taken at that instant, OR replay then add, but pick one ordering and prove no gap/dup).
If no turn is active, just retain the listener for the next turn.

Keep `activeConversations` (warm service depends on it) = the set with a live
`activeTurns` entry. `handleMessage` rejection (already-active) must emit an error
event to its own `onEvent` and resolve (never await another turn).

> **Wave-1 bug fixed in revision:** the first implementation stored listeners INSIDE
> the per-turn hub and had `startTurn` create a fresh empty-listener hub, so a listener
> that subscribed before the turn (the normal path) was discarded — live multi-client
> test received zero deltas though the turn ran + persisted. The two-map model above is
> the fix.

## WS protocol additions (`@dispatch/transport-contract`, orchestrator-authored)

Additive to `WsClientMessage`:
- `ChatSubscribeMessage   { type: "chat.subscribe";   conversationId: string }`
- `ChatUnsubscribeMessage { type: "chat.unsubscribe"; conversationId: string }`

No new server message: replayed + live events both arrive as the existing
`chat.delta { event: AgentEvent }`. A client infers "running" from a replayed
`turn-start` with no matching `done`/`turn-sealed` yet. `chat.send` continues to
start a turn; the sending socket is auto-subscribed by transport-ws.

## Units & waves

- **Contracts (orchestrator):** transport-contract WS ops + version bump.
- **Wave 1 — `session-orchestrator`:** the hub + new interface methods + buffer;
  refactor `handleMessage` to the convenience wrapper; keep persist-at-seal, metrics,
  lifecycle hooks (`turnStarted`/`turnSettled`/`warmCompleted`), `activeConversations`.
- **Wave 2 (parallel, disjoint pkgs) — depends on Wave 1's handle:**
  - `transport-ws`: per-connection set of subscribed conversations (store each
    `unsubscribe` fn); `chat.send` → auto-subscribe sender + `startTurn`;
    `chat.subscribe`/`chat.unsubscribe` → orchestrator.subscribe/unsubscribe;
    `close` → call all stored unsubscribes, **do NOT abort any turn** (remove the
    turn AbortController); route the new ops in pure `router.ts`.
  - `transport-http`: runtime UNCHANGED (still uses `handleMessage`); only update its
    test fakes to implement the 3 new `SessionOrchestrator` methods.
- **host-bin:** expected UNCHANGED (orchestrator factory + service wiring unchanged);
  verify post-wave.

## Out of scope (explicit)

- Per-step incremental persistence (R1) / crash-resume mid-generation.
- Concurrent-send arbitration / multi-writer locking.
- Explicit "stop generating" op.
- Frontend changes (couriered): on (re)connect, `chat.subscribe` each open
  conversation + re-sync history; render a real "running" state; recover a missed
  `turn-sealed`.
