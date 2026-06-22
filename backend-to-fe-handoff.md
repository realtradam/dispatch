# Backend → FE handoff — CR-6 resolved + full endpoint list

> Response to `backend-handoff.md` §2 CR-6. Courier back to `../dispatch-web`.

## CR-6: Assign seq during generation — RESOLVED

**What changed:** The backend now persists chunks **incrementally at step
boundaries** during generation, not only at turn-seal. The user message is
persisted at turn start (before the first step), and each step's messages
(assistant + tool-results) are persisted as soon as that step completes.

**How it works:**
1. Turn starts → user message is `append`ed immediately (gets seq numbers).
2. Each step completes → step's messages are `append`ed immediately (get seq numbers).
3. Turn seals → `turn-sealed` emitted (no batch `append` needed — already persisted).

**What this means for the FE:**
- `GET /conversations/:id?sinceSeq=N` returns committed, seq'd chunks **during
  generation**. The FE's existing `syncTail` already polls this — it will now
  find new chunks as each step completes.
- The FE can adopt option (c) from the CR: fold events for the **current
  in-progress step** only (streaming text, thinking dots), and `syncTail` for
  **sealed steps**. The provisional state shrinks to just one step's worth of
  chunks — never a trim concern.
- `turn-sealed` becomes a "refresh" signal — all chunks are already committed.
  The `done` event still carries final usage + contextSize (unchanged).

**No wire/transport-contract change needed.** `StoredChunk` already has `seq`.
`AgentEvent` types are unchanged. The FE just needs `syncTail` to find seq'd
chunks during generation (which it already does).

**Implementation detail:** The kernel calls a new `onStepComplete` callback
(`RunTurnInput.onStepComplete`) after each step's messages are finalized.
The orchestrator persists them via `conversationStore.append`. If the callback
isn't called (e.g., test fakes), the orchestrator falls back to batch persist
after `runTurn` returns — backward compatible.

---

## Full endpoint list (current as of wire@0.11.0 / transport-contract@0.15.0)

### HTTP (port 24203)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/chat` | Stream a turn (NDJSON response, `X-Conversation-Id` header) |
| `POST` | `/chat/warm` | Cache-warm probe |
| `GET` | `/models` | List available models |
| `GET` | `/conversations` | List conversations (`?q=` prefix filter, `?status=active,idle` status filter) |
| `GET` | `/conversations/:id` | Conversation history (`?sinceSeq=`, `?beforeSeq=`, `?limit=` windowing) |
| `GET` | `/conversations/:id/metrics` | Per-turn metrics (tokens, timing) |
| `GET` | `/conversations/:id/last` | Blocking last assistant message |
| `GET` | `/conversations/:id/cwd` | Per-conversation working directory |
| `PUT` | `/conversations/:id/cwd` | Set working directory |
| `GET` | `/conversations/:id/reasoning-effort` | Per-conversation reasoning effort |
| `PUT` | `/conversations/:id/reasoning-effort` | Set reasoning effort |
| `GET` | `/conversations/:id/lsp` | LSP server status |
| `GET` | `/conversations/:id/compact-threshold` | Auto-compact threshold (0=manual, null=default 350k) |
| `PUT` | `/conversations/:id/compact-threshold` | Set auto-compact threshold |
| `GET` | `/conversations/:id/title` | Read conversation title |
| `PUT` | `/conversations/:id/title` | Set conversation title |
| `POST` | `/conversations/:id/close` | Close tab (abort turn + mark `closed`) |
| `POST` | `/conversations/:id/stop` | **NEW** — Stop generation (abort turn, keep conversation `idle`) |
| `POST` | `/conversations/:id/compact` | **NEW** — Manual compaction (fork history + replace with summary) |
| `POST` | `/conversations/:id/open` | **NEW** — Signal FE to open/focus tab (broadcasts `conversation.open`) |
| `POST` | `/conversations/:id/queue` | Enqueue steering message |
| `GET` | `/health` | Health check |
| `GET` | `/metrics/throughput` | Per-model throughput samples |
| `GET` | `/*` | Static frontend serving (SPA fallback, when `DISPATCH_WEB_DIR` is set) |

### WebSocket (port 24205)

**Client → Server:**
| Type | Purpose |
|---|---|
| `chat.send` | Start a turn (stream events back via `chat.delta`) |
| `chat.subscribe` | Watch a conversation's turns without sending |
| `chat.unsubscribe` | Stop watching |
| `chat.queue` | Enqueue steering (fire-and-forget) |
| Surface ops | `surface.subscribe`, `surface.invoke`, etc. |

**Server → Client (broadcasts):**
| Type | Purpose |
|---|---|
| `chat.delta` | Per-conversation event (turn-start, text-delta, tool-call, usage, done, etc.) |
| `chat.error` | Turn error |
| `conversation.open` | **NEW** — CLI `--open` flag → open/focus a tab |
| `conversation.statusChanged` | **NEW** — Lifecycle status change (`active`/`idle`/`closed`) |
| `conversation.compacted` | **NEW** — History compacted (includes `newConversationId` = archive ID) |
| Surface ops | Catalog, surface data, etc. |

### New types the FE should consume

```ts
// ConversationMeta (wire@0.11.0) — now has status + compactedFrom
interface ConversationMeta {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  title: string;
  status: "active" | "idle" | "closed";
  compactedFrom?: string;  // archive ID (pre-compaction history)
}

// WS messages (transport-contract@0.15.0)
interface ConversationCompactedMessage {
  type: "conversation.compacted";
  conversationId: string;
  newConversationId: string;  // archive ID
  messagesSummarized: number;
  messagesKept: number;
}

// HTTP response types
interface CompactResponse {
  conversationId: string;
  newConversationId: string;  // archive ID
  messagesSummarized: number;
  messagesKept: number;
}

interface CompactThresholdResponse {
  conversationId: string;
  threshold: number;  // 0 = manual; null = default 350000
}

interface SetCompactThresholdRequest {
  threshold: number;
}
```

### FE handoff docs (in the backend repo)

| File | Feature |
|---|---|
| `frontend-conversation-lifecycle-handoff.md` | Tab persistence (active/idle/closed) |
| `frontend-compaction-handoff.md` | Compacting (non-destructive, chained archives) |
| `frontend-stop-generation-handoff.md` | Stop generation mid-turn |
| `frontend-conversation-list-handoff.md` | Conversation list + title + open tab |
| `frontend-conversation-open-handoff.md` | CLI `--open` → `conversation.open` WS message |
| `frontend-cache-rate-handoff.md` | Cache hit/miss calculation (updated for providers that don't report cache) |
