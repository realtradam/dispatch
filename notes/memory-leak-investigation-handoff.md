# Memory-Leak Investigation — Handoff for OpenCode Agent

> **Purpose:** This document gives an OpenCode harness agent — running outside
> the Dispatch system, with no prior context — everything needed to
> independently investigate the memory leak that is crashing the production
> Dispatch server. Read it top to bottom before touching anything.

**Last updated:** 2026-06-28
**Author of this handoff:** umans/umans-glm-5.2 (Dispatch agent)
**Originating investigation:** `notes/server-crash-investigation.md` (commit `b83aa8d`)

---

## 0. TL;DR — what you are here to do

The production Dispatch server leaks memory at **~2.5 GB/hour** and eventually
hits a **Bun runtime segfault** (native crash, not a JS exception). A prior
investigation already ruled out LSP as the cause. Your job is to **find where
memory is being retained** and propose a fix. There are four undeployed commits
on the `dev` branch that add memory telemetry and a cgroup circuit breaker —
**those need to be built, installed, and observed first** to get the data that
will localize the leak. Do not start code-diving blindly; deploy the telemetry,
collect a crash cycle, then read the logs.

---

## 1. System Overview — what Dispatch is

Dispatch is an **AI agent orchestration platform**: a backend that runs one or
more AI "agents" through turns (each turn = a step loop of model calls +
tool dispatch), plus a separate frontend that consumes the backend's typed
contracts over HTTP + WebSocket.

**Repo layout** — all under `/home/tradam/projects/dispatch/`:

| Path | What | Git remote | Branch |
|---|---|---|---|
| `backend/` | The server (this codebase) | `git@github.com:realtradam/dispatch.git` | `dev` |
| `frontend/` | The web UI (separate repo, same methodology) | `git@github.com:realtradam/frontend.git` | `dev` |
| `worktrees/` | Per-task git worktrees for isolated feature branches | (varies) | (varies) |
| `bin/` *(inside backend)* | Operational shell scripts (build, install, up, secrets, certs) | — | — |

Both repos use **`dev` as the active development branch**. The backend is a
**Bun + TypeScript** monorepo (project references via `tsc -b`, Biome for
lint/format, Vitest for tests, `bun:sqlite` for storage, the `ai` /
`@ai-sdk/*` packages for model providers). Architecture rules are in
`backend/AGENTS.md` — **read it** before editing (especially the "kernel
touches no I/O" and "no ambient state" rules).

---

## 2. Where things are installed (production)

| Artifact | Path | Notes |
|---|---|---|
| Production server binary | `/usr/bin/dispatch-server` | Bun **standalone compiled** binary. Currently the OLD one (built Jun 27 21:40). Not you to install — see §6. |
| CLI binary | `/usr/bin/dispatch` | `dispatch send/list/read/...` |
| Frontend static files | `/usr/share/dispatch/web/` | Built by `bin/build` (Vite, `VITE_HTTP_PORT=24991 VITE_WS_PORT=24990`) |
| Config / env file | `/etc/dispatch/env` | `EnvironmentFile` for systemd. **Root-readable only** (`Permission denied` for non-root). Source template in repo: `systemd/dispatch.env` (installed by `bin/setup-env`). |
| Data directory | `/var/lib/dispatch/` | WorkingDirectory of the service. SQLite DBs live here: `dispatch.db`, `dispatch.db-shm`, `dispatch.db-wal`. |
| Logs | the journal | `journalctl -u dispatch` — there are no log files on disk; everything goes to journald. |
| systemd unit (live) | `/etc/systemd/system/dispatch.service` | Installed from the repo template `systemd/dispatch.service` by `bin/install`. |
| systemd unit (repo template) | `backend/systemd/dispatch.service` | **Edit this one**, not the live file — `bin/install` copies it over. |
| Install script | `backend/bin/install` | Builds + installs the binary, unit, env, frontend. Uses `sudo` on privileged lines only (the agent has no sudo — hand scripts to the user). |
| Build script | `backend/bin/build` | `tsc --build` then `bun build --compile` → `dist/dispatch-server`. |
| Memory-limits script | `backend/bin/apply-memory-limits.sh` | Applies `MemoryHigh`/`MemoryMax` to the live service. **User has NOT run it yet.** |

---

## 3. Production ports

| Service | Port | Confirmed |
|---|---|---|
| HTTP API | **24991** | `BACKEND_PORT=24991` in `systemd/dispatch.env` (set by `bin/setup-env`). Live: `ss -tlnp` shows `dispatch-server` listening on `*:24991`. |
| Surface WebSocket | **24990** | `SURFACE_WS_PORT`. Live: `ss -tlnp` shows `dispatch-server` listening on `*:24990`. |

The **dev** stack (`bin/up`) uses different ports: **24203** (HTTP) + **24205** (WS) + **24204** (frontend Vite dev server). Don't confuse dev ports with prod ports.

**Health check:** `curl http://localhost:24991/health` → `{"ok":true}`

---

## 4. How to access the running server

```bash
# Is it running?
systemctl status dispatch

# Live logs (follow)
journalctl -u dispatch -f

# Recent crashes / errors (last 2h)
journalctl -u dispatch --since '2 hours ago' -n 200

# Memory telemetry — ONLY visible once the new binary is deployed (see §6).
# The EXACT log tags to grep (NOT "[mem-telemetry]" — that is the module name):
journalctl -u dispatch -f | rg 'memory:periodic|memory:gc'

# Restart (needs root — hand to the user)
sudo systemctl restart dispatch
```

> **The service is named `dispatch`, NOT `dispatch-server`.** The binary is
> `dispatch-server`; the systemd unit is `dispatch.service`. This mismatch
> tripped up the first investigation — don't repeat it.

The backend checkout at `/home/tradam/projects/dispatch/backend/` is on `dev`
and contains the source. The running binary is compiled, so **editing source
does nothing until you rebuild + install + restart** (§6).

---

## 5. The memory leak — what we know

### 5.1 Symptom & crash signature

- The server grows **~2.5 GB/hour** under load, eventually triggering a **Bun
  runtime segfault** (native crash).
- **Last crash:** Jun 28 00:12 JST.
  ```
  panic(main thread): Segmentation fault at address 0x0
  oh no: Bun has crashed. This indicates a bug in Bun, not your code.
  Main process exited, code=dumped, status=4/ILL
  ```
  RSS was **6.2 GB** at crash (over 2h31m uptime). A prior session hit
  **25.7 GB over 18h**.
- The crash is a **native segfault inside Bun's runtime** (NULL deref in the
  allocator/GC), NOT a JS exception. The crash-time memory readout was itself
  corrupted (`RSS: 0.02ZB` — impossible), and systemd saw SIGILL while Bun
  reported SIGSEGV — both signs of **heap corruption under memory pressure**.
- This is the **only** segfault in 5 days of logs. Earlier crashes (Jun 27
  ~02:44–02:52) were `exit-code` failures = application-level LSP bugs, **now
  fixed** (see §7).

### 5.2 What it is NOT

- **NOT LSP.** The Language Server Protocol extension was the original prime
  suspect; it is exonerated. Its caches are bounded (`MAX_OPEN_DOCUMENTS = 50`,
  `MAX_PUSH_DIAGNOSTICS = 100` — see `packages/lsp/src/client.ts:153` and
  `diagnostics.ts:47`). 50 docs + 100 diag entries cannot explain gigabytes.
- **NOT the conversation store.** `packages/conversation-store` is
  **SQLite-backed** (all reads/writes go through a `StorageNamespace` to
  `bun:sqlite`) — it does not hold conversations in an in-memory map.
- **NOT `activeConversations`.** The session-orchestrator's
  `activeConversations` is just a `Set<string>` of conversation IDs (tiny).

### 5.3 Prime suspects (not yet confirmed — that's your job)

1. **The AI-SDK streaming path** — the `async` generator returned by
   `provider.stream(...)` (`@ai-sdk/*`, including the `openai-stream` package).
   Streaming response buffers may be retained if the generator is not fully
   drained or if the SDK holds internal buffers per request.
2. **Per-turn message arrays** in `session-orchestrator` — the history +
   `userMsg` + `providerMessages` arrays assembled before each
   `provider.stream(...)` call. For long multi-step agent turns these can be
   large; if references outlive the turn (closures, unresolved promises, event
   listeners), they leak.
3. **A Bun bug fixed in 1.3.14.** The crash was on Bun **v1.3.13**. Bun 1.3.14
   has been built locally but not installed (§6.3) — deploying it may itself
   resolve the segfault even if a leak remains.

### 5.4 Key files to examine (the leak-suspect code path)

| File | What's there | Why it matters |
|---|---|---|
| `packages/session-orchestrator/src/orchestrator.ts` | `runTurnDetached()` at **line 541** — kicks off a turn; the `activeConversations.add/delete` around it (556, 979) brackets the turn lifecycle. | Turn lifecycle: where memory should be acquired and released. If a turn's buffers aren't released here, it leaks per-turn. |
| `packages/session-orchestrator/src/orchestrator.ts` | `for await (const event of provider.stream(messages, assembled.tools, providerOpts))` at **line 1276** (and a second one at **1430** for compaction/summary). | **The streaming loop** — the #1 suspect. This is where the AI-SDK async generator is consumed. If the generator is abandoned mid-stream (error, `break`, abort) or its internal buffers are retained, memory grows per turn. |
| `packages/session-orchestrator/src/pure.ts` | The pure turn/step decision logic + the `MemorySample`/`memoryDelta`/`memorySampleAttributes` helpers used by telemetry. | The per-turn before/after sampling wraps the stream boundary (referenced by `mem-telemetry.ts`). |
| `packages/kernel/src/runtime/run-turn.ts` | The **step loop** (`runTurn`) — one agent turn = N steps of (model call → tool dispatch → feed results back). | MAX_STEPS is disabled (`0 = unlimited`, commit `e8b4bf1`), so a single turn can run many steps. Many steps ⇒ many accumulated message arrays ⇒ more retention surface. |
| `packages/kernel/src/runtime/dispatch.ts` | **Tool dispatch** (the `maxConcurrent`/`eager` tool-execution loop). | Tool results accumulate into the turn's message history. A rogue tool returning huge payloads could balloon arrays. |
| `packages/host-bin/src/mem-telemetry.ts` | The periodic telemetry edge effect. | Read this to understand exactly what `memory:periodic` / `memory:gc` log entries contain (rss, heapUsed, heapTotal, external, arrayBuffers, activeConversations, reclaimedRssMB). |

> **Architecture note (AGENTS.md):** the kernel (`packages/kernel`) touches NO
> I/O and names no concrete feature. Decision logic is pure; effects are
> injected at the edges (host-bin). When investigating, keep this layering in
> mind — a leak "in the kernel" would actually be in a closure captured by an
> edge that feeds the kernel, not in the kernel's own (stateless) turn loop.

---

## 6. What's been done (committed to `dev`, NOT yet deployed)

The running binary is still the **old one** (built Jun 27 21:40, pre-telemetry,
pre-Bun-1.3.14, pre-LSP-disable). Four commits on `dev` need building +
installing before any of this takes effect. **Verify before you trust:** the
live systemd still reports `MemoryMax=infinity` (confirmed via
`systemctl show dispatch -p MemoryMax`).

| Commit | What | Status |
|---|---|---|
| `d1de9ed` | `systemd/dispatch.service` gets `MemoryHigh=20G` + `MemoryMax=24G` circuit breaker. | Committed. **Live = infinity (not applied).** |
| `b3b6eb4` | `bin/apply-memory-limits.sh` — applies the limits to the live service. | Committed. **User has NOT run it.** |
| `1cd66da` | Memory telemetry: periodic `process.memoryUsage()` every 15s, per-turn before/after sampling, `activeConversations` tagging, `Bun.gc(true)` every 5 min. Files: `packages/host-bin/src/mem-telemetry.ts` + `packages/session-orchestrator/src/pure.ts`. | Committed. **NOT deployed.** |
| `73ff84c` | **LSP disabled** as a precaution (`main.ts` import commented out + removed from `CORE_EXTENSIONS`; `transport-http` tolerates its absence). Also set telemetry interval 60s→15s. | Committed. **NOT deployed.** LSP stays disabled until the leak is understood. |
| (bun upgrade) | Bun **1.3.13 → 1.3.14** via `bun upgrade`. New binary built at `dist/dispatch-server`. | Rebuilt. **NOT installed** to `/usr/bin/dispatch-server`. |

### 6.1 The telemetry data you will collect (once deployed)

The exact log tags to grep in journald are **`memory:periodic`** and
**`memory:gc`** (the module is `mem-telemetry.ts`, but the log *messages* are
those two strings — do not grep for `[mem-telemetry]`).

- `memory:periodic` — every 15s: `rss`, `heapUsed`, `heapTotal`, `external`,
  `arrayBuffers` (bytes), plus `activeConversations` (count). Correlate RSS
  growth with active turns: if RSS climbs while `activeConversations` is 0,
  the leak is background/idle (timers, watchers, retained closures); if it
  climbs only during/after turns, it's the streaming/turn path.
- `memory:gc` — every 5 min: runs `Bun.gc(true)` and logs RSS before/after +
  `reclaimedRssMB` (`before - after`). **Interpretation:** a large positive
  `reclaimedRssMB` = GC freed it (fragmentation, reclaimable — not a true
  leak). Near-zero/negative `reclaimedRssMB` = memory is **LIVE** (retained
  objects — a real leak). This single field distinguishes the two failure
  modes; check it first when you get data.

### 6.2 Deploy sequence (hand to the user — you have no sudo)

The agent cannot run `sudo` or install to `/usr/bin`. Write a script with
`sudo` on the privileged lines and hand it to the user (per the repo's sudo
policy). The sequence, roughly:

1. From `backend/`: `bun run typecheck && bun run test && bun run check` —
   make sure `dev` is green (it should be; these commits are committed).
2. `bin/build` — produces `dist/dispatch-server` (Bun 1.3.14, with telemetry +
   LSP-disabled).
3. `bin/install` (or a targeted script) — copies `dist/dispatch-server` →
   `/usr/bin/dispatch-server`, the unit template → `/etc/systemd/system/`,
   `systemd/dispatch.env` → `/etc/dispatch/env`. (Or run `bin/apply-memory-limits.sh`
   separately if you only want the cgroup limits without a full reinstall.)
4. `sudo systemctl daemon-reload && sudo systemctl restart dispatch`.
5. Confirm: `systemctl show dispatch -p MemoryMax` should show `24G`, and
   `journalctl -u dispatch -f | rg 'memory:periodic'` should show telemetry
   within 15s.

> ⚠️ **Warning:** deploying restarts the production server. The live server is
> actively serving agent conversations. Coordinate with the user (ceb2 /
> tradam) before restarting — don't just yank it. Also note the running server
> at time of writing is PID 28956 (started Jun 28 08:51).

---

## 7. Background — the original crash investigation (already done)

You do **not** need to redo this; it's recorded for context.

- **Original report:** `notes/server-crash-investigation.md` (commit `b83aa8d`).
- The first investigation's task description was **stale**: it claimed an
  "uncommitted hot-fix that disables LSP" existed. It did not — the working
  tree was clean and LSP was *enabled*. The developer then *chose* to disable
  LSP (commit `73ff84c`) as a precaution, but the root cause was already
  identified as the Bun segfault + leak, not LSP.
- The **three original LSP suspects** (JSON-parse TypeError, `fs.watch` ENOENT,
  unbounded cache leak) were all fixed in commits `05ff256` + `f9d1ca5` and
  are correct/tested. LSP being disabled now is a precaution, not a fix for the
  crash. Once the leak is understood, LSP can be re-enabled safely.
- **Do not spend time re-investigating LSP.** It is exonerated.

---

## 8. What needs investigation (your tasks, in order)

1. **Deploy the telemetry + cgroup limits** (§6) — you cannot localize the leak
   without the `memory:periodic` / `memory:gc` data. Get a full crash cycle's
   worth of logs (let it run until it either hits `MemoryMax=24G` and restarts,
   or until the growth pattern is clear).
2. **Read the telemetry first.** The `memory:gc` `reclaimedRssMB` field tells
   you live-retained vs fragmentation. If near-zero after GC → real retained
   leak; chase which subsystem holds it.
3. **Correlate growth with `activeConversations`.** Idle-growth ⇒ timers /
   watchers / retained closures / the LSP file-watcher (if any servers still
   spawn — but LSP is disabled). Turn-bound growth ⇒ the streaming/turn path
   (suspects in §5.4).
4. **Examine the streaming loop** (`orchestrator.ts:1276`): is the
   `provider.stream(...)` async generator fully drained on every path
   (success, error, abort, `break`)? Does the AI SDK retain response buffers?
   Consider adding a before/after `memoryUsage()` around a single turn to
   measure per-turn delta directly.
5. **Examine the message arrays** assembled before `provider.stream` — are
   they scoped to the turn and released when the turn completes, or do
   closures/promises/event-listeners keep them alive?
6. **Test Bun 1.3.14 in isolation.** Since the upgrade is built but not
   installed, see if a memory-stress repro under 1.3.13 vs 1.3.14 behaves
   differently — the segfault may be a Bun allocator bug that 1.3.14 fixes.
7. **Propose a fix** (do not implement without coordinating — report up to the
   orchestrator). Likely candidates: ensure the streaming generator is always
   fully consumed / explicitly closed on error; bound per-turn message
   history; release references at `activeConversations.delete` time; or
   confirm it's purely a Bun bug requiring the 1.3.14 deploy.

---

## 9. Quick-reference commands

```bash
# --- status & logs ---
systemctl status dispatch
systemctl show dispatch -p MemoryMax -p MemoryHigh       # expect 24G/20G after deploy
journalctl -u dispatch -f                                  # live logs
journalctl -u dispatch -f | rg 'memory:periodic|memory:gc' # telemetry (after deploy)
journalctl -u dispatch --since '2 hours ago' -n 200       # recent history / crashes
curl http://localhost:24991/health                        # → {"ok":true}
ss -tlnp | rg dispatch                                    # ports 24991 + 24990

# --- source (the leak path) ---
cd /home/tradam/projects/dispatch/backend
git log --oneline -n 8                                    # see the undeployed commits
rg -n 'runTurnDetached|provider\.stream|for await' packages/session-orchestrator/src/orchestrator.ts

# --- build & verify (NO sudo needed) ---
bun run typecheck && bun run test && bun run check
bin/build                                                 # → dist/dispatch-server

# --- deploy (NEEDS sudo — hand a script to the user) ---
# bin/install  (or: sudo cp dist/dispatch-server /usr/bin/dispatch-server)
# bin/apply-memory-limits.sh   (applies MemoryMax to live service)
# sudo systemctl daemon-reload && sudo systemctl restart dispatch
```

---

## 10. Guardrails

- **Do NOT edit implementation code without reporting to the orchestrator.**
  This is an investigation handoff; propose fixes, don't apply them
  unilaterally.
- **You have no sudo.** Any step touching `/usr/bin`, `/etc/`, or
  `systemctl restart` must be a script handed to the user with `sudo` on the
  privileged lines.
- **Do not re-enable LSP** until the leak is understood (it's disabled as a
  precaution; re-enabling is a separate decision).
- **Do not merge or push.** Work stays on `dev` locally.
- **The service is `dispatch`, not `dispatch-server`.**
