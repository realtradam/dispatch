# Plan: Append-Only Chunk Log (supersedes plan-chunk-refactor.md)

## Goal

Replace the `messages(role, content_json=Chunk[])` "turn-as-container" model with a
**flat, append-only chunk log**. Each chunk is its own row, ordered by a per-tab
monotonic `seq`. "Message" and "turn" become *derived groupings*, not stored
containers.

This single change fixes two problems at once:

1. **Prompt-cache churn** (see `cache-miss-report.md`). A multi-step turn is
   currently one growing assistant message that `toModelMessages` re-buckets every
   step, reshuffling earlier `tool_use`/`tool_result` positions and busting the
   Anthropic cache prefix. An immutable, append-only log folded **per step** makes
   the prefix byte-stable across requests → rolling cache accumulates.
2. **Frontend memory** on constrained devices. Today the smallest
   loadable/evictable unit is a whole turn (`tabs.svelte.ts:360-372` admits it).
   With chunks as the unit, the frontend pages and evicts at **chunk granularity**.

Beta software — **no backward compatibility**. On first boot of the new build:
drop `messages`, clear `tabs`. Preserve `settings`, `credentials`, `api_keys`,
`usage_cache`, `wake_schedule`.

## Decisions (locked)

- **Option A**: turn is a `turn_id` column on chunks; there is **no `turns` table**
  (A→C upgrade later is additive if a turn-level UI is ever needed).
- **Separate rows** for `tool_call` (role `assistant`) and `tool_result` (role
  `tool`), linked by `call_id`.
- **Write-on-seal**: a chunk is persisted when it *seals* (a block completes), not
  per delta. The single currently-open block lives only in memory until it seals;
  a mid-turn crash loses at most that one open block. `sealed` is therefore an
  in-memory concept only — **not** a DB column.
- Clear chunks **and** tabs on migration.

---

## 1. Schema

```sql
CREATE TABLE chunks (
  id          TEXT PRIMARY KEY,           -- uuid; streaming deltas target this id
  tab_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,           -- per-tab monotonic; ordering + pagination cursor
  turn_id     TEXT NOT NULL,              -- one run(): the user msg + its full assistant response
  step        INTEGER NOT NULL DEFAULT 0, -- LLM round-trip index within the turn (user/system = 0)
  role        TEXT NOT NULL,              -- 'user' | 'assistant' | 'tool' | 'system'
  type        TEXT NOT NULL,              -- 'text'|'thinking'|'tool_call'|'tool_result'|'error'|'system'
  data_json   TEXT NOT NULL,              -- type-specific payload (below)
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_chunks_tab_seq ON chunks(tab_id, seq);
```

`seq` is allocated as `MAX(seq)+1 WHERE tab_id=?` (mirrors current `appendMessage`),
or from an in-memory per-tab counter for the live turn.

### `data_json` payloads by `type`

| type          | role        | payload |
|---------------|-------------|---------|
| `text`        | user/assistant | `{ text }` |
| `thinking`    | assistant   | `{ text, metadata? }`  (Anthropic signature blob) |
| `tool_call`   | assistant   | `{ callId, name, arguments }` |
| `tool_result` | tool        | `{ callId, name, result, isError, shellOutput? }` |
| `error`       | assistant/system | `{ message, statusCode? }` |
| `system`      | system      | `{ kind, text }` |

### Migration (one-shot, in `getDatabase()` bootstrap)

- `DROP TABLE IF EXISTS messages;`
- `DELETE FROM tabs;` (clears tab shells too, per decision)
- `CREATE TABLE chunks …` if not exists.
- Everything else untouched.

---

## 2. Core types (`packages/core/src/types/index.ts`)

Introduce the persisted row + payload unions; retire `ChatMessage`/`Chunk`-as-container.

```ts
export type ChunkRole = "user" | "assistant" | "tool" | "system";
export type ChunkType =
  | "text" | "thinking" | "tool_call" | "tool_result" | "error" | "system";

export interface LogChunk {
  id: string;
  tabId: string;
  seq: number;
  turnId: string;
  step: number;
  role: ChunkRole;
  type: ChunkType;
  data: ChunkData;        // discriminated by `type`
  createdAt: number;
}
// ChunkData = TextData | ThinkingData | ToolCallData | ToolResultData | ErrorData | SystemData
```

`ToolCall`/`ToolResult`/`TaskItem`/`AgentConfig` stay. `ChatMessage`,
`ToolBatchChunk`, `ToolBatchEntry`, `TabStatusSnapshot.currentChunks` change or go.

---

## 3. The wire builder — `chunksToModelMessages` (the caching fix)

New pure function (replaces `toModelMessages` in `agent.ts:104`). Input: the tab's
`LogChunk[]` in `seq` order. Output: `ModelMessage[]`.

**Folding rules** (group contiguous chunks by `turn_id` + `role-bucket` + `step`):

- `user/text` → `{ role:"user", content }` (concatenate consecutive user text).
- For each **step** of a turn's assistant output:
  - `assistant` `text`/`thinking`/`tool_call` chunks of that step → **one**
    `{ role:"assistant", content:[parts in seq order] }`. Natural order is
    thinking → text → tool_call, so tool-calls are last.
  - `tool` `tool_result` chunks of that step → **one** `{ role:"tool", content:[…] }`
    immediately after.
- `system`/`error` chunks → skipped (display-only), exactly as today.

**Why this is cache-stable:** every prior step's `[assistant, tool]` pair is built
from immutable chunks at fixed `seq`s, so it serializes byte-identically on every
later request. Step N+1 only appends new messages at the tail. The Pass-3 split
never triggers (no later-step text after a tool-call inside one message). Result:
Anthropic matches the full prefix up to the current step; `applyAnthropicCaching`
(unchanged, `agent.ts:448`) marks the current `[assistant, tool]` and the cached
prefix grows monotonically.

**Regression test (must-have):** a 3-step sequential turn → assert the step-0 and
step-1 ModelMessages are byte-identical between the step-2 and step-3 builds.

### Structural normalizations (carry over + one fix)

Keep empty-text drop, `toolCallId` scrub, Pass-3 (now a no-op safety net). **Fix
the report's divergence:** retain a `reasoning` part when it has a signature even if
its text is empty (mirror opencode `transform.ts:144-150`); today `agent.ts:356-360`
drops it.

---

## 4. Agent loop (`packages/core/src/agent/agent.ts`)

- Drop the single accumulating `assistantTurnMessage` + shared `chunks` array
  (`agent.ts:786, 923-926`). Maintain a flat `log: LogChunk[]` (or emit via
  callback).
- Allocate `turnId` per `run()`. Write the user `text` chunk (`step:0`) at start.
- The step loop tags every appended chunk with `turnId` + current `step` index.
- Stream → log reduction (the new shared reducer, §5) emits `chunk-open` /
  `chunk-delta` / `chunk-seal`. On seal, persist (§6) and yield the WS event.
- Build requests with `chunksToModelMessages(log)` instead of `toModelMessages`.

### Interrupt handling change (bonus cache fix)

Today queued user messages are spliced **into** a tool result and later stripped
(`stripUserInterruptBlock`, `agent.ts:73`) — a history mutation that busts the cache.
New model: append the interrupt as its own `user/text` chunk **after** the step's
`tool_result` chunks. Append-only, immutable, cache-stable. `stripUserInterruptBlock`
and the "freshest tool batch" logic are deleted.

---

## 5. Stream→chunk reducer (`packages/core/src/chunks/append.ts` rewrite)

`appendEventToChunks` (mutates a `Chunk[]`) → a reducer that, given the current open
chunk + an `AgentEvent`, returns chunk-lifecycle ops:

- `text-delta` → open `text` if none open, else append; (thinking/tool start seals it).
- `reasoning-delta` → open/append `thinking`; `reasoning-end` → attach `metadata` + seal.
- `tool-call` → emit a sealed `tool_call` chunk immediately (no streaming body).
- `tool-result` → emit a sealed `tool_result` chunk.
- `error`/system notices → sealed single chunks.

Shared by backend (persist + WS) and frontend (apply WS), keeping wire format in
lockstep (the current symmetry contract).

---

## 6. Persistence (`db/messages.ts` → `db/chunks.ts`)

```ts
appendChunk(c: Omit<LogChunk,"seq"|"createdAt">): LogChunk     // allocates seq
getChunksForTab(tabId, { limit?, before? }): LogChunk[]        // seq paginate (DESC→reverse)
getTotalChunkCount(tabId): number
clearChunksForTab(tabId): void
```

Pagination mirrors current `getMessagesForTab` semantics but at chunk grain. Agent
persists each chunk **on seal**.

---

## 7. WS / event protocol

Replace `currentChunks` snapshot + `done.message` with:

- `chunk-open`  `{ id, seq, turnId, step, role, type }`
- `chunk-delta` `{ id, text }`
- `chunk-seal`  `{ id, data }`
- `turn-done`   `{ turnId }`  (status → idle; no payload reconstruction needed)

On WS reconnect, the frontend just refetches the tail via REST (§8) — no bespoke
snapshot needed. `TabStatusSnapshot` loses `currentChunks`/`currentAssistantId`.

---

## 8. API routes

- `GET /tabs/:id/messages` → `GET /tabs/:id/chunks?limit&before` → `{ chunks, total }`.
- Update WS broadcast to emit the §7 events.
- Audit other consumers of message endpoints.

---

## 9. Frontend store (`tabs.svelte.ts`)

- `tab.messages: ChatMessage[]` → `tab.chunks: LogChunk[]` (flat window) +
  `oldestLoadedSeq`.
- `applyChunkEvent` → apply `chunk-open/delta/seal` by `id`.
- `evictMessages` → `evictChunks`: drop oldest chunks beyond `chunkLimit`; pin the
  in-flight chunks + the last turn. **Now trims within a turn** — removes the
  `:360-372` caveat.
- `loadMoreMessages` → `loadMoreChunks` (page by `seq`).
- A `$derived` selector groups the flat chunk window → render groups
  `{ turnId, role, step, chunks[] }` for the view layer (no nested storage).

## 10. Frontend components

Chat view renders from the derived groups: user bubble, assistant bubble
(thinking/text/tool-calls), tool results paired by `callId`, system notices,
errors. Partial (half-paged) turns render as partial bubbles.

---

## Phasing (each phase compiles + tests green independently)

- **P0 — Schema/DB**: migration (drop messages, clear tabs), `db/chunks.ts`, tests.
- **P1 — Core wire builder**: types, stream reducer, `chunksToModelMessages` +
  normalizations + the 3-step stability regression test + caching-breakpoint tests.
  *(Delivers the cache fix in isolation.)*
- **P2 — Agent loop**: flat log, `turnId`/`step` tagging, interrupt-as-user-chunk,
  remove `stripUserInterruptBlock` + accumulating message.
- **P3 — Persistence wiring**: write-on-seal in agent-manager; pre-populate agent
  history from `getChunksForTab`.
- **P4 — Protocol/API**: §7 events, `/chunks` route, status snapshot trim.
- **P5 — Frontend store**: flat window, chunk-grain eviction, pagination, grouping.
- **P6 — Frontend components**: render from groups.
- **P7 — Cleanup**: delete `toModelMessages`, `messages` table refs, dead types;
  docs; full test pass (`bun run test`, `bun run check`).

## Test plan (highlights)

- **Cache stability (P1)**: 3-step turn; prior steps' ModelMessages byte-identical
  across builds. Breakpoints on `[system]`, `[assistant(step N), tool(step N)]`.
- **Reasoning retention (P1)**: empty-text + signature reasoning part is kept.
- **Pagination (P0/P5)**: `before`/`limit` windows; eviction trims within a turn and
  pins the live turn; scroll-up refetch.
- **Interrupt (P2)**: queued message becomes a trailing `user` chunk; no history
  mutation; prefix of earlier steps unchanged.

## Risks / watch-items

- **Anthropic ordering**: thinking must precede non-thinking in a turn — guaranteed
  by per-step grouping + seq order; assert in tests.
- **Many tiny rows**: one row per block (not per delta) keeps counts sane; index on
  `(tab_id, seq)` covers paginate/evict.
- **Signature round-trip**: thinking `metadata` must persist in `data_json` and
  replay verbatim.
- **Subagents**: confirm child-agent tabs use the same log path.
```
