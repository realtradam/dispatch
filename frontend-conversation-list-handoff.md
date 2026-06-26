# FE handoff — conversation list, title, and open tab

Courier this to `../frontend`. All changes are ADDITIVE — nothing existing breaks.

## What shipped (backend)

Three new features for conversation management:

1. **Conversation list** — `GET /conversations` returns all known conversations with
   metadata (id, title, createdAt, lastActivityAt). The backend auto-tracks metadata
   on every message append; title defaults to the first user message (truncated 80 chars).

2. **Conversation title** — `GET/PUT /conversations/:id/title` lets the FE read and
   set a human-readable title for any conversation.

3. **Open tab signal** — `POST /conversations/:id/open` broadcasts a `conversation.open`
   WS message to all connected clients (e.g. when the CLI uses `--open`). See also
   `frontend-conversation-open-handoff.md` for the WS message details.

No version bumps needed — all types are already in `@dispatch/transport-contract` `0.13.0`
and `@dispatch/wire` `0.9.0`.

## `GET /conversations` — conversation list

Returns all conversations sorted by `lastActivityAt` descending (most recent first).

- Optional `?q=<prefix>` query param filters by conversation ID prefix (short-ID
  resolution — used by the CLI; the FE can ignore it or use it for search).
- 200 response: `ConversationListResponse`

```ts
interface ConversationListResponse {
  readonly conversations: readonly ConversationMeta[];
}

interface ConversationMeta {
  readonly id: string;
  readonly createdAt: number;      // epoch-ms
  readonly lastActivityAt: number;  // epoch-ms
  readonly title: string;
}
```

**FE use case:** render a conversation sidebar/picker showing title + relative time.
Click a conversation to open it (load its history via the existing `GET /conversations/:id`).

## `GET /conversations/:id/title` — read title

- 200 response: `TitleResponse { conversationId, title }`

## `PUT /conversations/:id/title` — set title

- Body: `SetTitleRequest { title: string }` (non-empty after trim, else 400)
- 200 response: `TitleResponse { conversationId, title }`

**FE use case:** let the user rename a conversation. The title is also auto-set from
the first user message, so a newly created conversation already has a title.

## `GET /conversations/:id/last` — blocking last message

Blocks server-side until any in-flight turn settles, then returns the last AI text
message. Mainly for CLI use (`dispatch read <id>`), but the FE could use it for
notifications or previews.

- 200 response: `LastMessageResponse { conversationId, content, turnId? }`
- `content` is empty string if the conversation has no assistant message.
- Unknown conversation → `content: ""` (200, not an error).

## `POST /conversations/:id/open` — signal frontend

Calls the backend to broadcast `conversation.open` to all connected WS clients. See
`frontend-conversation-open-handoff.md` for the WS message format and FE handling.

- 200 response: `OpenConversationResponse { conversationId }`

## What the FE needs to do

1. **Bump pinned deps:** `@dispatch/wire` → `0.9.0`, `@dispatch/transport-contract`
   → `0.13.0`.

2. **Conversation sidebar/picker:** call `GET /conversations` on load (and periodically
   or on focus) to show a list of conversations. Each entry shows `title` + relative
   time from `lastActivityAt`. Click to open → load history via `GET /conversations/:id`.

3. **Title editing:** add an inline edit affordance on the conversation title.
   `PUT /conversations/:id/title` with `{ title }` to update.

4. **Handle `conversation.open` WS message:** when a `"conversation.open"` message
   arrives, open (or focus) a tab for that `conversationId`. See
   `frontend-conversation-open-handoff.md`.

## Notes

- Conversations are **in-memory only** on the backend — the list resets on server
  restart. New conversations appear as users chat; old ones may disappear after a
  restart.
- The title is auto-set from the first user message (truncated 80 chars). Users can
  override it via `PUT /conversations/:id/title`.
- `createdAt` is set on the first message append; `lastActivityAt` updates on every
  append.
