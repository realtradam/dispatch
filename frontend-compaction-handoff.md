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
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

// @dispatch/transport-contract — WS message (server → client)
export interface ConversationCompactedMessage {
  readonly type: "conversation.compacted";
  readonly conversationId: string;
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}
// Added to WsServerMessage union.

// @dispatch/transport-contract — HTTP response types
export interface CompactResponse {
  readonly conversationId: string;
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
`threshold: 0` means auto-compact is disabled (manual only).

## `PUT /conversations/:id/compact-threshold` — set threshold

Body: `SetCompactThresholdRequest { threshold: number }`
`threshold: 0` disables auto-compact. Any positive number enables it.

200: `CompactThresholdResponse`

## `conversation.compacted` WS message

Broadcast to all connected WS clients when compaction completes. The FE should
reload the conversation history via `GET /conversations/:id` to reflect the
compacted state (the old messages are replaced by a system summary + recent N).

## How compaction works (backend)

1. Load full conversation history.
2. Split: old messages (to summarize) + recent N (to keep, default 10).
3. Call the model with a summarization system prompt + old messages.
4. Replace the entire history with: `[system: "Summary of previous conversation: ..."] + recent N messages`.
5. Emit `conversationCompacted` hook → WS broadcast.
6. The summary preserves key decisions, file paths, and unresolved questions.

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
