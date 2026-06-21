# FE handoff — conversation compacting

Courier this to `../dispatch-web`. All changes are ADDITIVE.

## What shipped (backend)

Conversation compaction: summarize old history and replace it with a summary +
retain the most recent N messages. Two modes:
- **Manual**: `POST /conversations/:id/compact` — triggers immediately.
- **Automatic**: after each turn settles, the backend checks if the last turn's
  input tokens exceeded the per-conversation `compactThreshold`. If so,
  compaction runs automatically (fire-and-forget, non-blocking).

## Bump pinned deps
- `@dispatch/wire` → `0.11.0`
- `@dispatch/transport-contract` → `0.15.0`

## New types

```ts
// @dispatch/wire
export interface CompactionResult {
  readonly summary: string;
  readonly archiveId: string;  // ID of the archive conversation with full pre-compaction history
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

// @dispatch/transport-contract — WS message (server → client)
export interface ConversationCompactedMessage {
  readonly type: "conversation.compacted";
  readonly conversationId: string;
  readonly archiveId: string;  // ID of the archive conversation
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}
// Added to WsServerMessage union.

// @dispatch/transport-contract — HTTP response types
export interface CompactResponse {
  readonly conversationId: string;
  readonly archiveId: string;  // ID of the archive conversation
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

export interface CompactThresholdResponse {
  readonly conversationId: string;
  readonly threshold: number;  // 0 = manual only
}

export interface SetCompactThresholdRequest {
  readonly threshold: number;
}
```

## `POST /conversations/:id/compact` — manual compaction

Triggers compaction on demand. Optional JSON body:
```json
{ "keepLastN": 10, "modelName": "umans/umans-glm-5.2" }
```
- `keepLastN` (default 10): how many recent messages to retain.
- `modelName`: override the model used for summarization (defaults to the
  conversation's provider).

200 response: `CompactResponse`
409 response: `{ error: string }` — conversation is generating, too short, etc.
503: compaction service not available.

## `GET /conversations/:id/compact-threshold` — read threshold

200: `CompactThresholdResponse { conversationId, threshold }`
- `threshold: 0` — auto-compact explicitly disabled (manual only).
- `threshold: null` (not stored) — **default: 350000** (350k tokens). The FE
  should display 350000 as the default value in the settings UI.
- Any positive number — auto-compact triggers when the last turn's input tokens
  exceed this value.

## `PUT /conversations/:id/compact-threshold` — set threshold

Body: `SetCompactThresholdRequest { threshold: number }`
- `0` explicitly disables auto-compact.
- Any positive number sets the trigger threshold.
- To "reset to default", set it to 350000.

200: `CompactThresholdResponse`

## `conversation.compacted` WS message

Broadcast to all connected WS clients when compaction completes. The FE should
reload the conversation history via `GET /conversations/:id` to reflect the
compacted state (the old messages are replaced by a system summary + recent N).

## How compaction works (backend) — non-destructive

1. Load full conversation history.
2. Split: old messages (to summarize) + recent N (to keep, default 10).
3. **Fork** the full pre-compaction history to a new archive conversation
   (new UUID). The archive gets `status: "closed"`, title `"Archive: <original>"`,
   and `compactedFrom: <originalId>`.
4. Call the model with a summarization system prompt + old messages.
5. **Replace** the original conversation's history with:
   `[system: "Summary of previous conversation: ..."] + recent N messages`.
6. Set `compactedFrom: <archiveId>` on the original conversation's metadata.
7. Emit `conversationCompacted` hook → WS broadcast (includes `archiveId`).

**The original history is never destroyed.** The archive conversation is a
complete copy of the pre-compaction state, accessible via `GET /conversations/:id`
using the archive ID. The FE can link to it from the compacted conversation.

`ConversationMeta` now has an optional `compactedFrom?: string` field. On a
compacted conversation, it points to the archive ID. On the archive, it points
to the original conversation ID. The FE can use this to show a "View full
history" link.

## What the FE needs to do

1. **Compact button** in the conversation toolbar → `POST /conversations/:id/compact`.
   Show a loading indicator while waiting for the response.

2. **Settings UI** for compact threshold: `PUT /conversations/:id/compact-threshold`
   with `{ threshold: number }`. A number input (0 = manual only). Read the
   current value via `GET /conversations/:id/compact-threshold`.

3. **Handle `conversation.compacted` WS messages**: reload the conversation
   history via `GET /conversations/:id`. The first message will now be a system
   summary instead of the original conversation.

4. **Visual indicator**: show a badge or divider indicating the conversation
   has been compacted (e.g. "N messages summarized" from the WS payload or the
   HTTP response).

## CLI

`dispatch compact <conversationId>` — triggers manual compaction. Resolves
short IDs like other commands.
