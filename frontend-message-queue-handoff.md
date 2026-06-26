# FE handoff — message queue + steering injection

Courier this to `../frontend` (cross-repo contract change; `lsp references` does
not span repos — ORCHESTRATOR §7). All changes are ADDITIVE — nothing existing breaks.

## What shipped (backend)

A per-conversation **message queue** + **steering** feature. While a turn is
GENERATING, a client can enqueue a user message onto the conversation's queue;
it is delivered mid-turn as **steering** — injected at the next tool-result
boundary so the model sees it alongside the tool results and can adjust course.
If the turn ends with a non-empty queue (no tool call fired), the queue is
carried into a NEW turn as its opening prompt.

- **`message queue`** — the per-conversation buffer (owned by a new
  `@dispatch/message-queue` extension). Transient + in-memory; the queue is
  NOT on the chat stream — it is exposed to the frontend as a per-conversation
  SURFACE (see below).
- **`steering`** — a user message injected into an in-flight turn at the
  tool-result boundary (drawn from the queue). Emitted on the chat stream as a
  new `steering` `AgentEvent` so it appears in the transcript live.

Versions: `@dispatch/wire` `0.7.0 → 0.8.0`, `@dispatch/transport-contract`
`0.11.0 → 0.12.0`. Bump the pinned `file:` deps. (`@dispatch/ui-contract` is
unchanged — the queue uses the existing `custom` surface field kind.)

## Wire types (in `@dispatch/wire`, re-exported by `@dispatch/transport-contract`)

```ts
/** A message held in the conversation's queue, awaiting steering delivery. */
interface QueuedMessage {
	readonly id: string;        // stable, client-visible (UI key + dedup)
	readonly text: string;
	readonly queuedAt: number;  // epoch-ms
}

/** Payload of the message-queue surface's `custom` field (see below). */
interface QueuePayload {
	readonly messages: readonly QueuedMessage[];
}

/** New `AgentEvent` variant (additive to the union). */
interface TurnSteeringEvent {
	readonly type: "steering";
	readonly conversationId: string;
	readonly turnId: string;
	readonly text: string;      // the combined text of all drained messages
}
```

## How the frontend reads queue STATE: a surface (NOT the chat stream)

The queue is control/state, so it rides the **surface** channel (like
cache-warming), not the chat event stream. The `message-queue` extension
contributes a per-conversation surface:

- **Surface id:** `"message-queue"`; **scope:** `"conversation"` (subscribe with
  the `conversationId`).
- **One `custom` field**, `rendererId: "message-queue"`, `payload: QueuePayload`
  (`{ messages: QueuedMessage[] }` — the current queue snapshot).
- The surface updates (full new spec) on every change: enqueue (queue grew) and
  drain (queue emptied). An idle conversation's queue is empty → the field's
  `messages` is `[]`.

So: **subscribe** to the `message-queue` surface per conversation and render
the queue list from `payload.messages`. You need a bespoke renderer for
`rendererId: "message-queue"` (the `custom` escape hatch — see the loaded-
extensions `table` renderer precedent). The surface is **read-only** (no
`invoke` actions); enqueuing is a chat op (below).

## How the frontend ENQUEUES: the `chat.queue` WS op

```ts
interface ChatQueueMessage {
	readonly type: "chat.queue";
	readonly conversationId: string;
	readonly text: string;
}
```
(additive to `WsClientMessage`.)

- **Fire-and-forget.** On success the server emits NOTHING back — the
  `message-queue` SURFACE updates (the new message appears in the snapshot).
  On failure (empty/missing `text`, unknown conversation) the server replies
  `chat.error` (`{ type: "chat.error"; conversationId?; message }`).
- **`text` must be non-empty** after trim (the server 400/errors otherwise).
- **Auto-start when idle (server-owned decision):** if NO turn is active for the
  conversation, `chat.queue` does NOT queue — it STARTS A NEW TURN with the
  message as its opening prompt (equivalent to `chat.send`). The sender is
  auto-subscribed and the turn's events stream as `chat.delta`s (the opening
  `user-message` carries the text). So a single `chat.queue` op works for both
  "steer during generation" and "send" — you don't need to pick. When a turn IS
  active, the message is appended to the queue (surface updates) and delivered
  at the next tool-result boundary.

## How the frontend shows steering in the TRANSCRIPT: the `steering` event

When the kernel drains a non-empty queue at a tool-result boundary, the
session-orchestrator emits a **`steering`** `AgentEvent` on the chat stream
(arrives inside a `chat.delta` `{ event }`, like every other `AgentEvent`):

```ts
{ type: "chat.delta", event: { type: "steering", conversationId, turnId, text } }
```

- Render `text` as a **user bubble in the transcript**, positioned after the
  tool-call/tool-result it followed (it is a user message the model saw mid-turn,
  alongside the tool results). One `steering` event per drain; `text` is the
  combined text of all messages drained at that boundary (joined by a blank
  line).
- **Move, don't duplicate:** the drained messages were already shown in the
  queue surface; when the surface then updates to empty (the drain cleared the
  queue), they should leave the queue UI (they now live in the transcript as the
  `steering` bubble). A simple rule: on `steering`, append the bubble to the
  transcript; the surface's subsequent empty snapshot clears the queue UI.
- **Late-join safe:** like `user-message`, `steering` is buffered into the
  in-flight turn's event buffer, so a client that subscribes mid-turn (or a
  second device) sees it before seal (mirrors the CR-3 `user-message` fix).
  (Carry-to-new-turn, below, does NOT emit `steering` — the new turn's
  `user-message` covers it.)

## Carry to a new turn (no `steering` event)

If a turn ENDS with a non-empty queue (the model finished without making a tool
call, so no tool-result boundary was hit), the orchestrator drains the queue,
combines the messages, and **starts a NEW turn** whose opening prompt is the
combined text. You will see: the old turn's `done` + `turn-sealed`, then a new
`turn-start` + `user-message` carrying the combined text (rendered as the new
turn's normal user bubble). The queue surface also clears (empty snapshot). No
`steering` event in this case — handle the carried text as an ordinary new-turn
user message.

## HTTP path (for the CLI / non-WS clients; the FE uses the WS op above)

`POST /conversations/:id/queue` with body `QueueRequest { text }` → `QueueResponse`:

```ts
interface QueueResponse {
	readonly conversationId: string;
	readonly startedTurn: boolean;                 // true = was idle, a new turn started
	readonly queue: readonly QueuedMessage[];      // snapshot after the enqueue
}
```
- Empty/whitespace `text` → HTTP 400 `{ error }`.
- `startedTurn: true` means no turn was active and the enqueue started one (the
  message is the turn's opening prompt, NOT a queued steering message).
- `startedTurn: false` means a turn was active and the message was queued (the
  `queue` snapshot includes it).

## What we need the FE to do

1. **Bump pinned deps:** `@dispatch/wire` → `0.8.0`, `@dispatch/transport-contract`
   → `0.12.0`.
2. **Queue UI (per conversation):** subscribe to the `message-queue` surface
   (scope `conversation`) and render `payload.messages` (`QueuedMessage[]`) with a
   `rendererId: "message-queue"` custom renderer — a list of pending messages
   with their text (and maybe `queuedAt` as a timestamp). Empty `messages` =
   nothing to show (hide the panel).
3. **Enqueue affordance:** while a turn is generating, show an input that sends
   `chat.queue { conversationId, text }` (NOT `chat.send` — `chat.queue` is the
   steering entry; it auto-starts a turn if idle, so it's safe to offer it
   whenever the user wants to add input). Trim/validate non-empty client-side
   too; expect a `chat.error` on failure.
4. **Steering bubble:** handle the new `steering` `AgentEvent` (type `"steering"`)
   on the `chat.delta` stream → render `event.text` as a user bubble in the
   transcript after the tool calls; clear the queue UI when the surface updates
   to empty.
5. **Carry:** no special handling — a carried queue surfaces as a normal new
   turn (`turn-start` + `user-message`); just let the existing new-turn flow
   render it. The queue surface clears automatically.

## Notes / known gaps

- **Live end-to-end (a real steering turn via a tool-calling model) is not yet
  exercised** — the logic is unit/integration tested and the app boots clean with
  the `message-queue` extension registered, but a live `chat.queue` → tool-call
  → `steering` event flow against a real model has not been run. Worth a live
  smoke once the FE wires it (or ask the backend to run one).
- **Close-with-queued-messages (open product question):** if a client
  `POST /conversations/:id/close` (explicit tab close) while the queue is
  non-empty, the in-flight turn aborts and the carry currently STILL fires
  (starting a new turn on the closed conversation). This may or may not be
  desired (does closing discard pending steering, or honor it?). Backend flag
  for a decision; if "discard on close" is wanted, the backend will gate the
  carry on `finishReason !== "aborted"`. No FE action either way — just be aware
  a closed conversation might briefly start a turn from a queued message.
- **`steering` is additive** to the `AgentEvent` union — no exhaustive switches
  broke on the backend (verified: `tsc -b` EXIT 0). If the FE has an exhaustive
  switch on `AgentEvent`, add a `steering` case.
