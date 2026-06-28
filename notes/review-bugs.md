# Code Review: workspace-star (backend)

**Branch:** `feature/workspace-star`  
**Commit reviewed:** `71c635f feat(workspace-star): starred workspace priority for concurrency limiting`  
**Compared to:** `dev` (`414080e`)  
**Reviewer:** `umans/umans-kimi-k2.7`  
**Date:** 2026-06-28  
**Scope:** Review only — no code changes committed.

---

## Executive Summary

The workspace-star feature itself (persisted workspace "star" toggle + priority scheduling in the provider concurrency manager) is conceptually sound and mostly correctly threaded through the monorepo:

- `@dispatch/wire` adds `starred` to `Workspace`.
- `conversation-store` persists and migrates legacy workspace rows.
- `provider-concurrency` queues starred-workspace waiters ahead of non-starred ones and re-sorts on star/unstar.
- `transport-http` exposes `PUT /workspaces/:id/star` and `DELETE /workspaces/:id/star`.

However, this branch also **reverts a large amount of unrelated crash-investigation work** that lives on `dev`, including production memory telemetry, an `uncaughtException`/`unhandledRejection` guard, and the LSP-disable precaution. That reversion is the single biggest issue and looks unintended given the commit title. There is also a failing test in `provider-wrapper.test.ts` and several smaller edge cases in the star-priority logic.

**Do not merge this branch as-is.**

---

## Verification Run

| Command | Result |
|---|---|
| `bun run typecheck` | ✅PASS |
| `bun run check` | ✅PASS (12 pre-existing Biome warnings, 0 errors) |
| `bun test packages/provider-concurrency/src/concurrency-manager.test.ts packages/conversation-store/src/store-workspace.test.ts packages/wire/src/index.test.ts` | ⚠️1/78 failed (see §1) |

The failing test is covered in detail below.

---

## Detailed Findings

### 1. BLOCKING — Test suite regression in `provider-wrapper.test.ts`

**File:** `packages/provider-concurrency/src/provider-wrapper.test.ts`  
**Test:** `wrapProviderWithConcurrency > releases the slot even when the stream throws`

```
error:
Expected promise
Received: [AsyncFunction]
      at packages/provider-concurrency/src/provider-wrapper.test.ts:102:16
(fail) wrapProviderWithConcurrency > releases the slot even when the stream throws
```

- The test asserts that `await expect(async () => { for await... }).rejects.toThrow("stream exploded")` throws when the wrapped async generator throws mid-stream.
- The failure message suggests the async function passed to `expect()` is not being recognized/produced correctly.
- This may be a Vitest/Bun async-generator interop issue, but it makes the test suite red on this branch.
- **Recommendation:** fix or replace the failing assertion before merge. The underlying `try/finally` release logic in `provider-wrapper.ts` looks correct, so this is likely an assertion-level problem.

### 2. MAJOR — Branch reverts unrelated crash telemetry & production mitigations

This branch removes or reverts important work that is present on `dev`. Because the commit title is `feat(workspace-star): starred workspace priority for concurrency limiting`, these changes appear to be accidental scope creep or a botched rebase.

- **Files deleted:**
  - `crash-review-report.md`
  - `notes/crash-investigation-findings.md`
  - `notes/memory-leak-investigation-handoff.md`
  - `bin/apply-memory-limits.sh`
  - `packages/host-bin/src/mem-telemetry.ts`
  - `packages/host-bin/src/mem-telemetry.test.ts`
- **Behavioral reversions:**
  - `packages/host-bin/src/main.ts`: removes `process.on("uncaughtException")` and `process.on("unhandledRejection")` guards; removes periodic memory telemetry; re-enables `import { extension as lspExt } from "@dispatch/lsp"`.
  - `packages/session-orchestrator/src/orchestrator.ts`: removes `getActiveConversationCount()`, `SessionOrchestratorDeps.sampleMemory`, and per-turn memory telemetry.
  - `packages/transport-http/src/extension.ts`: adds `"lsp"` to `dependsOn`, making the LSP extension required again.
- **Risk:** if merged, production loses: the cgroup memory-limit helper script; observability used to diagnose recent crashes; the unhandled-exception guard that prevents a single SSH error from killing the whole process; and the LSP-disable precaution that was added as a stability measure.
- **Recommendation:** strip these reversions out of `feature/workspace-star`. If removing crash telemetry is intentional, do it in a separate, explicitly titled commit/PR with rationale and operational sign-off.

### 3. MEDIUM — In-memory starred cache leaks IDs for deleted workspaces

**File:** `packages/provider-concurrency/src/concurrency-manager.ts`

- `starredWorkspaces` is a `Set<string>` populated by `notifyWorkspaceStarred(true)`.
- `setWorkspaceStarred(false)` deletes the ID from the set.
- However, `deleteWorkspace()` in the conversation store does **not** publish any event/hook to the concurrency manager, so a starred workspace that is deleted remains in the cache until process restart.
- Impact is small (a string per deleted starred workspace), but it is unbounded.
- **Edge case:** if a new workspace later reuses the same slug, it could inherit stale star priority.
- **Recommendation:** add a `notifyWorkspaceStarred(id, false)` call when deleting a workspace, or expose a hook that provider-concurrency can listen to. At minimum, document this minor leak.

### 4. MEDIUM — Stale in-memory priority when concurrency extension is absent

**File:** `packages/transport-http/src/app.ts` (lines 1513, 1535)

```ts
opts.concurrencyService?.notifyWorkspaceStarred(workspaceId, true);
```

- `transport-http` does **not** declare `provider-concurrency` in its manifest `dependsOn` (it is loaded opportunistically in `createApp`).
- If the concurrency extension is absent or disabled, the star toggle is persisted, but the in-memory priority cache is never updated. Already-queued agents will keep their old priority until a process restart seeds the cache.
- **Recommendation:** either add `provider-concurrency` to transport-http's `dependsOn` so the service is guaranteed, or emit a warning log when `notifyWorkspaceStarred` is skipped.

### 5. LOW — `notifyWorkspaceStarred` resolves waiters synchronously inside the HTTP handler

**File:** `packages/provider-concurrency/src/concurrency-manager.ts`, `notifyWorkspaceStarred`

- The method sorts every provider's queue and calls `tryGrantNext`, which can resolve queued acquisition promises.
- Those resolves happen while the transport request handler is still on the call stack.
- In practice this is fine because Promise resolution is queued as a microtask, but it is re-entrant and worth noting if future code adds side effects to resolution.
- **Recommendation:** no code change required unless maintainers prefer to defer granting to the next tick.

### 6. LOW — Star/unstar endpoints follow existing route conventions but introduce scheduling side effects

**File:** `packages/transport-http/src/app.ts` (lines 1499-1543)

- `PUT /workspaces/:id/star` and `DELETE /workspaces/:id/star` reuse the same slug validation and 500-error handling as other workspace routes.
- No additional auth/rate-limiting is added, which is consistent with the rest of the workspace API.
- Because these endpoints now affect runtime scheduling priority, a malicious or buggy client could flip-star workspaces rapidly to disturb queue ordering.
- **Recommendation:** acceptable if consistent with existing routes; otherwise gate star toggles behind the same authorization as workspace mutation.

### 7. LOW — `compareWaiters` does not tie-break equal `promptStartedAt`

**File:** `packages/provider-concurrency/src/concurrency-manager.ts`

```ts
function compareWaiters(a: QueuedWaiter, b: QueuedWaiter): number {
  const aStarred = isWorkspaceStarred(a.workspaceId);
  const bStarred = isWorkspaceStarred(b.workspaceId);
  if (aStarred !== bStarred) return aStarred ? -1 : 1;
  return a.promptStartedAt - b.promptStartedAt;
}
```

- If two agents have the same `promptStartedAt` and the same star status, JavaScript's stable sort preserves insertion order, so FIFO is still guaranteed.
- However, the comparator returns `0` in this case and relies on sort stability, which is true for modern engines but not obvious from the code.
- **Recommendation:** add an explicit tie-breaker (e.g., a monotonic enqueue sequence number) to make ordering deterministic across all runtimes and future proofs.

### 8. LOW/CONCERN — Default workspace can be starred

- `setWorkspaceStarred` allows starring `"default"`.
- This is probably intentional (default is just another workspace), but it means all unassigned/legacy conversations inherit star priority.
- **Recommendation:** confirm this is the intended UX. If not, add a guard mirroring `deleteWorkspace`'s prohibition on `"default"`.

### 9. POSITIVE — Backward compatibility is handled correctly

- `parseWorkspaceRow` treats absent or non-boolean `starred` as `false`, so legacy workspace rows load safely.
- `isWorkspaceStarred` is optional in `ConcurrencyManagerOpts`; tests verify that omitting it behaves like all workspaces are non-starred.
- `WorkspaceResponse` inherits `starred` through the `Workspace` / `WorkspaceEntry` types.
- The seeded activation path (`extension.ts`) guards `listWorkspaces()` with try/catch and logs warnings, degrading cleanly if the store is unreachable.

---

## Merge Checklist

Before merging `feature/workspace-star`:

1. **Fix or disable the failing `provider-wrapper.test.ts` test.** Do not leave the suite red.
2. **Remove the unrelated crash-telemetry/LSP reversions** from this branch, or move them to a separate explicitly labeled commit/PR.
3. Consider: clearing the starred cache when a workspace is deleted.
4. Consider: declaring `provider-concurrency` as a hard dependency of `transport-http` if star scheduling is a first-class feature, or logging a warning when the optional service is absent.
5. Confirm UX intent: can `"default"` be starred?

---

## Note

This review was generated from `git diff dev..HEAD` on the `feature/workspace-star` worktree. No source code was modified.
