# Code Review: Chunk-Native Frontend Eviction (Dispatch)

## Executive Summary

The rewrite to a chunk-native frontend store successfully resolves the unbounded memory pinning caused by oversized turns. The migration from grouped messages to a flat chunk log (`tab.chunks`) as the source of truth, with a decoupled `renderGroups` cache, correctly achieves rolling chunk-level eviction and seamless pagination. 

However, while the backend invariants and cache safety are perfectly maintained, there are two **Blocker** regressions in the frontend's reconcile logic relating to the handling of concurrent/queued messages and deferred UI updates. `reloadChunksFromApi` assumes it is strictly processing a single sequential turn and acts destructively on in-flight UI state when edge cases overlap.

**Verdict: DO NOT SHIP.** The cache invariant holds, but the Blocks must be fixed first. 

---

## Cache Safety Invariant

**VERDICT: SAFE.**
The diff contains **zero** modifications to `packages/core/src/agent/agent.ts`. The prompt-cache cohesion logic, `toModelMessages`, `applyAnthropicCaching`, and normalisation remain 100% server-side and entirely isolated from the frontend's transient render representations. Model-bound bytes are unchanged.

---

## Findings

### 1. Deferred reconcile wipes concurrent active turns (Block)
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:658` (`reconcileSealedTurn`) and `:636` (`reloadChunksFromApi`)

**Description:**
If the user scrolls up, automatic eviction and reconciliation are suppressed. If Turn A finishes while scrolled up, its reconciliation is deferred (`pendingReconcileTabs.add`). If the agent then starts Turn B (e.g. via queue processor), it establishes a new live streaming bubble (`liveTurnId = 'Turn B'`). 
When the user subsequently scrolls down, the deferred flush fires for Turn A, calling `reloadChunksFromApi`. This function blindly sets `live: []`, `liveTurnId: null`, and `currentAssistantId: null` — immediately deleting all in-flight chunks for the *currently active* Turn B. Turn B will then spawn a fresh disconnected live bubble on its next stream delta, permanently losing its prior chunks and its `turnId` tag (causing it to remount/flash on seal).

**Direction:** `reloadChunksFromApi` must not unconditionally nuke `live` and `currentAssistantId` if a *new* turn is actively in-flight (`agentStatus === "running" && liveTurnId !== turnIdToReconcile`). The reconcile must be turn-aware.

### 2. Optimistic queued user messages are dropped on reconcile (Block)
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:636` (`reloadChunksFromApi`)

**Description:**
When a user sends a message while the agent is busy, it is added to `tab.live` as an optimistic unsealed bubble. When the current active turn completes and emits `turn-sealed`, `reloadChunksFromApi` wipes the entire `live` array (`live: []`). The queued user message vanishes from the UI entirely. While it remains safely in `queuedMessages` and will eventually be processed by the backend, the UI will not reflect it again until its own eventual `turn-sealed` event completes the backend loop. 

**Direction:** `reloadChunksFromApi` must preserve unsealed optimistic user messages (e.g. those matching `queuedMessages` IDs) when clearing `live`.

### 3. Edge-case fetch race on WS reconnect desync (Ship-with-followup)
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:860` (`handleEvent` case `statuses`)

**Description:**
The backend emits `status: idle` immediately before making the synchronous SQLite `flushAssistant` write, and emits `turn-sealed` immediately after. If a WS reconnect happens exactly in this microsecond window, the frontend's `hydrateFromBackend` sees `backendStatus !== "running"` and triggers `reloadChunksFromApi`. Because the DB write hasn't landed, it loads a chunk window missing the just-finished turn.

**Direction:** This is non-fatal because the backend will still emit `turn-sealed` milliseconds later, which triggers a second `reloadChunksFromApi` that corrects the UI state. It will manifest as a sub-second flicker. Safe to ship, but ideally, `statuses` should infer completion from the presence of unpersisted chunks rather than the raw agent status.

### 4. Tool-batches undercount the live eviction budget (Nit)
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:76` (`countLiveChunks`)

**Description:**
In `countLiveChunks`, a single `tool-batch` render bubble counts as `1` against the live budget (`m.chunks.length`). However, upon sealing, `explodeTurn` expands each batch into `N * 2` rows (a `tool_call` and `tool_result` for each parallel call). This means an in-flight turn with heavily parallelized tool execution will temporarily consume more memory than `chunkLimit` targets.

**Direction:** Minor inconsistency. Once the turn seals, the correct DB row count will be respected. Acceptable trade-off for simplicity in the live rendering path.

### 5. `trimLiveChunks` drops the prompt under extreme pressure (Nit)
**Location:** `packages/frontend/src/lib/tabs.svelte.ts:431` (`trimLiveChunks`)

**Description:**
If a single streaming turn heavily exceeds `chunkLimit`, `trimLiveChunks` enforces a strict rolling window on `live`. Since it trims oldest-first indiscriminately, it will `shift()` away the user's prompt chunk from the UI entirely before it touches the assistant's streaming chunks. 

**Direction:** This technically aligns with the design ("never the chunk currently being streamed"), but means the user's initiating context disappears mid-stream under memory pressure. Expected behavior for a raw chunk limit.

---

## Notable Correctness Risks Validated

- **Seq Cursor Logic:** Perfect. `oldestLoadedSeq` rigidly derives from `ChunkRow.seq` via `minSeqOf(sealed)`. Live transient state is securely walled off from pagination logic.
- **Transaction Wrapper:** Sound. `db.transaction()` around the `appendChunks` batch is synchronously robust and correctly yields monotonic `seq` allocations per turn.
- **Scroll-up pagination:** Deduplication works flawlessly. `mergeChunksBySeq` efficiently handles overlap at the pagination boundary without duplicating message bubbles.
