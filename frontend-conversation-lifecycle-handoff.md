# FE handoff — conversation lifecycle (tab persistence across devices)

Courier this to `../frontend`. All changes are ADDITIVE — nothing existing breaks.

## What shipped (backend)

Conversations now have a lifecycle **status** field: `active`, `idle`, or `closed`.
This enables tab persistence: when a new browser connects, it fetches all
`active` + `idle` conversations and restores the tab bar.

- **`active`** — an agent is currently generating (a turn is in-flight).
- **`idle`** — conversation exists, not generating. User can send a message to resume.
- **`closed`** — user dismissed the tab (hidden from the tab bar, not deleted).

Status transitions are driven by the backend:
- `idle → active` when a turn starts.
- `active → idle` when a turn settles (done/error).
- `→ closed` when `POST /conversations/:id/close` is called.

## Bump pinned deps
- `@dispatch/wire` → `0.10.0`
- `@dispatch/transport-contract` → `0.14.0`

## New types (`@dispatch/wire` + `@dispatch/transport-contract`)

```ts
export type ConversationStatus = "active" | "idle" | "closed";

// ConversationMeta now has a status field:
export interface ConversationMeta {
  readonly id: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly title: string;
  readonly status: ConversationStatus;
}

// New WS message (server → client):
export interface ConversationStatusChangedMessage {
  readonly type: "conversation.statusChanged";
  readonly conversationId: string;
  readonly status: ConversationStatus;
}
```

`ConversationStatusChangedMessage` is added to the `WsServerMessage` union.

## `GET /conversations?status=active,idle` — filter by status

The existing `GET /conversations` endpoint now accepts an optional `?status=`
query param: a comma-separated list of statuses to filter by.

- **Default (no param):** returns ALL conversations (all statuses).
- `?status=active,idle` → only active + idle (what the FE tab bar wants).
- `?status=closed` → only closed conversations (for a history view).
- Invalid values are silently dropped. If all values are invalid, no filter
  is applied (returns all).

## `POST /conversations/:id/close` — marks as closed

The existing close endpoint now also sets the conversation's status to `closed`
in the store. This persists across server restarts. The response is unchanged
(`{ conversationId, abortedTurn }`).

## `conversation.statusChanged` WS message

Broadcast to ALL connected WS clients whenever a conversation's status changes.
The backend emits this synchronously alongside the existing `turnStarted` /
`turnSettled` / `conversationClosed` hooks.

```ts
{ type: "conversation.statusChanged", conversationId: "conv-1", status: "active" }
```

## What the FE needs to do

1. **On connect:** call `GET /conversations?status=active,idle` to fetch
   conversations for the tab bar. Render tabs for each.

2. **`active` tabs:** subscribe to the conversation's live stream
   (`chat.subscribe` WS op) to receive in-flight events.

3. **`idle` tabs:** load history via `GET /conversations/:id`. No live
   subscription needed until the user sends a message.

4. **Tab close button:** call `POST /conversations/:id/close` to mark the
   conversation as `closed`. Remove it from the tab bar.

5. **Handle `conversation.statusChanged` WS messages:** update the tab's
   status indicator. When a conversation goes `idle → active`, show a
   loading/generating indicator. When it goes `active → idle`, remove the
   indicator. When it goes `closed`, remove the tab.

6. **Closed conversations:** accessible from a history view
   (`GET /conversations?status=closed`). Can be reopened by sending a message
   (which transitions `closed → active`).

## CLI

`dispatch list` now defaults to `active,idle` (excludes closed). New flags:
- `--status <active|idle|closed>` — filter by a single status.
- `--all` — include closed (show all statuses).
