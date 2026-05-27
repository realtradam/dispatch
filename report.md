# Background Agents + Layout Restore Review

## Verdict
SHIP

## Block-level findings
None. The implementation adheres strictly to the `plan-bg-restore.md` specification across all tiers (core, API, and frontend).

## Ship-with-followup findings
None.

## Nits
None.

## What was checked
- **A. getAllStatuses correctness**: PASS. The method in `packages/api/src/agent-manager.ts:714-751` returns `Record<string, TabStatusSnapshot>`. It conditionally includes `currentChunks` and `currentAssistantId` only for `running` tabs and performs a defensive shallow copy `[...tabAgent.currentChunks]`.
- **B. Frontend TabStatusSnapshot mirror**: PASS. `packages/frontend/src/lib/types.ts:96-100` mirrors the core interface exactly.
- **C. hydrateFromBackend**: PASS. `packages/frontend/src/lib/tabs.svelte.ts:432-562` implements the full hydration flow (GET /tabs -> GET /status -> parallel GET /tabs/:id/messages). It handles failure modes without throwing, implements the required idempotency check (`tabs.length > 0`), and correctly seeds in-flight messages.
- **D. WS statuses handler**: PASS. `packages/frontend/src/lib/tabs.svelte.ts:581-644` reconciles status, seeds in-flight chunks for running tabs, and clears pointers for idle tabs. The desync recovery path (`reloadTabMessagesFromApi`) is preserved.
- **E. App.svelte onMount**: PASS. `packages/frontend/src/App.svelte:78-105` sequences `hydrateFromBackend` before the fallback `createNewTab` and only creates a fresh tab if hydration yields nothing. WS connection lifecycle is preserved.
- **F. Behavior preservation**: PASS. No new `beforeunload` or `unload` handlers were added. WS `onClose` in `packages/api/src/index.ts:60-66` correctly only unsubscribes. Explicit tab close in `tabs.svelte.ts` still calls `DELETE /tabs/:id`, which cancels and archives as before.
- **G. Test coverage**: PASS. 
    - API tests in `agent-manager.test.ts` cover empty state, idle snapshot, running snapshot, and defensive copy.
    - Frontend tests in `chat-store.test.ts` cover successful restore, in-flight seeding, failure tolerance, and idempotency.
- **H. Race conditions**: PASS. `hydrateFromBackend` idempotency and the per-tab reconcile logic in the WS handler mitigate potential races between HTTP and WS data.
- **I. Wire-shape symmetry**: PASS. The frontend mirror matches the core definition.
- **J. Type-only vs runtime imports**: PASS. `agent-manager.ts:40` uses `type TabStatusSnapshot`.

## What was NOT checked
- Performance with extremely high tab counts (>100) was not verified empirically, though the implementation uses `Promise.all` for message fetching to minimize latency.
- Direct database state verification (the review was limited to code analysis and existing test coverage).
