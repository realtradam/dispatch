# FE handoff — cancel a queued message

Courier this to `../frontend` (cross-repo contract change; `lsp references` does
not span repos — ORCHESTRATOR §7). All changes are ADDITIVE — nothing existing
breaks.

## What shipped (backend)

A per-message **cancel** for the steering message queue: while a turn is
GENERATING and a user message is sitting in the queue (waiting to be delivered
as steering at the next tool-result boundary, or carried into a new turn), the
client can **cancel a single queued message by id** so it never runs. The
message is removed from the queue and is never delivered as steering and never
carried into a new turn.

This complements the existing `chat.queue` enqueue (see
`frontend-message-queue-handoff.md`). Enqueue adds; cancel removes one.

Versions: `@dispatch/transport-contract` `0.23.0 → 0.24.0`. Bump the pinned
`file:` dep. (`@dispatch/wire` is unchanged — `QueuedMessage` already has the
`id` the cancel targets; no new wire type was needed.)

## The two entry points (pick one — same backend behavior)

### 1. WebSocket op: `chat.queue.cancel` (what the FE should use)

```ts
interface ChatQueueCancelMessage {
  readonly type: "chat.queue.cancel";
  readonly conversationId: string;
  readonly messageId: string; // the stable QueuedMessage.id (from the queue surface / enqueue response)
}
```
(additive to `WsClientMessage`.)

- **Fire-and-forget**, exactly like `chat.queue`. On success the server emits
  NOTHING back — the `message-queue` SURFACE updates (the cancelled message
  leaves the `payload.messages` snapshot). On failure (missing/empty
  `conversationId` or `messageId`) the server replies `chat.error`
  (`{ type: "chat.error"; conversationId?; message }`).
- **Idempotent:** cancelling a message that is no longer queued (already
  drained/delivered as steering, or already cancelled, or never existed, or an
  unknown conversation) is a **silent no-op** — no surface update, no error. So
  a client may optimistically remove the row from its queue UI on click and
  fire-and-forget the cancel; if the message was already gone, nothing breaks.
- **`messageId`** is the stable client-visible `QueuedMessage.id` you already
  render from the queue surface snapshot (or got back from `chat.queue` /
  `POST /conversations/:id/queue`'s `queue[]`).

### 2. HTTP path (for the CLI / non-WS clients; the FE uses the WS op above)

`DELETE /conversations/:id/queue/:messageId` (no request body) → `QueueCancelResponse`:

```ts
interface QueueCancelResponse {
  readonly conversationId: string;
  readonly cancelled: boolean;                  // true = a message was found + removed
  readonly queue: readonly QueuedMessage[];     // post-cancel snapshot
}
```
- `cancelled: true` — the message was in the queue and has been removed (it will
  never run).
- `cancelled: false` — the message was NOT in the queue (already
  drained/delivered, never existed, unknown conversation) OR the message-queue
  extension isn't loaded (degraded). Still HTTP **200** (idempotent — not an
  error).
- `queue` is the post-cancel snapshot (empty when no queue extension is loaded).

## How the FE confirms a cancel

The queue is control/state on the **surface** channel (NOT the chat stream), so
cancel is confirmed the same way enqueue is — by the `message-queue` surface
updating:

1. You already **subscribe to the `message-queue` surface** (scope
   `conversation`) and render `payload.messages` (`QueuedMessage[]`) with the
   `rendererId: "message-queue"` custom renderer (per
   `frontend-message-queue-handoff.md`).
2. On cancel, the surface pushes a **full new spec** whose `payload.messages`
   no longer contains the cancelled id. The cancelled message simply leaves the
   queue list — render the new snapshot.
3. **No new `AgentEvent`** is emitted for a cancel. The cancelled message never
   appears in the transcript (it was never delivered as steering — that's the
   point). If a message was already drained (delivered as a `steering` bubble or
   carried into a new turn's `user-message`) before the cancel arrived, the
   cancel is a no-op (`cancelled: false`) and the transcript is unchanged.

## UX suggestion

- Render a **cancel (×) affordance** on each pending row in the queue UI (the
  surface snapshot gives you the `id` to target). On click → send
  `chat.queue.cancel { conversationId, messageId }`.
- Optimistically remove the row from the queue UI on click; the surface update
  will confirm it (or, if the message was already drained, the surface already
  shows it gone — no harm).
- Expect a `chat.error` only for a malformed send (empty `conversationId` /
  `messageId`) — in practice a client that sends the id it just rendered will
  never hit this.

## Race notes (safe by construction)

- **Cancel vs. drain (steering delivery):** if the kernel drains the queue at a
  tool-result boundary in the instant between the user clicking cancel and the
  server processing it, the message is already gone — the cancel returns
  `cancelled: false` (a no-op). The drained message was delivered as a
  `steering` event and is in the transcript; the cancel correctly did nothing.
  No double-delivery, no error.
- **Cancel vs. post-seal carry:** same — if the turn sealed and the queue was
  carried into a new turn before the cancel ran, the message is already the new
  turn's opening `user-message`; the cancel is a no-op.
- **Cancel is scoped per conversation:** cancelling on conversation A never
  touches conversation B's queue.

## What we need the FE to do

1. **Bump pinned dep:** `@dispatch/transport-contract` → `0.24.0`.
2. **Add `chat.queue.cancel`** to the FE's `WsClientMessage` union (it is
   additive — no exhaustive switch breaks; if the FE has one, add the
   `chat.queue.cancel` case to its WS dispatcher).
3. **Cancel affordance per queued row:** a × / cancel button on each pending
   message in the queue UI that sends
   `chat.queue.cancel { conversationId, messageId }` using the row's `id`.
   Optimistically remove the row; reconcile from the surface update.
4. **No new event handling** — the existing `message-queue` surface subscription
   already reflects the post-cancel snapshot; just render it. No `steering` /
   transcript change for a cancelled message (it never runs).

## Notes / known gaps

- **No CLI command.** The CLI's `send --queue` enqueues but there is no CLI
  command to list the queue or obtain a `messageId`, so a CLI `cancel` was not
  added (it would have no way to discover a message id). The HTTP
  `DELETE /conversations/:id/queue/:messageId` is available for any non-WS
  client that already knows the id (e.g. from a prior
  `POST /conversations/:id/queue` response's `queue[]`).
- **Close-with-queued-messages** (the open product question noted in
  `frontend-message-queue-handoff.md`) is unchanged by this feature: an
  explicit `POST /conversations/:id/close` still aborts the in-flight turn and
  the carry still fires. Cancel is a separate, per-message affordance that does
  not touch the turn.
