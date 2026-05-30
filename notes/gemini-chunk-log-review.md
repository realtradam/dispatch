# Review: Append-Only Chunk-Log Refactor

## Executive Summary

The refactor successfully transitions the codebase from a "message-as-container" model to a flat, append-only **chunk log**. This is a major structural improvement that enables granular pagination and addresses the primary root cause of Anthropic prompt-cache churn by segmenting multi-step turns into stable message pairs.

**Status: Partially Correct.**
-   **Goal 1 (Cache Fix):** **Achieved for happy-path turns**, but **broken for turns involving user interrupts**. The planned "New model" for interrupts (append-only user chunks) was not implemented; the legacy mutation-based stripping remains in `agent.ts`, which continues to bust the cache prefix across steps when an interrupt occurs.
-   **Goal 2 (Flat Storage/Pagination):** **Fully Achieved.** The explode/group transforms are robust, lossless, and handle window boundaries correctly via `turnId` merging in the frontend.

---

## Findings & Questions

### 1. Cache Stability
**Severity: Should-Fix**
The implementation of `toModelMessages` (`agent.ts:162`) correctly segments assistant turns into stable `[assistant, tool]` pairs per step. However, the **interrupt logic** (`agent.ts:241`) reintroduces instability. 
-   In Step 1 of a turn, an interrupt is marked "freshest" and included in the Step 1 `tool` message.
-   In Step 2, that same Step 1 `tool` message is now "stale" and has the interrupt stripped.
-   **Result:** The serialized content of Step 1 changes between Request 1 and Request 2, shattering the Anthropic cache prefix for everything following the Step 1 text.
-   *Reference:* `packages/core/src/agent/agent.ts:241-247` and `packages/core/src/agent/agent.ts:80-86`.

### 2. Explode/Group Fidelity
**Severity: Verified Correct**
The round-trip between `Chunk[]` and `ChunkRow[]` is lossless.
-   `explodeTurn` correctly splits `tool-batch` into paired `tool_call` and `tool_result` rows.
-   `groupRowsToMessages` correctly reconstructs turns using `turnId` and `step`, and gracefully handles orphan `tool_result` rows by creating synthetic entries in the batch. This is vital for pagination.
-   *Reference:* `packages/core/src/chunks/transform.ts`.

### 3. Step Derivation
**Severity: Verified Correct**
The assumption that a `tool-batch` marks the end of an LLM step is consistent with the `Agent.run()` loop. The `step` increment in `explodeTurn` (`transform.ts:89`) and the segmentation in `toModelMessages` (`agent.ts:251`) are in sync.

### 4. Migration Safety
**Severity: Verified Correct**
The migration in `db/index.ts` correctly detects the legacy `messages` table and performs a one-shot nuke of messages/tabs.
-   It is safe for repeat runs (idempotent check on `sqlite_master`).
-   Tests are safe as they mock `getDatabase()` and use in-memory fakes.
-   *Reference:* `packages/core/src/db/index.ts:106-118`.

### 5. Persistence Correctness
**Severity: Verified Correct**
The "Write-on-seal" strategy is correctly implemented. 
-   `processMessage` accumulates chunks in memory and flushes exactly once via `flushAssistant()` when the turn settles.
-   The fallback-retry path correctly avoids calling `flushAssistant()` for failed attempts, preventing partial/duplicate turns in the log.
-   *Reference:* `packages/api/src/agent-manager.ts:1081-1085` and `:1168`.

### 6. Rebuild Correctness
**Severity: Nit**
`getMessagesForTab` fetches the *entire* chunk log for a tab to rebuild the Agent's in-memory history. For very long conversations (thousands of chunks), this will cause increasing latency and memory pressure whenever an Agent is reconstructed (e.g., on model switch).
-   *Reference:* `packages/core/src/db/chunks.ts:121`.

### 7. Pagination Correctness
**Severity: Verified Correct**
Frontend pagination correctly handles turns split across the 50-chunk window.
-   `loadMoreMessages` in `tabs.svelte.ts` detects `turnId` + `role` matches at the boundary and merges the chunks.
-   This ensures that scrolling up restores the "tail" of a turn and prepends the "head" seamlessly.
-   *Reference:* `packages/frontend/src/lib/tabs.svelte.ts:445-467`.

### 8. Interrupt Handling
**Severity: Blocker (for Caching Goal)**
The refactor failed to implement the "New model" described in `plan-chunk-log.md` (Section 4). 
-   The plan called for interrupts to be appended as their own `user/text` chunks, making history immutable.
-   The implementation instead kept the legacy `[USER INTERRUPT]` string injection and the unstable `stripUserInterruptBlock` logic.
-   This preserves the cache-churn bug for any session involving interrupts.
-   *Reference:* `packages/core/src/agent/agent.ts:162-256`.

### 9. Anthropic Wire Validity
**Severity: Verified Correct**
-   `applyAnthropicStructuralNormalisations` correctly handles Anthropic's strict requirements, including splitting assistant messages if tool-calls are followed by text (Pass 3) and scrubbing tool IDs (Pass 2).
-   Empty reasoning blocks are stripped to avoid API errors while maintaining the signature in the DB for future turns.

---

## Verified Correct
The following components were reviewed and found to be implementation-perfect:
-   **`packages/core/src/chunks/transform.ts`**: Pure logic for flattening and re-grouping.
-   **`packages/core/src/db/chunks.ts`**: Monotonic `seq` allocation and pagination queries.
-   **`packages/api/src/routes/tabs.ts`**: Cursor-based history endpoint.
-   **`packages/core/src/agent/agent.ts`**: `applyAnthropicCaching` breakpoint placement.

---

## Recommendations

1.  **Fix Interrupt Immutability (High Priority):** Follow the original plan: remove `USER_INTERRUPT_MARKER` injection into tool results. Instead, when an interrupt is dequeued in `Agent.run()`, append it as a new `user` role chunk to the log *after* the current step's tool results. Remove the stripping logic from `toModelMessages`. This makes the prefix 100% stable.
2.  **Explicit Transactions in `appendChunks` (Nit):** Wrap the loop in `appendChunks` (`db/chunks.ts:40`) in an explicit `db.transaction()` to ensure atomicity and improve performance for large turns.
3.  **Optimize History Rebuild (Nit):** Consider limiting the history rebuild in `getOrCreateAgentForTab` to the last N turns or the last M chunks, rather than the entire history, to bound startup time for long-lived tabs.
4.  **Tab-level Lock in `processMessage` (Nit):** Add a primitive lock or a "running" check at the start of `processMessage` to prevent concurrent execution on the same tab, which could otherwise corrupt the `tabAgent` state or the chunk log if two turns are interleaved.
5.  **Update `eviction-limitation.md`**: The document accurately reflects that eviction is still whole-message; this remains a valid technical debt item.
