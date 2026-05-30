# Changes

## May 27, 2026

### Chunk-Based Message Refactor (`ca6ee91`)

Replaced the flat `content: string` + `thinking: string` message model with an ordered
`chunks: Chunk[]` union that preserves actual temporal ordering of events from the model.

**New chunk types:**

| Type | Body | Emitted on |
|------|------|-----------|
| `text` | `text: string` | `text-delta` events, coalesced |
| `thinking` | `text: string` | `reasoning-delta` events, coalesced |
| `tool-batch` | `calls: Array<{id, name, arguments, result?, isError?, shellOutput?}>` | `tool-call` events, batched |
| `error` | `message: string, statusCode?: number` | Error events |
| `system` | `text: string, kind` | System notices (model-changed, config-reload, cancelled, rate-limit) |

**Key design decisions:**
- System events during active turn append inline to the assistant message's chunks
- System events outside turns create/append `role: "system"` messages
- `toCoreMessages` strips `error`/`system` chunks and `role: "system"` messages
- `MessageRole` changed from `user | assistant | tool` → `user | assistant | system`
- Tool calls/results embedded in `tool-batch` chunks, no separate `role: "tool"` messages

**Files changed:**
- `packages/core/src/types/index.ts` — `Chunk` union, `MessageRole` update
- `packages/frontend/src/lib/types.ts` — mirrored types
- `packages/core/src/chunks/append.ts` — `appendEventToChunks()` state machine + `applySystemEvent()` router
- `packages/core/tests/chunks/append.test.ts` — 35 unit tests
- `packages/core/src/db/index.ts` — removed `thinking` column from messages schema
- `packages/core/src/db/messages.ts` — updated `appendMessage`/`getMessagesForTab`
- `packages/core/src/agent/agent.ts` — single `chunks[]` accumulator, updated `toCoreMessages`
- `packages/api/src/agent-manager.ts` — progressive persistence, system event routing
- `packages/frontend/src/lib/tabs.svelte.ts` — unified `applyChunkEvent`, `openAgentTab` reads chunks
- `packages/frontend/src/lib/components/ChatMessage.svelte` — per-type chunk renderers
- `packages/frontend/src/lib/components/ToolCallDisplay.svelte` — prop updates

**Database:** Messages and tabs tables dropped; settings, keys, credentials preserved.
Backup at `~/.local/share/dispatch/dispatch.db.bak-20260527-181334`.

---

### Frontend Fixes

#### Wire-format drift (`5261879`)

`openAgentTab` expected `contentJson: string` on the wire but the API now returns
`chunks: Chunk[]`. Fixed to read `m.chunks` directly with `Array.isArray` fallback.

Also added diagnostic debug info to `copyConversation`: store state block
(connection status, agentStatus, message counts) and per-message chunk summaries.

#### structuredClone → $state.snapshot (`faeb8fe`)

Svelte 5 `$state` proxies throw `DataCloneError` on native `structuredClone()`.
Fixed by switching to `$state.snapshot()` in `applyChunkEvent` and `routeSystemEvent`.
This was the root cause of `chunks=0` in production — every content event after
placeholder creation silently failed.

#### WS error swallowing (`faeb8fe`)

`ws.svelte.ts` wrapped all callbacks in a single `try{} catch{}` that swallowed
errors. Split into per-callback try/catch with `console.error`. Future bugs of
this class are now diagnosable from the browser console.

#### statuses reconnect handler (`faeb8fe`)

Added `statuses` variant to `AgentEvent` union. On WS reconnect, handler syncs
`agentStatus` for all tabs, detects desync (frontend thinks running, backend says
idle/error), calls `reloadTabMessagesFromApi` to pull persisted chunks, and clears
`currentAssistantId` and streaming flags.

---

### Model Routing Fix (`9ac04b9`)

When a user selected a model (e.g., Gemini via configured key) but the corresponding
API key environment variable was not set, `getOrCreateAgentForTab` in `packages/api/src/agent-manager.ts:610`
set `useOverride = true` without updating `model` or `baseURL` from their defaults.
The request silently went to `https://opencode.ai/zen/go/v1` with `model: "deepseek-v4-flash"`
and no API key — OpenCode Go routed this to Claude, causing every model selection
to respond with "I'm Claude, made by Anthropic."

Fixed by setting `baseURL = key.base_url` and `model = effectiveModelId` in the
missing-key branch so requests target the correct endpoint and produce a diagnosable
auth error instead of a silent model-swap.

---

### Test Infrastructure Rewrite (`1e3f67e`)

Replaced the POJO (plain-old-JavaScript-object) test harness in `packages/frontend/tests/chat-store.test.ts`
with real `$state`-backed store instances via an exported `createTabStore()` factory
and `handleEvent()` method.

**What this catches that the old harness couldn't:**
- Logic bugs in the actual `handleEvent` / `applyChunkEvent` / `routeSystemEvent` code
- Drift between harness and production (now the same code)
- Reactivity contract issues with real `$state` proxies

**Known limitation:** The `structuredClone(svelteProxy)` bug cannot be reproduced in
these tests because Bun's `structuredClone` (used by vitest) is more permissive than
browser `structuredClone`. Catching that class of bug requires a browser-runtime test
layer (Playwright, vitest browser mode).

**Mocks:** `wsClient`, `config`, and `fetch` are mocked so module-load side effects
(WebSocket connection, localStorage access, HTTP calls) don't interfere.

**Files:**
- `packages/frontend/src/lib/tabs.svelte.ts` — exported `createTabStore`, added `handleEvent`
- `packages/frontend/tests/chat-store.test.ts` — 32 tests through the real reactive store

---

### Earlier: Read-System Fixes

#### Path resolution (`da57842`)

`read-file.ts`, `read-file-slice.ts`, `write-file.ts`, and `list-files.ts` used
`resolve(join(workingDirectory, path))` which mangled absolute paths (e.g.,
spill paths like `/tmp/dispatch/tool-results/...`). `join()` concatenates rather
than short-circuiting on absolute segments.

Fixed to use a shared `canonicalize()` helper in `packages/core/src/tools/path-utils.ts`
that resolves via `realpath` and walks up to the nearest existing ancestor when the
leaf doesn't exist (handles `write_file` creating new files through symlinked parent dirs).

#### DEFAULT_LIMIT alignment

Changed `DEFAULT_LIMIT` from 2000 → `MAX_LINES` (500) in `read-file.ts` so default
reads don't always trigger truncator spills.
