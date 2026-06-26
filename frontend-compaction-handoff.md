# FE handoff — conversation compacting

Courier this to `../frontend`. All changes are ADDITIVE.

## What shipped (backend)

Conversation compaction: summarize old history into a summary + recent N,
preserving the full pre-compaction history in a separate archive conversation.
Creates a linked chain of archives you can walk backward.

Two modes:
- **Manual**: `POST /conversations/:id/compact` — triggers immediately.
- **Automatic**: after each turn settles, the backend checks if the last turn's
  input tokens exceeded the per-conversation `compactThreshold` (default 85).
  If so, compaction runs automatically (fire-and-forget, non-blocking).

## How compaction works — non-destructive, chained

The compacted conversation **keeps its original ID** (so messaging between
agents still works). The old full history is **forked** to a new archive
conversation (new UUID). The archive inherits the source's `compactedFrom`,
creating a chain:

```
Compaction 1:  A (ID "abc") — full history forked to X (new ID).
               A's history replaced with [summary + recent N].
               A.compactedFrom = X

Compaction 2:  A (ID "abc") — current history forked to Y (new ID).
               A's history replaced with [new summary + recent N].
               A.compactedFrom = Y
               Y.compactedFrom = X (inherited from A's pre-compaction state)

Chain: A → Y → X  (walk compactedFrom backward)
```

Each archive is an **immutable snapshot** — a complete copy of the conversation
at the time of that compaction. History is never destroyed.

The FE **does not switch tabs** — the conversation ID doesn't change. Just
reload the history.

## Bump pinned deps
- `@dispatch/wire` → `0.11.0`
- `@dispatch/transport-contract` → `0.15.0`

## New types

```ts
// @dispatch/wire — ConversationMeta now has compactedFrom
export interface ConversationMeta {
  readonly id: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly title: string;
  readonly status: ConversationStatus;  // "active" | "idle" | "closed"
  /** Points to the archive conversation with full pre-compaction history. */
  readonly compactedFrom?: string;
}

// @dispatch/wire
export interface CompactionResult {
  readonly summary: string;
  readonly newConversationId: string;  // ID of the archive (old full history)
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

// @dispatch/transport-contract — WS message (server → client)
export interface ConversationCompactedMessage {
  readonly type: "conversation.compacted";
  readonly conversationId: string;       // the conversation (ID unchanged)
  readonly newConversationId: string;    // the archive ID (old full history)
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}
// Added to WsServerMessage union.

// @dispatch/transport-contract — HTTP response types
export interface CompactResponse {
  readonly conversationId: string;       // the conversation (ID unchanged)
  readonly newConversationId: string;    // the archive ID (old full history)
  readonly messagesSummarized: number;
  readonly messagesKept: number;
}

export interface CompactPercentResponse {
  readonly conversationId: string;
  readonly percent: number;  // 0 = manual only; null = default 85
}

export interface SetCompactPercentRequest {
  readonly percent: number;
}
```

## `POST /conversations/:id/compact` — manual compaction

Triggers compaction on demand. Optional JSON body:
```json
{ "keepLastN": 10, "modelName": "umans/umans-glm-5.2" }
```
- `keepLastN` (default 10): how many recent messages to retain.
- `modelName`: override the model used for summarization.

200 response: `CompactResponse` — includes `newConversationId` (the archive ID).
The conversation ID in the response is the same as the request — the ID doesn't
change. The FE should reload the conversation history.

409: `{ error: string }` — conversation is generating, too short, percent not exceeded, etc.
503: compaction service not available.

## `GET /conversations/:id/compact-percent` — read percent

200: `CompactPercentResponse { conversationId, percent }`
- `percent: 0` — auto-compact explicitly disabled (manual only).
- `percent: null` (not stored) — **default: 85** (85% tokens). The FE
  should display 85 as the default value in the settings UI.
- Any positive number — auto-compact triggers when the last turn's input tokens
  exceed this value.

## `PUT /conversations/:id/compact-percent` — set percent

Body: `SetCompactPercentRequest { percent: number }`
- `0` explicitly disables auto-compact.
- Any positive number sets the trigger percent.
- To "reset to default", set it to 85.

## `conversation.compacted` WS message

Broadcast to all connected WS clients when compaction completes. The FE should
**reload the conversation history** via `GET /conversations/:id` (the
conversation ID hasn't changed — just reload the same ID). The first message
will now be a system summary.

No tab switching needed — the ID is the same.

## What the FE needs to do

1. **Compact button** in the conversation toolbar → `POST /conversations/:id/compact`.
   Show a loading indicator while waiting. On success, reload the conversation
   history (same ID — just re-fetch).

2. **Settings UI** for compact percent: `PUT /conversations/:id/compact-percent`
   with `{ percent: number }`. A number input (0 = manual only, default 85).
   Read the current value via `GET /conversations/:id/compact-percent`.

3. **Handle `conversation.compacted` WS messages**: reload the conversation
   history via `GET /conversations/:id` (same ID, no tab switch).

4. **"View predecessor" link**: when `ConversationMeta.compactedFrom` is present,
   show a link that opens the archive conversation in a read-only view (or a new
   tab). Load it via `GET /conversations/:compactedFrom`. The archive has
   `status: "closed"` and title `"Archive: <original>"`. Each archive may also
   have its own `compactedFrom` — walk the chain backward to see every snapshot.

5. **Archives in conversation list**: archives appear in
   `GET /conversations?status=closed`. They have `compactedFrom` chaining to
   the previous archive (if any). The FE can show them in a history view.

6. **Visual indicator**: show a badge on conversations that have a
   `compactedFrom` (they've been compacted). E.g. "Compacted" badge or chain icon.

## CLI

`dispatch compact <conversationId>` — triggers manual compaction. Resolves
short IDs like other commands. The response includes the archive ID.
