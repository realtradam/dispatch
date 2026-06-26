# FE handoff — conversation.open (CLI --open flag)

Courier this to `../frontend`. All changes are ADDITIVE.

## What shipped (backend)

The CLI's `--open` flag (`dispatch send <id> --text "..." --open`) calls
`POST /conversations/:id/open`, which emits a `conversationOpened` bus event. The
transport-ws extension subscribes and broadcasts a new WS message to ALL connected
frontend clients.

## New WS message (additive to `WsServerMessage`)

```ts
interface ConversationOpenMessage {
  readonly type: "conversation.open";
  readonly conversationId: string;
}
```

The `type` is `"conversation.open"` — add it to the FE's `WsServerMessage` union
handler. It arrives as a top-level WS message (not inside `chat.delta`).

## What the FE needs to do

1. **Handle the WS message** — when a `"conversation.open"` message arrives, open
   (or focus) a tab for `conversationId`. The backend just signals; the FE decides
   whether to actually open/focus or just notify.

2. **Suggested behavior:**
   - If the conversation is already open in a tab, focus that tab.
   - If not, open a new tab for it (load its history via `GET /conversations/:id`).
   - Do NOT auto-focus if the user is actively typing in another tab (optional —
     your discretion).

3. **No version bumps needed** — `@dispatch/transport-contract` already exports
   `ConversationOpenMessage` (additive to `WsServerMessage` since `0.13.0`). The FE
   just needs to add the `type: "conversation.open"` case to its WS message handler.

## No other integration points

- No new HTTP endpoints for the FE (the CLI calls `POST /conversations/:id/open`).
- No new surface types.
- No new `AgentEvent` types.
- The message is a global broadcast (sent to ALL connected clients), not per-
  conversation.

## Notes

- The `--open` flag can be combined with `--queue` (enqueue + signal) or used
  without `--queue` (blocking send + signal).
- Multiple clients (e.g. phone + laptop) all receive the broadcast — each decides
  independently whether to open/focus.
