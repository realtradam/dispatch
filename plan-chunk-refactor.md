# Plan: Chunk-Based Message Refactor

## Goal

Replace the current `content: ContentSegment[]` + separate `thinking: string` representation with a single ordered `chunks: Chunk[]` list per message. Preserve the actual temporal ordering of text, reasoning, tool calls, system notices, and errors as they arrive from the model — losing none of that information to flat-string accumulation.

This is foundational work for downstream features (editable history, resumable mid-generation chats, structured truncation sentinels) that all assume an honest, lossless representation of a turn.

Beta software — **no backward compatibility required**. The existing `messages` and `tabs` rows will be destroyed. Settings, keys, credentials, and other non-chat-history state will be preserved.

## Final Design

### Chunk union

| Type | Body | Opens on | Closes on | Sent to LLM? |
|---|---|---|---|---|
| `text` | `text: string` | First `text-delta` after non-text. Consecutive `text-delta` events append. | `reasoning-delta`, `tool-call`, `error`, system event, `done`. | Yes (as `text` part). |
| `thinking` | `text: string` | First `reasoning-delta` after non-thinking. Consecutive `reasoning-delta` events append. | `text-delta`, `tool-call`, `error`, system event, `done`. | Yes (as `reasoning` part — handles Claude's `interleaved-thinking-2025-05-14`). |
| `tool-batch` | `calls: Array<{ id, name, arguments, result?, isError?, shellOutput? }>` | First `tool-call` after non-tool. Consecutive `tool-call` events append a new entry to `calls`. | Any non-tool event. | Yes (each call/result as `tool-call` / `tool-result` parts). |
| `error` | `message: string`, `statusCode?: number` | An `error` event. Always its own chunk. No coalescing. | Single-event. | No (the turn ended anyway). |
| `system` | `text: string`, `kind: "notice" \| "model-changed" \| "config-reload" \| "cancelled"` | A system event. Always its own chunk. No coalescing. | Single-event. | **No — stripped in `toCoreMessages`.** |

### Message roles

`user | assistant | system`

- `user` and `assistant` messages can contain any chunk types.
- `system` role messages exist for system events that fire **outside an active assistant turn**. They contain only `system` chunks. They are skipped entirely by `toCoreMessages`.

### System event routing

When a system event arrives:

1. Active assistant turn in flight → append a `system` chunk to that message's chunks at its current position.
2. No turn in flight; most recent message is `role: "system"` → append a `system` chunk to that message.
3. No turn in flight; most recent message is anything else → create a new `role: "system"` message containing one `system` chunk.

### `toCoreMessages` rebuild rules

- Iterate messages in seq order.
- Skip `role: "system"` messages entirely.
- For each message, iterate `chunks` and emit AI SDK parts:
  - `text` → `{ type: "text", text }`
  - `thinking` → `{ type: "reasoning", text }`
  - `tool-batch` → one `{ type: "tool-call" }` per entry (and tool-result parts in the following `tool` message, same as current logic)
  - `error` → skip
  - `system` → skip

### Example turn

User clicks Send, model thinks, says something, hits a rate limit (auto-switches model), thinks more, calls two tools, says something, errors out:

```
Message #N (role=user):
  chunks: [{ type: "text", text: "explain X" }]

Message #N+1 (role=assistant):
  chunks: [
    { type: "thinking", text: "I should..." },
    { type: "text", text: "Sure, here's the gist..." },
    { type: "system", kind: "model-changed", text: "Switched to Sonnet 4 (rate limit)" },
    { type: "thinking", text: "Now I need to look at..." },
    { type: "tool-batch", calls: [
        { id: "1", name: "read_file", ..., result: "..." },
        { id: "2", name: "list_files", ..., result: "..." }
    ]},
    { type: "text", text: "Looking at the file..." },
    { type: "error", message: "Network error", statusCode: 503 }
  ]
```

## Database cleanup

**Live DB:** `~/.local/share/dispatch/dispatch.db` (XDG: `$XDG_DATA_HOME/dispatch/dispatch.db`)

Current size: ~122 MB. Tables and row counts as of this plan:

| Table | Rows | Disposition |
|---|---|---|
| `api_keys` | 7 | **Preserve** — user-imported API keys |
| `credentials` | 2 | **Preserve** — OAuth credentials |
| `settings` | 11 | **Preserve** — app settings |
| `usage_cache` | 2 | **Preserve** — usage report cache |
| `wake_schedule` | 5 | **Preserve** — wake schedule |
| `messages` | 524 | **Delete all** — chat history |
| `tabs` | 361 | **Delete all** — chat sessions |

### Proposed cleanup statements

```sql
-- Order matters: messages references tabs.id via foreign key (ON in WAL mode)
DELETE FROM messages;
DELETE FROM tabs;
VACUUM;
```

Then, in the live schema, drop the `thinking` column from `messages` (or recreate the table without it). SQLite has historically been fussy about `DROP COLUMN`; modern SQLite (3.35+) supports it directly:

```sql
ALTER TABLE messages DROP COLUMN thinking;
```

If the installed SQLite is older, fall back to the table-rebuild pattern (create new table without the column, copy rows, swap names, drop old). Given we just `DELETE FROM messages`, the copy step is a no-op — we can just `DROP TABLE messages` and recreate via the application's `CREATE TABLE IF NOT EXISTS` on next startup (after the schema change in `db/index.ts`).

**Preferred sequence:**

1. Stop any running dispatch processes.
2. Run `DELETE FROM messages; DELETE FROM tabs; VACUUM;` to clear chat history.
3. Update `db/index.ts` to remove the `thinking` column from the `CREATE TABLE messages` statement.
4. Drop the existing messages table so the new schema takes effect on next startup: `DROP TABLE messages; DROP INDEX IF EXISTS idx_messages_tab;` (the app will recreate it on launch).

Effective end state: same DB file, settings/keys preserved, chat history gone, new schema.

## Implementation phases

### Phase 0 — Confirm starting point

- [ ] `git status` clean (only `wishlist.md` untracked is acceptable — unrelated).
- [ ] No running dispatch processes that hold the DB.

### Phase 1 — Types

File: `packages/core/src/types/index.ts`

- [ ] Define `Chunk` union (5 variants per the table above).
- [ ] Replace `ChatMessage.content: string` + `toolCalls?` + `toolResults?` with `chunks: Chunk[]`.
- [ ] Update `MessageRole` to include `"system"` (currently `"user" | "assistant" | "tool"` — drop `"tool"` since tool messages are now embedded as `tool-batch` chunks).

File: `packages/frontend/src/lib/types.ts`

- [ ] Mirror `Chunk` union.
- [ ] Replace `content: ContentSegment[]` + `thinking?: string` with `chunks: Chunk[]`.
- [ ] Drop `ContentSegment` and `ToolCallDisplay` (replaced by chunk variants).

### Phase 2 — Core helper + unit tests

New file: `packages/core/src/chunks/append.ts` (or co-located in `agent/`)

- [ ] Implement `appendEventToChunks(chunks: Chunk[], event: AgentEvent): void` (mutating, returns void).
- [ ] Implement `applySystemEvent(messages: ChatMessage[], event: SystemEvent): void` for the standalone-system-message routing logic.

Tests: `packages/core/tests/chunks/append.test.ts`

- [ ] Empty chunks + text-delta → one text chunk with the delta.
- [ ] Two consecutive text-deltas → one text chunk with concatenated text.
- [ ] text-delta then reasoning-delta → two chunks (text, thinking).
- [ ] text-delta then tool-call → two chunks (text, tool-batch with one entry).
- [ ] Two consecutive tool-calls → one tool-batch with two entries.
- [ ] tool-call then tool-call then text → two chunks (tool-batch with 2 entries, text).
- [ ] tool-result arrives → updates matching tool-call entry in the latest tool-batch chunk by id.
- [ ] shell-output arrives → appends to the most recent tool-call's `shellOutput`.
- [ ] error event → opens an error chunk; subsequent events go to new chunks.
- [ ] system event during text run → closes text, opens system, would re-open text on next text-delta.
- [ ] Two consecutive system events → two separate system chunks (no coalescing).
- [ ] Interleaved think → text → think → tool → think → text → 6 chunks in order.

### Phase 3 — Database schema + cleanup

File: `packages/core/src/db/index.ts`

- [ ] Update `CREATE TABLE messages` to drop the `thinking` column.

Live DB:

- [ ] Run `DELETE FROM messages; DELETE FROM tabs; VACUUM;` (show user before executing).
- [ ] Drop the `messages` table so the new schema takes effect on next startup.

File: `packages/core/src/db/messages.ts`

- [ ] Update `appendMessage()` signature: drop the `thinking` parameter; `content_json` now holds chunks.
- [ ] Update read functions to parse `content_json` as `Chunk[]` directly (no thinking column read).

### Phase 4 — Agent aggregation

File: `packages/core/src/agent/agent.ts`

- [ ] Replace `finalText: string`, `allToolCalls: ToolCall[]`, `allToolResults: ToolResult[]`, and `assistantThinking` (lines 331-333 and the equivalent in agent-manager) with a single `chunks: Chunk[]`.
- [ ] On each event from `result.fullStream`, call `appendEventToChunks(chunks, event)`.
- [ ] On `done`, ship `chunks` in the message payload.
- [ ] Update `toCoreMessages` (lines 20-46): iterate chunks per message, emit AI SDK parts, skip system / error chunks, skip `role: "system"` messages entirely.

### Phase 5 — Persistence + system event routing

File: `packages/api/src/agent-manager.ts`

- [ ] Replace the three-accumulator pattern (lines 893-978) with a single `chunks: Chunk[]` that delegates to `appendEventToChunks`.
- [ ] On `notice` / `model-changed` / `config-reload` / cancel: route through `applySystemEvent` — appends to the in-flight assistant message if one exists, else appends to a `role: "system"` message (creating one if needed).
- [ ] `appendMessage` call: drop the thinking arg; `content_json` is `JSON.stringify(chunks)`.

### Phase 6 — Frontend store state machine

File: `packages/frontend/src/lib/tabs.svelte.ts`

- [ ] Replace per-event-type mutation logic (lines 288-626) with a call to the shared `appendEventToChunks` helper. Import from core if feasible; otherwise duplicate carefully — but prefer import to keep wire-format symmetry guaranteed.
- [ ] Update `openAgentTab` DB-load path (lines 185-199): parse `chunks` directly from `content_json`, no thinking field merging.
- [ ] Update `currentAssistantId` semantics: still tracks the in-progress assistant message. System events that arrive when `currentAssistantId` is null create/append a `role: "system"` message via `applySystemEvent`.

### Phase 7 — Frontend display

File: `packages/frontend/src/lib/components/ChatMessage.svelte`

- [ ] Remove the top-hoisted `{#if message.thinking}` block.
- [ ] Replace the segments loop with `{#each message.chunks as chunk}` and switch on `chunk.type`:
  - `text` → `<MarkdownRenderer>`
  - `thinking` → collapsible (DaisyUI `collapse`), default-collapsed per `appSettings.autoExpandThinking`, at its actual position in the turn.
  - `tool-batch` → render each entry via `<ToolCallDisplay>` (existing component, possibly minor prop tweaks).
  - `error` → red-bordered error card with the message + status code.
  - `system` → thin separator-style block with the `kind` as a small label and the text.
- [ ] Handle `role: "system"` messages: render as a standalone thin bubble with just the system chunks, no avatar / no actions.

### Phase 8 — Integration tests

- [ ] End-to-end: a real streaming run produces the expected chunk shape, including interleaved thinking.
- [ ] Persistence round-trip: write chunks → read back → identical structure.
- [ ] System event during turn ends up in the assistant message at the right position.
- [ ] System event with no turn in flight creates a `role: "system"` message.
- [ ] `toCoreMessages` correctly strips system / error chunks and `role: "system"` messages.

### Phase 9 — Cleanup

- [ ] Remove dead code: `ContentSegment` type, `thinking` field references, old per-event accumulator vars.
- [ ] Run `vitest run` across all packages and `tsc --noEmit`.
- [ ] Commit with a focused message; push.

## Test strategy

The load-bearing piece is `appendEventToChunks`. If this is correct in isolation, every downstream layer inherits correctness. **Write Phase 2 first and lock its tests in green before touching agent/store/UI.**

State-machine tests should cover every transition pair in the matrix (text→text, text→thinking, text→tool, text→error, text→system, thinking→text, ...) so that no transition gets accidentally broken later.

Integration tests can be lighter — they just need to confirm the real wire format flows through the helper end-to-end.

## Risks and notes

1. **Frontend store imports from core.** Currently the frontend duplicates some types. Importing `appendEventToChunks` from core is the safest way to guarantee the wire format stays in sync — but requires the build to handle the import. If it doesn't, duplicate the helper carefully and have a test that runs both side by side on the same fixture events to detect drift.

2. **`ai` SDK `reasoning` events.** Confirmed that `result.fullStream` emits `reasoning` events with `event.textDelta` for Anthropic with the `interleaved-thinking-2025-05-14` beta header. Other providers (OpenAI-compat) emit reasoning via different mechanisms; the middleware in `provider.ts:6-38` already handles those.

3. **Tool result ordering across multiple steps.** Currently, `tool-result` events arrive at varying times relative to subsequent `text-delta` events depending on whether the AI streams text before vs after acknowledging the result. The new chunk model places results inside the `tool-batch` chunk that holds the matching call — this should be correct regardless of when the result event arrives, as long as the lookup-by-id finds the right batch.

4. **Coalescing edge case: simultaneous tool calls.** If the AI emits multiple tool-call events with no intervening events (parallel tool use), they all batch together. If a `tool-result` for the first call arrives before the second `tool-call` event, the tool-batch chunk is already open and just absorbs both. No special handling needed.

5. **Settings preservation.** The `settings` table (`key`, `value` columns) is preserved across the wipe. Verify the dispatch UI doesn't rely on any session-scoped row that lives inside `tabs` (e.g., "last opened tab id") — if so, the user will need to re-pick after the wipe. This is acceptable for beta.

6. **`MessageRole` change.** Dropping `"tool"` from the role union means any code path that pattern-matches on `role === "tool"` must change. Grep for it before merging.
