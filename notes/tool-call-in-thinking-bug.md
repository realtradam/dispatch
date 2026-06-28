# Bug Investigation: Tool Calls Appearing in Thinking + Turn Ends Abruptly

**Date:** 2026-06-28
**Conversation:** `1a997b08-09c2-412c-b296-48703c8aaf58`
**Model:** `umans-flash` (OpenAI-compatible endpoint at `https://api.code.umans.ai/v1`)
**Branch:** predev
**Investigation by:** umans/umans-glm-5.2 + Gemini 3.1 Pro (High) review

## Executive Summary

The model's tool calls appear as text inside a `thinking` chunk instead of being
parsed as structured `tool-call` chunks, and the turn ends abruptly. This is a
**regression** caused by a conversation-history reconstruction bug in
`conversation-store` that merges messages from different turns into a single
`user` message, producing a malformed prompt that confuses the model.

The root cause is that `append()` assigns `msgIdx` as a **local** index (reset to
0 for each append call), but `load()` groups chunks into messages using `msgIdx`
as if it were a **global** identifier. Since every single-message `append()` call
produces `msgIdx=0`, all chunks from consecutive user/assistant messages across
multiple turns collapse into one giant `user`-role message. The model receives a
corrupted conversation where its own prior assistant responses are labeled as
`user` content and its prior `tool-call` chunks are silently stripped (because
`convertUserMessage` only extracts `text` chunks). Bereft of structural context,
the model falls back to emitting tool calls as text inside `reasoning_content`,
which the stream parser routes to the `thinking` channel. Since no structured
`delta.tool_calls` is emitted, the kernel sees zero tool calls and ends the turn.

A secondary bug in `reconcile.ts` silently drops assistant messages that contain
only `thinking` chunks (no `text` or `tool-call`), causing the buggy output
itself to vanish on the next load.

## Root Cause Analysis

### Primary: `msgIdx` collision in conversation-store (`store.ts`)

**The bug:** `append()` assigns `msgIdx` as the index within the `messages`
array passed to each call:

```typescript
// store.ts append() — line 585
for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
  const msg = messages[msgIdx];
  // ...
  const entry: PersistedChunkEntry = { chunk, role: msg.role, msgIdx, chunkIdx };
```

Every `append()` call starts `msgIdx` at 0. The orchestrator calls `append()`
multiple times per turn:
1. `append([userMsg])` — user message → `msgIdx=0`
2. `onStepComplete([assistantMsg, ...toolResults])` — step output → `msgIdx=0,1,2...`

So every single-message append (the user message, or a text-only assistant
response) produces `msgIdx=0`. Only multi-message appends (assistant + tool
results) produce `msgIdx=1,2`.

**`load()`** then groups chunks by `msgIdx`:

```typescript
// store.ts load() — line 684
if (entry.msgIdx !== currentMsgIdx) {
  // start new message
  currentRole = entry.role;
  currentMsgIdx = entry.msgIdx;
}
currentChunks.push(entry.chunk);
```

Since all single-message-appended chunks share `msgIdx=0`, they collapse into ONE
message with the role of the first chunk (usually `user`).

### Verified with database evidence

Direct query of `.dispatch-data/dispatch.db` (the dev server's KV store):

```
seq=0000000001 role=user      msgIdx=0  type=text       "hello"
seq=0000000002 role=assistant msgIdx=0  type=thinking   "The user simply said hello..."
seq=0000000003 role=assistant msgIdx=0  type=text       "Hello! How can I help you today?"
seq=0000000004 role=user      msgIdx=0  type=text       "Can you read some files in this project"
seq=0000000005 role=assistant msgIdx=0  type=thinking   "The user is asking me to read files..."
seq=0000000006 role=assistant msgIdx=0  type=text       "I'd be happy to read files..."
seq=0000000007 role=user      msgIdx=0  type=text       "the caching, there are 3 different percentages displayed"
seq=0000000008 role=assistant msgIdx=0  type=thinking   "The user wants to look at files related to caching..."
seq=0000000009 role=assistant msgIdx=0  type=text       "Let me explore the project structure..."
seq=0000000010 role=assistant msgIdx=0  type=tool-call   run_shell (find ...)
seq=0000000011 role=assistant msgIdx=0  type=tool-call   run_shell (grep ...)
seq=0000000012 role=tool      msgIdx=1  type=tool-result run_shell (find output)
seq=0000000013 role=tool      msgIdx=2  type=tool-result run_shell (empty, error)
seq=0000000014 role=assistant msgIdx=0  type=thinking    "<function=run_shell>..." (BUGGY)
```

**All of seq 1–11 have `msgIdx=0`** — despite belonging to 6+ different
messages across 3 turns. Only the multi-message step append (seq 12–13) gets
`msgIdx=1,2`.

### Confirmed with a load() reproduction script

Running the actual `createConversationStore` + `load()` against the dev DB
produces **3 messages** instead of the expected ~9:

```
MSG[0] role=user   chunks=11  ← seq 1-11 ALL MERGED (user+assistant+user+assistant+...)
MSG[1] role=tool   chunks=1   ← seq 12
MSG[2] role=tool   chunks=1   ← seq 13
```

### What the model received (trace evidence)

The `provider.request` span in `.dispatch-data/traces.db` captured the verbatim
request body sent to the model for the buggy step (step 1 of turn 3). The
prompt body span confirms the malformed message structure:

```
MSG [0] role=user     6 chunks: hello + assistant-thinking + assistant-text
                              + user-text + assistant-thinking + assistant-text
MSG [1] role=user     1 chunk:  "the caching, there are 3 different percentages displayed"
MSG [2] role=assistant 4 chunks: thinking + text + 2× tool-call  (step 0 output)
MSG [3] role=tool      tool-result (find output)
MSG [4] role=tool      tool-result (empty, isError=true)
```

**MSG [0] is the corruption:** it has `role=user` but contains assistant
thinking + text chunks from turns 1 and 2. The model sees its own prior
responses as user-authored text. Its prior `tool-call` chunks (seq 10–11) are
in this merged blob with role `user` — and `convertUserMessage()` only extracts
`text` chunks, so the tool-call history is **silently stripped** from the
prompt entirely.

The model thus has no structural example of how to make tool calls in this
conversation. It falls back to text-based tool-call syntax (`<function=...>`)
inside `reasoning_content`, which the stream parser routes to the `thinking`
channel.

### Why the turn ended abruptly

In `run-turn.ts` (line 708–711):

```typescript
if (stepResult.toolCalls.length === 0) {
  finishReason = stepResult.finishReason;
  break;
}
```

The model emitted `finish_reason: "stop"` (confirmed in the trace:
`step` span with `finishReason:"stop"`). No structured `delta.tool_calls` was
in the SSE stream, so `toolCalls` was empty. The kernel interpreted this as
"the model is done" and sealed the turn with no tool execution and no final
text response.

### Tools WERE correctly registered

The request body confirms `toolCount: 9` — all 9 tools were sent in proper
OpenAI format (`{type:"function", function:{name, description, parameters}}`).
The bug is NOT a tool registration issue.

### Secondary: `reconcile.ts` drops thinking-only assistant messages

The `reconcile.repair` span in the traces DB confirms:

```json
{"repairedCount":0,"firstRepairedToolCallId":null,"strippedErrorChunks":0,"droppedEmptyMessages":1}
```

`reconcileWithReport()` Phase 2 drops assistant messages that have no `text` or
`tool-call` chunks:

```typescript
// reconcile.ts line 47-54
const hasContent = msg.chunks.some(
  (chunk) => chunk.type === "text" || chunk.type === "tool-call",
);
if (!hasContent) {
  droppedEmptyMessages++;
  continue;
}
```

An assistant message containing only a `thinking` chunk has
`hasContent === false` and is silently deleted. The buggy seq 14 output
(assistant, thinking-only) would be dropped on the next conversation load,
making the corruption even worse — the evidence of the bug disappears.

## Which File(s) Need Fixing

1. **`packages/conversation-store/src/store.ts`** — primary fix. The `msgIdx`
   assignment in `append()` and/or the grouping logic in `load()` must produce
   correct message boundaries.

2. **`packages/conversation-store/src/reconcile.ts`** — secondary fix. The
   `hasContent` check must recognize `thinking` chunks as valid content so
   thinking-only assistant messages are not silently dropped.

3. **`packages/openai-stream/src/convert-messages.ts`** — hardening (optional).
   `convertAssistantMessage` concatenates `thinking` and `text` chunks into a
   single `content` string. Wrapping thinking in explicit tags (or omitting it)
   would give the model cleaner structural context and reduce confusion.

## Proposed Fixes (do NOT implement — investigation only)

### Fix 1: Correct message grouping in `load()` (store.ts)

**Option A — split on role change too (minimal, pragmatic):**

```typescript
if (entry.msgIdx !== currentMsgIdx || entry.role !== currentRole) {
  // flush previous message, start new one
}
```

This splits messages whenever the role changes, even if `msgIdx` is the same.
It handles the common case (user → assistant → user) correctly.

**Option B — global msgIdx (proper fix):**

Track a per-conversation global message counter (persisted alongside `seqKey`)
so each message gets a unique, monotonically increasing `msgIdx` across all
append calls. This makes `msgIdx` a true message identifier rather than a
local index.

### Fix 2: Preserve thinking chunks in reconcile.ts

```typescript
const hasContent = msg.chunks.some(
  (chunk) =>
    chunk.type === "text" ||
    chunk.type === "tool-call" ||
    chunk.type === "thinking",
);
```

### Fix 3: (Optional) Wrap thinking in convert-messages.ts

```typescript
const content = textChunks.map((c) => {
  if (c.type === "thinking") return `<think>\n${c.text}\n</think>\n`;
  return c.text;
}).join("");
```

## Additional Notes

- This is a **regression** — the user confirms tool calls worked before recent
  merges. The `msgIdx`-based chunk storage was introduced in commit `44e2717`
  (June 6, "feat(wire,conversation-store): per-chunk seq sync cursor"). Before
  that, whole messages were stored (one per seq), so `load()` simply read each
  stored message as-is — no grouping bug was possible. The regression likely
  became visible when `onStepComplete` incremental persistence (commit
  `519b799`, "feat: incremental seq assignment during generation") started
  calling `append()` multiple times per turn (once per step) instead of batching
  all messages in a single `append()` call at the end.

- The model `umans-flash` correctly emitted structured `delta.tool_calls` in
  step 0 (seq 10–11 worked fine). The fallback to text-based tool calls only
  happened in step 1, after the model received the corrupted history (which
  lacked prior tool-call examples). This confirms the bug is in the history
  reconstruction, not in the model or the stream parser.

## Gemini Review

A Gemini 3.1 Pro (High) review was conducted in parallel. Its full report is at
`ai-review-report.md` (project root). Gemini independently confirmed the same
root cause (`msgIdx` collision) and the `reconcile.ts` thinking-drop issue, and
proposed the same `load()` role-change fix.
