# Server Crash Investigation — LSP Suspected

**Date:** 2026-06-27
**Investigator:** umans/umans-glm-5.2
**Checkout:** `dispatch/backend` on `dev` (commit `f9d1ca5`, working tree clean)

## TL;DR

The crash under investigation (Jun 28 00:12 JST) is **a Bun runtime
segfault**, not an LSP application crash. The three LSP issues the task
suspected (JSON-parse TypeError, fs.watch ENOENT, unbounded cache memory
leak) were **all already fixed** in commits `05ff256` (21:14) and `f9d1ca5`
(21:32), compiled into the binary at 21:40 — which is the binary that
crashed 2.5 h later. A separate, still-live **memory leak** (6.2 GB in 2.5 h
post-fix; 25.7 GB in 18 h pre-fix) fed memory pressure into Bun's
allocator and triggered the native crash. The leak is **not** in the LSP
caches (they are now bounded to ~50 docs + ~100 diag entries) — it is
elsewhere in the runtime (most likely AI-SDK streaming buffers / retained
conversation message arrays during long agent turns).

The task's premise ("there is an uncommitted hot-fix that disables LSP in
`host-bin`/`transport-http`") does **not** match the checkout. The working
tree is clean; LSP is fully enabled (not disabled); no `test_race.js`
exists. The developer chose to **fix** LSP rather than disable it.

---

## 1. What the logs actually show

### The crash (the event under investigation)

`systemctl status dispatch.service` (the service is named `dispatch.service`,
**not** `dispatch-server.service` — the latter does not exist):

```
Jun 28 00:12:02 dispatch-server[931590]: Bun v1.3.13 (bf2e2cec) Linux x64
Jun 28 00:12:02 dispatch-server[931590]: WSL Kernel v6.6.87 | glibc v2.43
Jun 28 00:12:02 dispatch-server[931590]: Args: "/usr/bin/dispatch-server"
Jun 28 00:12:02 dispatch-server[931590]: Elapsed: 9115307ms | User: 582013ms | Sys: 738525ms
Jun 28 00:12:02 dispatch-server[931590]: RSS: 0.02ZB | Peak: 0.29GB | Commit: 0.02ZB | Faults: 0 | Machine: 33.24GB
Jun 28 00:12:02 dispatch-server[931590]: panic(main thread): Segmentation fault at address 0x0
Jun 28 00:12:02 dispatch-server[931590]: oh no: Bun has crashed. This indicates a bug in Bun, not your code.
Jun 28 00:12:05 systemd[1]: dispatch.service: Main process exited, code=dumped, status=4/ILL
Jun 28 00:12:05 systemd[1]: dispatch.service: Failed with result 'core-dump'.
Jun 28 00:12:05 systemd[1]: dispatch.service: Consumed 1h 29min CPU over 2h 31min wall, 6.2G memory peak.
```

Key signals:

- **`panic(main thread): Segmentation fault at address 0x0`** — a NULL-pointer
  dereference **inside Bun's runtime**, not in dispatch code. Bun's own crash
  handler states "This indicates a bug in Bun, not your code."
- **Corrupted crash-time memory report.** `RSS: 0.02ZB` (zettabytes) and
  `Faults: 0` are impossible values; `Peak: 0.29GB` inside the dump contradicts
  systemd's cgroup accounting of `6.2G memory peak`. The crash corrupted the
  runtime state *before* the handler read its own stats — consistent with a
  heap corruption / use-after-free, not a clean NULL deref of a known address.
- **Signal mismatch.** Bun reports SIGSEGV ("Segmentation fault") but systemd
  recorded `status=4/ILL` (signal 4 = SIGILL, illegal instruction). Two
  different signals from one crash ⇒ the runtime was already corrupt when the
  trap fired. Classic signature of an allocator/GC corruption under memory
  pressure.
- **No coredump retained** (`coredumpctl list` → "No coredumps found";
  `/var/lib/systemd/coredump` empty), so the stack cannot be symbolicated
  locally. The redacted report URL is in the journal:
  `https://bun.report/1.3.13/l_1bf2e2ce…`.
- **Memory pressure was real.** systemd's cgroup (trustworthy) says the
  process peaked at **6.2 GB** over 2 h 31 m before dying — a ~2.5 GB/h growth
  rate from a fresh boot.

### Crash history (last 48 h) — two distinct failure modes

```
Jun 26 15:09  Failed exit-code   16h12m wall  3.4G peak   (app-level)
Jun 27 02:44  Failed exit-code    1h22m wall  3.1G peak   (app-level — crash loop begins)
Jun 27 02:51  Failed exit-code        7m wall  1.1G peak   (crash loop)
Jun 27 02:52  Failed exit-code       58s wall  700M peak   (crash loop)
Jun 27 20:58  Stopped (manual)   17h58m wall 25.7G peak   (huge leak, no crash)
Jun 28 00:12  SIGSEGV/SIGILL dump 2h31m wall  6.2G peak   (Bun segfault — THIS event)
```

The Jun 27 02:44–02:52 run is a **tight crash loop** (3 exits in 8 min with
collapsing uptime: 1h22m → 7m → 58s). These were `exit-code` failures
(**not** segfaults) — i.e. the application-level LSP crashes (JSON TypeError,
ENOENT). The only segfault in 5 days of logs is the 00:12 event, which
occurred **after** the LSP fixes were deployed.

---

## 2. The task premise vs. the actual checkout

The task described an **uncommitted hot-fix that disables LSP** in
`packages/host-bin/src/main.ts` and `packages/transport-http/src/extension.ts`,
plus an untracked `packages/lsp/src/test_race.js`. **None of this exists:**

- `git status` → "nothing to commit, working tree clean". No untracked files.
- `fd test_race` → no results. `test_race.js` does not exist anywhere.
- `git log -- packages/host-bin/src/main.ts packages/transport-http/src/extension.ts`
  → no "disable LSP" commit. LSP has only ever been **enabled** here.
- `host-bin/src/main.ts:24` imports `@dispatch/lsp`; line 104 includes `lspExt`
  in `CORE_EXTENSIONS`. LSP is **enabled**.
- `transport-http/src/extension.ts:98` calls `host.getService(lspServiceHandle)`
  with no try/catch — LSP is wired **straight-through**, not made optional.

What the developer actually did (commits `05ff256` @ 21:14 and `f9d1ca5` @
21:32) was **fix** the LSP crashes in place, then rebuild
(`/usr/bin/dispatch-server` mtime `2026-06-27 21:40:04`) and restart
(`Jun 27 21:40:06 Started`). The prior AI review that identified the three
bugs was committed alongside the fixes as `ai-review-report.md`.

---

## 3. The three suspected LSP issues — all already fixed

A committed prior review (`ai-review-report.md`, part of `05ff256`) names the
exact three issues the task raised. Each is fixed in the current tree:

### 3a. Unhandled JSON parse / TypeError (`client.ts`) — FIXED

`rpc.ts:89-99` wraps `JSON.parse` in try/catch (malformed/split-UTF-8 messages
are logged and skipped). The **fatal** bug, though, was the defence-in-depth
boundary in `client.ts`: when the language-server process died, `markBroken()`
set `this.rpc = null`; a final stdout flush then evaluated
`this.rpc?.handleMessage(msg).catch(() => {})` → short-circuits to
`undefined.catch()` → a **synchronous TypeError** that crashed the process.

**Fix** (`client.ts:310`): a second optional-chaining `?.`:
```ts
void this.rpc?.handleMessage(msg)?.catch(() => {});
```
`undefined?.catch()` → `undefined`, no throw. Covered by regression test
`handleBytes does not crash when the server dies and rpc is null (Bug 1)`.

### 3b. ENOENT from fs.watch on transient `.old_modules` dirs — FIXED

`extension.ts`'s recursive `node:fs.watch` emitted `'error'` events when
`bun install` deleted transient `.old_modules-*` directories. With no
`.on("error")` listener, Node/Bun escalates the event to an **uncaught
exception** that kills the process.

**Fix** (`extension.ts:100`): a no-op error listener swallows transient FS
errors:
```ts
watcher.on("error", () => { /* ignore transient FS errors */ });
```
Covered by `extension.test.ts` (the `__test__realFileWatcher` re-export lets
the behaviour be exercised with an injected fake watcher).

### 3c. Unbounded cache memory leak — FIXED (in LSP)

`LanguageServerClient` previously retained every touched file's text +
diagnostics forever in `openDocuments`, `lastDiagSnapshot`, and
`pushDiagnostics` (the documented "9.5 GB over 12 h" leak).

**Fixes:**
- `client.ts`: `MAX_OPEN_DOCUMENTS = 50` LRU — overflow evicts the
  least-recently-used doc via `textDocument/didClose` + purge
  (`evictIfOverCap`, `closeDocument`).
- `diagnostics.ts`: `MAX_PUSH_DIAGNOSTICS = 100` — background-scanned files
  (never opened by the agent) are evicted oldest-first
  (`evictPushIfOverCap`, delete-then-set for LRU recency).
- `markBroken()` now `clear()`s `openDocuments` + `lastDiagSnapshot` so a
  repeatedly-crashed/re-spawned client doesn't accumulate across cycles.
- Initialize timeout leak fixed: the timeout is now passed into
  `rpc.sendRequest` (which deletes the pending entry on expiry) instead of a
  `Promise.race` that left the original promise lodged in `pending` forever.

---

## 4. Root cause of the 00:12 crash

**The crash is a Bun runtime segfault, not an LSP bug.** Reasoning:

1. The binary that crashed (`/usr/bin/dispatch-server`, built 21:40:04)
   **contains all three LSP fixes** (commits 21:14 + 21:32 precede the build).
   So the known LSP crash paths were already closed.
2. The crash signature is a native `panic(main thread): Segmentation fault at
   address 0x0` emitted by **Bun's own crash handler**, which explicitly says
   "This indicates a bug in Bun, not your code." Application-level crashes
   (the pre-fix TypeError/ENOENT) exit with a JS stack trace and `exit-code`,
   not a native `code=dumped, status=4/ILL`.
3. The corrupted memory readout (`RSS: 0.02ZB`, `Faults: 0`, SIGSEGV-vs-SIGILL
   mismatch) points to **heap corruption in Bun's allocator/GC**, not a clean
   dereference of application state.

**The trigger is memory pressure from a still-live leak.** The post-fix binary
grew to **6.2 GB in 2.5 h** (the pre-fix session hit **25.7 GB in 18 h**). The
LSP caches are now bounded to ≤50 open documents + ≤100 diagnostic entries —
orders of magnitude too small to account for gigabytes. The leak is
**elsewhere**:

- `conversation-store` is **SQLite-backed** (`storage.get`/`set` via
  `StorageNamespace`), not an in-memory map — not the leak.
- `session-orchestrator`'s `activeConversations` is a `Set<string>` of IDs
  (tiny) — not the leak.
- Most likely culprits (not yet confirmed, out of investigation scope): the
  **AI SDK streaming buffers** and the **conversation message arrays assembled
  in memory** per turn (`orchestrator.ts` `for await (const event of
  provider.stream(...))`), which for long multi-step agent turns can hold large
  transcripts; plus Bun's standalone-executable memory reclamation under WSL.

So there are **two problems**, only one of which is fixed:

| Problem | Status | Failure mode |
|---|---|---|
| LSP app crashes (JSON TypeError, ENOENT) | ✅ Fixed (05ff256, f9d1ca5) | `exit-code`, crash loop |
| Memory leak → Bun segfault | ❌ Not fixed | native `code=dumped`, SIGSEGV/SIGILL |

---

## 5. Proposed fix (do not implement — investigation only)

The LSP work is done and correct; do **not** disable LSP. The remaining issue
is the memory leak that triggers the native crash. Recommended actions, in
priority order:

1. **Treat the leak as the primary defect, not LSP.** Open a separate
   investigation to localize the 2.5 GB/h growth. First step: add periodic
   `process.memoryUsage().rss` + `Bun.gc()` logging on a timer and correlate
   growth with active conversations/turns. Suspect the AI-SDK streaming path
   and per-turn message assembly in `session-orchestrator/orchestrator.ts`.
2. **Add a memory-pressure circuit breaker** to `dispatch.service` so a leak
   degrades gracefully instead of segfaulting: a watchdog that restarts the
   process on RSS exceeding a threshold (e.g. 3 GB), or systemd
   `MemoryHigh=`/`MemoryMax=` cgroup limits with a managed restart. This turns
   the uncontrolled segfault into a controlled recycle.
3. **File the Bun crash** at `https://bun.report/1.3.13/l_1bf2e2ce…` (the URL
   is in the journal). The corrupted RSS/signal readout is a Bun bug worth
   reporting regardless of our leak — a memory leak should not crash the
   runtime with a native segfault; it should OOM-kill cleanly.
4. **Consider a Bun upgrade.** The crash is on `Bun v1.3.13`; allocator/GC
   fixes land frequently. Pin and test a newer Bun in the standalone build.
5. **Keep the LSP fixes** (`?.catch()`, `watcher.on("error")`, bounded caches,
   `markBroken` clear, sendRequest timeout). They are correct and tested;
   disabling LSP would regress the diagnostics tool with no crash benefit,
   since the crash is not in LSP.

### Evidence summary

| Claim | Evidence |
|---|---|
| LSP fixes deployed before crash | binary mtime 21:40:04 > commits 21:14/21:32; service (re)started 21:40:06 |
| Crash is native, not app-level | `panic(main thread): Segmentation fault`, `code=dumped, status=4/ILL`, no JS stack |
| LSP caches bounded | `MAX_OPEN_DOCUMENTS=50`, `MAX_PUSH_DIAGNOSTICS=100` |
| Leak persists post-fix | 6.2 GB / 2.5 h (post-fix) vs 25.7 GB / 18 h (pre-fix) |
| Conversation store not the leak | SQLite-backed (`StorageNamespace`), not in-memory maps |
| No "disable LSP" hot-fix exists | clean tree; LSP enabled in `main.ts:104` + `transport-http:98`; no `test_race.js` |

### Contract gaps / change-requests for other units

- **session-orchestrator:** the per-turn streaming loop (`orchestrator.ts`
  `provider.stream(...)`) and message-assembly path are the prime leak suspect.
  Request a memory profile of a long multi-step turn to confirm whether
  buffers/arrays are retained after the turn completes. No contract change
  needed — this is an implementation/leak-localization request.
- **host-bin / systemd unit:** request a `MemoryMax=`/watchdog addition to
  `/etc/systemd/system/dispatch.service` (infra, not code).
