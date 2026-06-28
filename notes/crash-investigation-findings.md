# Production Crash Investigation — Findings

> **Definitive post-investigation record.** Supersedes `notes/memory-leak-investigation-handoff.md`
> (which contained three material errors — see §3). Authored by opencode (umans-glm-5.2) on
> 2026-06-28, incorporating an independent Gemini review (`crash-review-report.md`) whose pivotal
> finding (the SSH pool) overturned an earlier wrong conclusion.

**Last updated:** 2026-06-28
**Status:** Root cause of the **live** (1.3.14) crash is confirmed and fixable in Dispatch code.
The native segfault is **not** root-caused and may already be fixed by the 1.3.14 upgrade —
needs observation under real load.

---

## 0. TL;DR

- The production server was crash-looping (~20 restarts on Jun 28). **Two distinct failure modes.**
- **Live crash (Bun 1.3.14):** `exit-1 "Timed out while waiting for handshake"`. Root cause is a
  **Dispatch bug** in `packages/ssh/src/pool.ts`: the pooled `ssh2.Client` has **no permanent
  `'error'` listener** (it's removed after connect by `cleanup()`, pool.ts:266), so a post-connect
  ssh2 error emits `'error'` with no listener → uncaught → **no `process.on("uncaughtException")`
  guard in main.ts** → process exit-1. Fixable in Dispatch code; no runtime change needed.
- **Segfaults:** all on **Bun v1.3.13** (`Bun v1.3.13 (bf2e2cec)` printed at each). **Zero
  segfaults observed on 1.3.14** so far. Not root-caused; may be fixed by the upgrade.
- The prior "~2.5 GB/hour memory leak" framing is **wrong** (see §3). Idle memory is flat at 84 MB.
- **Recovery on restart** is repair-and-seal, not resume: conversations are swept `active→idle`
  and partial turns reconciled to a consistent state, but in-flight turns are sealed (user re-sends).

---

## 1. The live crash — SSH pool missing error listener (CONFIRMED, Dispatch bug)

### Crash signature (the only crash on the current 1.3.14 binary)
```
error: Timed out while waiting for handshake
      at emitError (node:events:51:13)
      at <anonymous> (/$bunfs/root/dispatch-server:16:75617)
Bun v1.3.14 (Linux x64)
→ Main process exited, code=exited, status=1/FAILURE
```
- 09:22:04 JST crash; last telemetry sample (09:21:52) showed `rss=116MB, activeConversations=4`.
- systemd reported 2.7 GB peak, but the crash was **exit-1 (self-exit), not OOM/SIGKILL** — memory
  was a symptom, not the kill trigger.

### Root cause chain
1. The error string `"Timed out while waiting for handshake"` is **ssh2's**, not Bun's TLS. It is
   hardcoded in `ssh2/lib/client.js:1114`:
   ```js
   this._readyTimeout = setTimeout(() => {
     const err = new Error('Timed out while waiting for handshake');
     this.emit('error', err);   // ← ssh2 emits 'error' on the ssh2.Client
     sock.destroy();
   }, this.config.readyTimeout);
   ```
   (Bun's own TLS string is the different `"TLS handshake timeout"` — confirmed via `strings` on
   the binary.)
2. In `packages/ssh/src/pool.ts`, `doConnect` attaches `client.on("error", onError)` **only during
   the connect promise** and removes it in `cleanup()` (pool.ts:266) on success. `buildConnection`
   (pool.ts:101-175) returns a long-lived `SshConnection` (keepalive 30s, idle-reap 15m) and
   **never attaches a permanent `'error'` listener** to the pooled client.
3. So after a successful connect, the `ssh2.Client` sits in the pool with no `'error'` listener. A
   later ssh2 error (re-handshake/re-key/keepalive timeout emitting the string above) →
   `emit('error')` → `emitError (node:events)` with no listener → EventEmitter default throws →
   uncaught.
4. `packages/host-bin/src/main.ts` has **only `SIGINT`/`SIGTERM` handlers** (main.ts:280-281) —
   **no `process.on("uncaughtException")` / `process.on("unhandledRejection")`**. So the uncaught
   error exits the process (exit-1), killing every in-flight turn — not just the one using SSH.

### Why capping concurrency is NOT the fix
A single pooled SSH connection dropping crashes the server regardless of how many turns are
concurrent. Capping `activeConversations` would only reduce frequency, not fix the root cause —
and it cripples a product built around concurrent agents. (The existing provider-concurrency
limiter, capped at 3-4, already bounds concurrent *provider streams*; SSH connections are
tool-execution connections and bypass it.)

### The fix (root cause)
1. **`packages/ssh/src/pool.ts` — `buildConnection`:** attach a permanent `'error'` listener to
   the `ssh2.Client` that tears down the connection, sets `state.value = "error"` /
   `state.error = <msg>`, and **logs** (computer alias, error message, connection state) so the
   failure is observable. Keep the existing connect-time `onError` for the connect promise.
2. **`packages/host-bin/src/main.ts` — boot:** add `process.on("uncaughtException")` and
   `process.on("unhandledRejection")` handlers that **log rich detail** (message, stack,
   `activeConversations` count, `process.memoryUsage()` snapshot, timestamp) so we know *where*
   they happen, then either survive (for non-fatal) or seal in-flight work + exit gracefully. This
   is the defense-in-depth that ensures any *future* unhandled error degrades instead of taking
   down the whole server and every in-flight turn.

---

## 2. The segfaults — NOT root-caused; 1.3.13 only (may be fixed on 1.3.14)

### Crash signature
```
panic(main thread): Segmentation fault at address 0x0
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
→ Main process exited, code=dumped, status=4/ILL
```
- **Every segfault was on Bun v1.3.13** (the log prints `Bun v1.3.13 (bf2e2cec)` at each:
  00:12, 00:45, 00:57, 08:50, 09:05).
- Memory peaks ranged widely: **370 MB** (09:05, 1-min uptime) up to 6.2 GB (00:12, 2.5h uptime).
- The 1.3.14 binary first ran at 09:06 JST. **No segfault has been observed on 1.3.14** — the only
  1.3.14 crash is the SSH exit-1 above. The current process has been stable idle.

### What this means
- The 370 MB segfault is **not memory exhaustion** (24 GB cgroup) — it's a native concurrency/race
  bug in Bun's runtime. No amount of memory bounding prevents a native race.
- The 1.3.14 upgrade **may** have fixed it; the sample so far is small and mostly idle, so this is
  **not confirmed**.
- **A native segfault cannot be caught by `process.on("uncaughtException")`** (that catches JS
  exceptions, not SIGILL/SIGSEGV). So if the segfault recurs on 1.3.14, the only complete fixes
  are: leave Bun (port to Node) or root-cause the native trigger (core dump → backtrace → repro →
  upstream Bun report).

### Plan for the segfault
1. Enable core-dump capture (`ulimit -c unlimited` / systemd `COREdump`) so the next segfault
   produces a backtrace rather than a bare `address 0x0`.
2. Run 1.3.14 under the real orchestrator workload (concurrent backend+frontend+subagent turns).
3. If no segfault recurs → likely already fixed; close the issue.
4. If one recurs → root-cause via the backtrace; do NOT paper over it with concurrency caps.

---

## 3. What was WRONG in the prior handoff (corrections)

`notes/memory-leak-investigation-handoff.md` was a careful document but contained three material
errors that this investigation corrected:

1. **"Telemetry is in journald — `journalctl | grep memory:periodic`."** Wrong. The logger writes
   to a **journal sink file** (`DISPATCH_JOURNAL=/var/log/dispatch/app.ndjson`, main.ts:139),
   not stderr/journald. The handoff's grep found nothing *by design* — the data was in the file
   all along. (Also: the observability-collector that would drain this file into `traces.db` is
   **disabled in compiled binaries** — main.ts:150 guards on a source path that doesn't exist in
   prod — so the journal just accumulates and rotates; only `app.ndjson` + `.1` are retained.)
2. **"The segfault persists on Bun 1.3.14" (handoff hypothesis #3 disproven).** Wrong. All
   segfaults were on **1.3.13**; no segfault has been seen on 1.3.14. The 1.3.14 upgrade may have
   fixed it — the handoff's hypothesis #3 is *not* disproven after all.
3. **"~2.5 GB/hour slow memory leak."** Wrong framing. Telemetry shows **idle is flat at 84 MB**
   (20+ min, zero reclaimable, zero growth) — there is no background/timer/closure leak. The
   "leak" was the live working set of concurrent multi-step turns, which is reclaimed when turns
   end. Moreover, raw context size is never GB-scale: 300k tokens ≈ 1-2 MB, so the gigabytes
   under load must come from pathological tool payloads, retention, or native bugs — not
   "unbounded context." (See §5.)

---

## 4. What was ruled out

- **Warm-cache probe** — confirmed (Gemini + my read) as a *latent* unhandled-rejection path
  (`createWarmService`'s `warm` has no try/catch around its `for await (provider.stream(...))` at
  orchestrator.ts:1276; `fireWarm` drops the promise with `void` at warmer.ts:130). **But it has
  never fired in production** — zero `cache-warming` activity in the journal, zero enabled
  conversations in the `kv` table (53k rows, all conversation settings; warming is opt-in default
  OFF). It is a latent risk worth fixing (the `unhandledRejection` guard from §1 catches its
  rejection too), but it is **not** the cause of any observed crash.
- **LSP** — exonerated (per handoff §7; caches bounded; disabled as a precaution, unrelated to
  crashes).
- **Idle/background leak** — refuted by telemetry (idle flat at 84 MB).
- **`activeConversations` cap as a fix** — rejected. It's a workaround that cripples the
  concurrent-agent product; the existing provider-concurrency limiter (3-4) already bounds
  provider streams. The root cause is the missing error listener + missing guard.

---

## 5. Memory: what actually drives GB-scale (and what doesn't)

The user's key insight: **300k tokens ≈ 1-2 MB** — raw context size is never GB-scale (capped at
single-digit MB by the context window). So "unbounded context → GB crash" is numerically wrong.
The only ways a turn reaches GB-scale:

1. **A pathological tool payload** — a single tool result that's itself hundreds of MB (huge
   file/log read). It enters `messages` unbounded and each step re-`JSON.stringify`s it (stream.ts:91)
   **plus** the `reqSpan` captures a second copy (stream.ts:112) → ~2× transient per step.
   **Tool-output bounding** directly prevents this (opencode caps at 50 KB / 2000 lines,
   offloading full text to a managed file — `packages/opencode/src/tool/truncate.ts`).
2. **O(N²) re-serialization across many steps**, only if GC can't keep up or there's retention.
3. **A genuine retention leak** (message arrays / spans / closures held after the step or turn) —
   accumulates per-turn over time (the 6.2 GB-over-2.5 h pattern). **Bounding context does NOT
   fix this** — the retained reference must be found. (Not yet investigated; the span's
   `bodyString` copy is written to the journal sink on disk, so it's likely transient, not
   retained — but unverified.)

**Dispatch vs opencode (context hygiene — NOT crash fixes):**
| Aspect | Dispatch | opencode |
|---|---|---|
| Mid-turn compaction | refuses during active conv (orchestrator.ts:1325) | compacts between steps near context window (llm.ts:210) |
| Tool result size in history | unbounded | bounded 50 KB / 2000 lines (truncate.ts) |
| Step limit | `MAX_STEPS = 0` (unlimited) | configured per agent; `MAX_STEPS_PROMPT` disables tools at last step |
| History sent to provider | full raw `messages` array | projected `toLLMMessages(...)` after compaction |

These are general hygiene improvements, **not** crash fixes (the live crash is the SSH bug; the
segfault is native). Tool-output bounding is the one with direct crash relevance (prevents
pathological-payload spikes). Compaction/max-steps do not reduce RAM for context the agent
genuinely needs.

---

## 6. Recovery behavior on restart (repair-and-seal, NOT resume)

When the server crashes and systemd restarts it:
- **`conversation-store/extension.ts:21-27`** — boot-sweep: lists all conversations with
  `status: ["active"]` and sets them to `"idle"`.
- **`store.ts:681`** — on load, `reconcileWithReport` repairs partial turns: synthesizes error
  results for orphaned tool-calls, strips error-only trailing assistant messages, drops empty
  messages. Emits a `reconcile.repair` span when repairs occur.
- **`heartbeat/heartbeat.ts:299`** — sweeps stale "running" runs to "stopped".

**Result:** the DB is always consistent after a restart (no broken conversations), but in-flight
turns are **sealed, not resumed** — partial assistant output is preserved (reconciled), the
conversation is marked idle, and the user must re-send. This is why the `uncaughtException` guard
matters: without it, one SSH error kills the process → **every** in-flight turn (not just the one
using SSH) is sealed and must re-send. With the guard, only the failing turn seals; the rest
continue.

---

## 7. Data artifacts & quick-reference

```bash
# Live state
systemctl status dispatch
systemctl show dispatch -p MemoryMax -p MemoryHigh          # 24G / 20G (live, applied)
curl http://localhost:24991/health                            # → {"ok":true}

# Telemetry lives HERE (not journald):
/var/log/dispatch/app.ndjson        # current process
/var/log/dispatch/app.ndjson.1      # rotated (older crash windows rotated away — only .1 kept)
# grep: rg 'memory:periodic|memory:gc' /var/log/dispatch/app.ndjson

# Journal (crash stacks):
journalctl -u dispatch --since '24 hours ago' | rg 'Main process exited|panic|Bun v'

# The two investigation docs:
notes/memory-leak-investigation-handoff.md   # prior (has the 3 errors in §3)
notes/crash-investigation-findings.md         # THIS file (definitive)
crash-review-report.md                        # independent Gemini review (found the SSH bug)

# Suspect code:
packages/ssh/src/pool.ts                      # buildConnection/doConnect — the crash
packages/host-bin/src/main.ts                 # missing uncaughtException guard
packages/kernel/src/runtime/run-turn.ts       # MAX_STEPS=0, streaming retry loop
packages/openai-stream/src/stream.ts          # JSON.stringify whole body + span copy
packages/session-orchestrator/src/orchestrator.ts  # warm probe (latent), activeConversations
```

## 8. Current fix scope

**In scope now (root-cause, Dispatch code):**
1. `packages/ssh/src/pool.ts` — permanent `'error'` listener on the pooled `ssh2.Client` + logging.
2. `packages/host-bin/src/main.ts` — `uncaughtException` + `unhandledRejection` guards with rich
   logging (message, stack, activeConversations, memory snapshot, timestamp).

**Deferred (separate decisions):**
- Tool-output bounding, mid-turn compaction, MAX_STEPS (general hygiene; not crash fixes).
- Warm-probe try/catch (latent; the `unhandledRejection` guard covers it for now).
- Port to Node (only if segfault recurs on 1.3.14 under real load).
- Core-dump capture setup (operational; do before the next load test).
