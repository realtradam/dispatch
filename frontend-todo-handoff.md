# FE handoff — todo task list surface

Courier this to `../frontend` (cross-repo contract change; `lsp references` does
not span repos — ORCHESTRATOR §7). All changes are ADDITIVE — nothing existing breaks.

## What shipped (backend)

A per-conversation **task list** the AI model maintains via a `todo_write` tool. The
list is exposed to the frontend as a per-conversation **surface** (read-only). The
model creates/updates the list during a turn; the surface updates live so the FE can
render the current state.

- **`todo_write` tool** — the model passes the FULL list each call (replaces the
  existing list). Returns the list as JSON. The tool description guides the model on
  when to use it (3+ step tasks, planning, etc.).
- **State** — in-memory, per-conversation. No persistence (the list lives for the
  process lifetime of the conversation).
- **No new wire types, no version bumps.** The todo surface uses the existing
  `custom` surface field kind (`ui-contract` unchanged). The `TodoItem` type is
  defined by the `todo` extension and carried in the surface payload — it is NOT
  in `@dispatch/wire` or `@dispatch/transport-contract`.

## The surface

The `todo` extension contributes a per-conversation surface:

- **Surface id:** `"todo"`
- **Scope:** `"conversation"` (subscribe with the `conversationId`)
- **Region:** `"side"`
- **Title:** `"Tasks"`
- **One `custom` field**, `rendererId: "todo"`, `payload: TodoPayload`

```ts
interface TodoPayload {
  todos: readonly TodoItem[];
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}
```

- **Read-only** — no `invoke` actions. The model mutates the list via the
  `todo_write` tool; the FE only renders.
- **Updates** on every `todo_write` call (subscriber-notify → full new spec with the
  updated `todos` array).
- **Empty list** — an idle conversation (no todo list created yet, or the model
  cleared it with an empty array) renders `todos: []`. Hide the panel when empty.

## What the FE needs to do

1. **Subscribe** to the `todo` surface per conversation (same pattern as
   `message-queue` and `cache-warming` — `scope: "conversation"`, pass
   `conversationId` on subscribe).

2. **Custom renderer** for `rendererId: "todo"` — render the `payload.todos` array
   as a task list. Suggested UI:
   - Each item shows `content` with a status indicator:
     - `pending` — empty circle / checkbox
     - `in_progress` — spinner / filled circle (highlight)
     - `completed` — checkmark (strikethrough or dim the content)
     - `cancelled` — X / dash (dim/strikethrough)
   - Order is significant — items are in the order the model provided them (array
     index = identity).
   - Only one item should be `in_progress` at a time (the tool description enforces
     this via guidance, not validation — but the model should comply).

3. **Live updates** — the surface pushes a new spec on every `todo_write` call. No
   polling needed. Just re-render from the new `payload.todos`.

4. **Empty state** — when `todos` is `[]`, hide the panel (the model hasn't created
   a list yet, or cleared it).

## No other integration points

- No new WS ops (no `chat.queue` equivalent — the model is the only writer).
- No new HTTP endpoints (the list is tool-driven, not API-driven).
- No new `AgentEvent` types (the list is not on the chat stream).
- No version bumps in `@dispatch/wire` or `@dispatch/transport-contract`.

## Notes

- **In-memory only** — the todo list does NOT persist across server restarts. If
  the server restarts, the list is cleared. The model recreates it on the next
  `todo_write` call. This mirrors the message-queue behavior.
- **Per-conversation** — each conversation has its own list. Switching conversations
  means subscribing to a different `conversationId` and rendering that conversation's
  list.
- **Model-driven** — the FE has no control over the list (read-only surface). The
  model creates, updates, and clears items. The FE just displays the current state.
