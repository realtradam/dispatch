# Plan — Non-blocking LSP diagnostics with "new issues" notices

Status: approved direction (user), ready to implement
Branch: `feature/lsp-async-diagnostics`
Packages touched: `lsp` (main), `tool-edit-file`, `tool-write-file`. No kernel change.
No frontend change required for v1.

---

## 1. Why

Today `edit_file` **blocks** after every write until each matching language
server pushes diagnostics (up to 10 s per server), then appends the full
diagnostic text to the edit result. Measured on this repo
(`typescript-language-server` 5.3.0, Biome 2.4.16):

| Server | Push actually arrives | `edit_file` returns today |
|---|---|---|
| TypeScript, `.ts` edit | ~390–420 ms | ~400–510 ms |
| TypeScript, first edit of a not-yet-open file | ~2.1–2.4 s | same |
| Biome | ~8–10 ms | ~103 ms (pure 100 ms poll quantization) |

Two defects in `LanguageServerClient.waitForDiagnostics`
(`packages/lsp/src/client.ts` ~L568):

1. **Polling.** It checks `hasReceivedPush` every 100 ms instead of resolving on
   the push — adds 0–100 ms to every wait, and a dead server is polled until the
   cap instead of failing immediately.
2. **Stale-push race (correctness).** It clears the "received" flag, sends
   `didChange`, then accepts *any* subsequent push. `typescript-language-server`
   sends **two** pushes after `didOpen` (observed at +2101 ms and +2229 ms) and
   **does not include `version`** in pushes (even with `versionSupport: true`).
   In a back-to-back test the edit after an open accepted a push ~100 ms after
   `didChange` — the late second push from the *previous* version — while the
   real result for the edit arrives at ~400 ms. Biome *does* send `version`.
   Neither server advertises pull diagnostics (`diagnosticProvider` undefined),
   so a pull-based fix is not available.

## 2. New behavior (user-specified)

1. **Never block edits on LSP.** `edit_file` / `write_file` write the file and
   return immediately. They *enqueue* a background diagnostics check for the
   file (local turns only — remote/`computerId` turns skip LSP as today).
2. **Queue + coalesce.** Checks are queued per (conversation, file). If the same
   file is edited again while a check is pending/in-flight, only the **latest
   content** matters — older checks are superseded (their results discarded).
3. **Notify only about NEW errors/warnings.** When a check completes and the file
   has errors/warnings that the agent has **not already been told about**, the
   agent gets a short notice saying **where and how many**, but **not what they
   are**. Example:

   ```
   [LSP] New issues detected:
   - packages/foo/src/bar.ts: 2 new errors, 1 new warning
   Call the `lsp` tool with operation "diagnostics" and the file path to read the full report.
   ```
4. **Delivery timing.**
   - Agent is mid-turn → notice is delivered at the **next tool-result boundary**
     (i.e. alongside the next tool call's results, before the next model step).
   - Agent's turn has ended (or ends before the check finishes) → a **new turn is
     started automatically** carrying the notice (user confirmed: yes).
5. **Full report on demand.** The `lsp` tool's `diagnostics` operation returns
   **all** current errors and warnings for the file (not just the new ones),
   served from the background check's result when it is fresh.

## 3. Design

### 3.1 Delivery mechanism — reuse `SessionOrchestrator.enqueue` (no kernel change)

`sessionOrchestratorHandle` (core, `packages/session-orchestrator/src/orchestrator.ts`)
already implements exactly the required semantics:

- `enqueue({ conversationId, text })` on an **idle** conversation → starts a turn
  with `text` as the opening message.
- On an **active** conversation → pushes onto the steering queue
  (`message-queue`), which the kernel drains at the **tool-result boundary**
  (`drainSteering`, `kernel/src/runtime/run-turn.ts` ~L872) and appends after the
  tool results.
- If the turn ends with the queue non-empty (no further tool call), the
  orchestrator's **post-seal carry** (`tryCarryQueue`, orchestrator ~L1372)
  starts a new turn with it.

`agent-management` already calls `orchestrator.enqueue` this way (precedent).
`lsp` is `standard`; depending on `session-orchestrator` (`core`) is allowed
(standard→core). Resolve it **lazily** (`host.tryGetService`) at notice time so
activation order doesn't matter and the feature degrades off if absent.

Known v1 trade-offs (accepted; note in report):
- The notice appears in the transcript as a user/steering message and briefly in
  the message-queue pane. Prefix it with `[LSP]` so it is clearly automated.
  A dedicated "system notice" rendering is a possible frontend follow-up.
- If `message-queue` isn't loaded, an active-turn notice is dropped (same
  degradation as user steering).

If, during implementation, the agent finds `enqueue` unsuitable (e.g. it must
carry a "source" marker), the fallback is a small, generic orchestrator seam
(a typed "turn notices" service that the orchestrator drains alongside steering
and checks in post-seal carry). That would touch `session-orchestrator`
(core) — **raise it to the user before doing it.**

### 3.2 Safety guards for auto-started turns (must have)

Auto-starting turns from a background process can surprise the user. Required:

- **Respect Stop.** If the conversation's most recent turn was **aborted** by the
  user, do not auto-start a turn for checks queued by that turn (drop or hold
  the notice until the user's next message — dropping is fine for v1).
- **Closed conversations.** Never enqueue for a closed conversation; drop its
  queued checks/state on `conversationClosed`.
- **Loop cap.** Cap consecutive LSP-initiated turns per conversation (e.g. 3)
  without an intervening user message; past the cap, stop auto-starting (still
  deliver mid-turn notices). Prevents edit→warning→turn ping-pong.
- **Coalesce notices.** At most one pending (not yet delivered) LSP notice per
  conversation. If newer checks land before delivery, replace it (use
  `cancelQueuedMessage` with the id from the enqueue snapshot, then re-enqueue
  the recomputed text). If the newer results mean there is nothing new to
  report, cancel it.

### 3.3 "New" issue detection (pure)

Track, per (conversationId, absolute file path), the **multiset of issues the
agent has been told about** (the "notified baseline").

- Issue identity must be **position-insensitive** — edits shift line numbers, so
  `diagnosticKey` (which includes the range) would make every shifted error look
  new. Use `(severity, source, code, message)` as identity and compare **counts**
  per identity: new = `max(0, currentCount − notifiedCount)` per identity.
- When a notice is enqueued, set the baseline to the current multiset for that
  file (so the same unfixed issue isn't re-announced). When a check shows an
  issue is gone, lower the baseline too (so if it comes back later it counts as
  new again).
- First check of a file in a conversation: baseline is empty → all current
  errors/warnings are "new" (the agent hasn't been told about them).
- Only severities 1 (error) and 2 (warning) participate (matches today's
  `minSeverity: 2`).
- Put this in a pure module (e.g. `packages/lsp/src/notices.ts`):
  `diffNewIssues(baseline, current) → { newErrors, newWarnings, nextBaseline }`
  and `formatNotice(perFileCounts, cwd) → string`. Unit-test heavily; zero mocks.

### 3.4 Background check queue (`packages/lsp`)

New module (e.g. `packages/lsp/src/check-queue.ts`), owned by the lsp extension:

- `queueCheck({ conversationId, filePath, text, cwd })` — returns immediately.
- Per (conversation, file): keep only the latest requested content. If a check
  is in flight, mark it superseded and run once more with the latest content
  after it finishes (or cancel if the client API allows) — never deliver a
  superseded result.
- Runs the existing concurrent aggregation (`aggregateDiagnostics`) over all
  connected servers matching the extension, with the existing 10 s per-server
  cap. Timed-out servers are skipped silently for notices (log them); the full
  report (3.6) still mentions a skipped server as today.
- On completion: store the **latest full result** per (conversation, file) for
  the report tool, run the pure diff (3.3), and if anything is new, update the
  pending notice and deliver via 3.1.
- Bound memory: cap tracked files per conversation (LRU, mirror the existing
  `MAX_OPEN_DOCUMENTS = 50` style) and purge on conversation close.
- Inject time/scheduler/enqueue as deps so the queue is testable without real
  servers (see AGENTS.md: effects at the edges, injected).

### 3.5 Fix `waitForDiagnostics` (still required — background results must be right)

In `packages/lsp/src/client.ts` + `diagnostics.ts`:

1. **Event-driven wait.** Add a waiter mechanism to `DiagnosticsStore` (resolve
   on `setPushDiagnostics` for the URI). Replace the 100 ms poll. Timeout stays
   10 s. `markBroken`/`shutdown`/`closeDocument` must **resolve pending waiters
   immediately** (as timed-out/failed) instead of leaving them to hit the cap.
2. **Version matching where available.** Set
   `publishDiagnostics.versionSupport: true` in `CLIENT_CAPABILITIES`, add
   `version?: number` to `PublishDiagnosticsParams`, and when a push carries a
   version, only accept `version >= the version just sent` for that document.
3. **Unversioned servers (TypeScript).** Must not accept a stale push from a
   previous document version. The observed source of stale pushes is the
   second push that follows `didOpen`. Pick and justify an approach, e.g.:
   - after a `didOpen`, treat the URI as "settling": accept a push only after
     no further push arrives for a short quiet window (~150 ms), so the second
     open-push is consumed before the result is taken; and/or
   - a per-URI generation counter: pushes that arrive before the most recent
     `didChange` was written belong to an older generation.
   Background checks make a small extra settle delay acceptable — the edit no
   longer waits on it.
   **Regression test (required):** reproduce the back-to-back race with a fake
   server that emits a delayed second push after `didOpen` and assert the edit's
   result reflects the *new* content.

### 3.6 Report tool — `lsp` operation `diagnostics` (`packages/lsp/src/tool.ts`)

- If the calling conversation has a background result for that file that is
  **fresh** (no newer edit since), return it immediately: **all** errors and
  warnings (full formatted list, same format as today), plus any
  "server skipped" notice.
- If a check for that file is pending/in-flight, wait for it (same 10 s cap)
  and return its result.
- Otherwise fall back to today's behavior (sync + wait).
- Make `path` optional for `diagnostics`: with no path, return the full report
  for **every file in this conversation that currently has errors/warnings**.
  (Requires `ctx.conversationId`; `ToolExecuteContext.conversationId` exists.)
- Update the tool description so agents know notices point here.
- Reading the report does not change the notified baseline (baseline is about
  what was *announced*; the report always shows everything).

### 3.7 Edit tools

- `packages/tool-edit-file`: replace the blocking `diagnostics` hook with a
  fire-and-forget call to the new LSP service method (e.g.
  `lspService.queueCheck(...)`), resolved reactively via
  `host.tryGetService(lspServiceHandle)` as today. The edit result no longer
  contains diagnostics. Remote (`ctx.computerId` set) → skip, as today.
  Must not throw or delay if LSP is absent/broken.
- `packages/tool-write-file`: add the same fire-and-forget call (it currently
  has no diagnostics at all; user wants checks on **every** file edit).
- Requires `ctx.conversationId`; if absent, skip queueing (no one to notify).

### 3.8 LSP service contract (`packages/lsp/src/types.ts`)

- Add `queueCheck(opts: { conversationId; filePath; text?; cwd }): void`.
- Keep `getDiagnostics` (used by anything else? check with `lsp references`)
  but it can now be implemented on the fixed wait. Remove the now-dead `slow`
  plumbing only if no consumer needs it.

## 4. Out of scope

- Language-server memory (~900 MB for tsserver) / lifecycle (idle shutdown).
- Edits made via shell (`sed`, codegen) — only `edit_file`/`write_file` trigger
  checks in v1.
- Frontend rendering of notices as a distinct "system" message.
- Fixing the broken Biome path in `~/.config/dispatch/dispatch.toml` (user config).

## 5. Tests (per AGENTS.md: strict pure core, lenient shell)

Pure (no mocks):
- `diffNewIssues`: first check = all new; same issues after shift (different
  ranges) = nothing new; one extra copy of an existing message = 1 new; issue
  disappears then reappears = new again; info/hint ignored.
- `formatNotice`: paths relative to cwd, counts/pluralization, multi-file.

Shell/integration (fake LSP process / fake client, fake clock, fake enqueue):
- Edit returns without awaiting the check (assert result before the fake server pushes).
- Coalescing: 3 rapid edits → only the last content's result is used/delivered.
- Mid-turn delivery path calls `enqueue` once with the formatted notice.
- Pending-notice replacement and cancellation when a newer clean result lands.
- Stop guard, closed-conversation purge, consecutive-turn cap.
- `waitForDiagnostics`: resolves on push (no 100 ms floor); resolves immediately
  when the server dies; version mismatch rejected; unversioned stale-push
  regression (3.5.3).
- `lsp diagnostics`: returns cached full report (all errors + warnings), waits
  for in-flight check, no-path variant lists all files with issues.

Manual end-to-end (run `bin/up` from `worktrees/lsp-async-diagnostics/` — stop
any running stack first; same ports):
- Edit a `.ts` file to introduce a type error, then call another tool → the
  next step receives the `[LSP]` notice with path + counts, no messages.
- Introduce an error as the *last* action and let the agent end its turn →
  a new turn starts with the notice.
- Call `lsp diagnostics` → full list (including previously-announced issues).
- Edit again without fixing → no repeat notice for the same error.

## 6. Verification gate

`bun install`, `bun run typecheck`, `bun run test`, `bun run test:bun` (if
touched), `bun run check` — all green. Commit to `feature/lsp-async-diagnostics`
only. Do not merge or push. Write the report per AGENTS.md "Reports".
