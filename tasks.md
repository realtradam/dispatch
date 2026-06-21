# Dispatch — tasks (live progress)

> **Live status + roadmap only.** Completed milestones are summarized, not
> narrated. Old blow-by-blow history is pruned — it lives in git (`git log`).
> Keep this lean and current; do not let it re-accrete a step-by-step changelog.

## Status (current)
`tsc -b` EXIT 0 · biome clean · **1240 vitest + 199 transport bun green**.

Built and verified live (full-fidelity: every feature is a manifest-loaded
extension through the host):
- **kernel** — contracts (ABI), bus, `runTurn` turn loop, extension host.
- **core extensions** — storage-sqlite, auth-apikey, provider-openai-compat
  (OpenCode Go), conversation-store, session-orchestrator, transport-http,
  credential-store; tool extensions `read_file` (files + directory listing), `run_shell`,
  `edit_file`, `write_file`.
- **observability** — structured Logger/Span ABI + journal-sink → out-of-process
  collector → trace-store (`bun:sqlite`); host-bin supervises the collector;
  nested turn→step→{prompt, provider.request, ttft, decode} spans; D5 verbatim
  provider capture (self-redacted); `trace-replay` record/replay lib + fixtures.
- **CLI** — one-shot HTTP client (`bun packages/cli/src/main.ts`); `GET /models`,
  `--cwd`, `--conversation`.
- **web frontend** — SEPARATE repo `../dispatch-web`. Slice 1 (surface system)
  shipped via `ui-contract` + `surface-registry` + `transport-ws` +
  `surface-loaded-extensions`. Slice 2 (browser chat) in progress there.

## How to run
```bash
# .env auto-loads DISPATCH_API_KEY (do NOT re-export) and pins BACKEND_PORT (beats PORT).
# Private probe instance: override the port + ISOLATE data paths (ORCHESTRATOR §8):
BACKEND_PORT=4567 SURFACE_WS_PORT=4569 DISPATCH_DB=/tmp/opencode/probe/dispatch.db \
  DISPATCH_TRACE_DB=/tmp/opencode/probe/traces.db DISPATCH_JOURNAL=/tmp/opencode/probe/app.ndjson \
  bun packages/host-bin/src/main.ts   # boots app + collector
curl -s -X POST localhost:4567/chat -H 'content-type: application/json' \
  -d '{"conversationId":"c1","message":"Say hello in 3 words."}'        # field = conversationId
```
Process cleanup uses the `[x]` bracket trick (ORCHESTRATOR §8) — leaked
server/collector procs poison the next run's counts.

**Two stacks:** `bin/up` = dev (live-reload backend, ports 24203/24205/24204).
`../bin/up2` = a **stable, no-watch** second stack on **25203/25205/25204** with
ISOLATED data (`./.dispatch-data/up2/`, `./.dispatch/journal/up2/`) — runs ALONGSIDE
`bin/up`, edit backend code freely without restarting it; Ctrl-C stops only itself.
Enabled by a new env knob **`SURFACE_WS_PORT`** → `surfaceWsPort` config
(`host-bin/config.ts`; default 24205 when unset, so dev is unchanged).

## Foundation (done — summarized; details in git)
- **MVP + multi-turn:** curl → transport-http → session-orchestrator →
  host/registry → provider → OpenCode Go → AgentEvents → NDJSON;
  `conversationId` threads history.
- **Post-MVP:** auth→provider seam; `read_file` tool (live tool-dispatch loop);
  `getHostAPI()` hygiene; `tabId → conversationId` rename.
- **Observability Phase A/B:** the substrate + collector/store + supervision +
  replay fixtures (see bullet list above).
- **CLI MVP:** credential-store + transport-contract + cli; model catalog; cwd
  threading; multi-turn.
- **FE Slice 1:** the surface system across both repos (live WS probe verified).
- **FE Slice 2 backend prereqs:** `@dispatch/wire` split; per-chunk `seq` cursor;
  read endpoint `GET /conversations/:id?sinceSeq=`; WS chat-deltas (transport-ws);
  turn-lifecycle events (`turn-start`/`done`/`turn-sealed`); step grouping
  (`stepId` on tool chunks/events); live stream metrics (`step-complete` +
  `usage`/`done` token/timing — "Pass 1"); CORS.

## Metrics — token + timing (current milestone)
- [x] **Pass 1 — live stream metrics** (done): `step-complete` event +
  `usage`(stepId) + `done`(durationMs + aggregate usage).
- [x] **Observability spans** (done): turn & step span-close stamp all four
  `Usage` fields (added cacheRead/cacheWrite; normalized `usage_*` → `usage.*`).
- [x] **Pass 2 — persisted replay metrics** (done, was deferred): `StepMetrics`/
  `TurnMetrics` wire types; conversation-store `appendMetrics`/`loadMetrics`
  (separate key space, turn-append order); session-orchestrator accumulates
  per-step+turn metrics from the event stream and persists after seal;
  transport-http `GET /conversations/:id/metrics` → `ConversationMetricsResponse`.
  `@dispatch/wire` + `@dispatch/transport-contract` → `0.4.0`. Commit `6db12ff`.
- [x] **Live-verified end-to-end** (against flash): live `step-complete`/`done`
  metrics ↔ persisted `GET /conversations/:id/metrics` byte-match (aggregate +
  per-step `stepId` + ttft/decode/genTotal + durationMs); journal turn/step spans
  carry dotted `usage.*` incl. `usage.cacheReadTokens` (the #2 fix).
- [x] **FE courier handoff** written: `frontend-metrics-pass2-handoff.md` (in
  this repo; user couriers to `../dispatch-web`; ORCHESTRATOR §7).

## dedup / storage growth (DONE)
Design `notes/observability-design.md` §12. User-gated calls: extend existing
pipeline (no new ext); scope = **de-dup + retention/rotation** (D9 roll-ups
deferred); dedup = **content-addressed bodies** (body-hash, NOT fingerprint-gated).
- [x] **Wave 1 — `trace-store`**: content-addressed `bodies` table (SHA-256),
  at-rest gzip (>1 KiB), `prune(policy)` (age + drop-oldest byte-cap + orphan GC) /
  `RetentionPolicy` / `PruneSummary` / `DEFAULT_RETENTION` (7d/256MiB); reads
  transparent.
- [x] **Wave 2 — `observability-collector`**: pure `shouldPrune` cadence helper;
  `main.ts` calls `store.prune(DEFAULT_RETENTION)` on a coarse cadence
  (`--prune-interval-ms`, default 60s; host-bin-overridable), log-and-continue on
  error.
- [x] Glossary: added content-addressed body, trace retention, prefix fingerprint,
  warm vs real.
- [x] **Migration bug** (found by live boot, fixed): Wave 1 created the
  `idx_records_bodyHash` index BEFORE running `migrateOldBodies`, so opening a
  pre-existing OLD-schema `traces.db` crashed the collector
  (`no such column: bodyHash`, crash-looped). Fix = reorder migration before the
  index + 3 regression tests that seed a real old-schema DB. bun 106→109.
- Tests: bun 89→109. typecheck/biome clean. **Live-verified** against a real
  old-schema `traces.db`: 0 crashes, collector stays up, schema migrates
  (bodyHash + content-addressed bodies), real-data dedup (318 body refs → 270
  stored bodies), prune cadence fires cleanly (14× `prune completed`). Optional
  follow-up: host-bin env-override for the retention policy.

## Standard tools — fs + shell (DONE)
User-gated calls: **one tool per extension** (matches `tool-read-file` precedent); tools are
**standard** tier (a turn completes with `tools:[]`, §2.6/§2.8). **Zero ABI change** — the
`ToolContract`/`ToolExecuteContext` already carry `signal`/`onOutput`/`cwd`/`log`.
- **Wave 1 (parallel, disjoint pkgs, kernel-only dep) — all green:**
  - [x] `tool-read-file` — EXTENDED `read_file` to list directory contents (sorted, `/`-suffixed
    subdirs; files unchanged). 41 tests.
  - [x] `tool-shell` (new) — `run_shell`: foreground, streamed via `ctx.onOutput`, `ctx.signal`
    cancel, `ctx.cwd`, timeout + output cap, `concurrencySafe:false`; injected `spawn`. 31 tests.
  - [x] `tool-edit-file` (new) — `edit_file`: `oldString`/`newString`/`replaceAll`; errors on
    absent/non-unique/identical; workdir-contained; `concurrencySafe:false`. 38 tests.
  - [x] `tool-write-file` (new) — `write_file`: explicit `overwrite` flag (absent+unset→create;
    exists+unset→error; exists+true→overwrite; absent+true→error); no parent auto-create. 33 tests.
- **Wave 2 (done):** orchestrator added 3 root tsconfig refs + `bun install`; host-bin owner
  registered the 3 new extensions in `CORE_EXTENSIONS` (same pattern as `read_file`).
- **Live-verified:** clean boot (`Dispatch booted`, collector up, no activation/capability-gate
  error — the new `shell` capability is accepted); full-graph `tsc -b` EXIT 0, biome clean.
- **Recovery notes (scar tissue):** `tool-write-file` first returned plan-only (§5a) → re-summoned
  with "IMPLEMENT NOW". `tool-edit-file` hung vitest at collection — `computeReplacement` infinite-
  looped on empty `oldString` (`"".indexOf("") === 0`, index never advances) invoked at a test's
  `describe` scope; fixed with an early empty-string guard + validation. One agent deleted
  `ORCHESTRATOR.md` out-of-lane → caught by post-wave `git status`, restored from git.
- Deferred (not selected): `glob`, `grep`/`search_code`, background shells.

## Skill system + load_skill tool (DONE)
User-gated calls: skills list lives in the **`load_skill` tool definition** (NOT the system prompt),
refreshed **per new turn** (cache-stable across steps), **live file read** on execute. One `skills`
standard extension (loader + filter + tool). Skill = md in `.skills/`; discovered from `~/.skills` +
`<cwd>/.skills` (cwd shadows home); name = filename w/o `.md`. Format: line1 = summary,
line2 = `---`, body = line3+; on load the first two lines are stripped; malformed (no `---`) =
no summary but still loadable. Glossary: added `skill`, `skill summary`, `tools filter`.
- **Mechanism — the per-turn `tools` filter chain** (first concrete use of the §3.2 context-assembly
  chain; reusable for persona/agents later):
  - [x] **kernel** — exposed `HostAPI.applyFilters` (delegates to the bus's existing `applyFilters`).
  - [x] **session-orchestrator** — defines+exports `toolsFilter`/`ToolAssembly`; applies it ONCE per
    turn (injected `applyToolsFilter` dep) before `runTurn`, threading `cwd`+`conversationId`.
  - [x] **skills** (new ext, `dependsOn session-orchestrator`) — pure parse/merge/render +
    `load_skill` tool (live read, strips first two lines, path-contained) + a `toolsFilter` filter
    that rewrites `load_skill`'s description + `name` enum with the per-cwd catalog. 42 tests.
  - [x] **host-bin** — registered `skills` in `CORE_EXTENSIONS`.
  - [x] **Fan-out (§5.3):** `applyFilters` was a required `HostAPI` addition → broke one consumer
    (transport-http `server.bun.test.ts` inline HostAPI stub) → fixed by its owner.
- **Live-verified:** clean boot (`skills` activates, filter registered, no crash); full-graph
  `tsc -b` EXIT 0, biome clean. (End-to-end load_skill via a real LLM turn not yet exercised —
  unit/integration tests cover the filter rewrite + live read.)

## Cache warming (core DONE; control surface PARTIAL)
User-gated calls: target the external **Claude** provider (`../claude` provider-anthropic, loaded via
`DISPATCH_EXTERNAL_EXTENSIONS`); warm-assembly lives in **session-orchestrator** (`warm()` reuses the
real turn's assembly → byte-identical prefix, provider-agnostic); **surface system** for controls;
**per-conversation** controls; interval default 4 min, free value. Old-code invariants honored
(primary-model/full-prefix via reuse; refuse mid-turn; never persist/emit; in-flight invalidation;
arm-on-settle/cancel-on-start; `pct = round(clamp(cacheRead/input,0,1)*100)`).
- **Mechanism (2nd use of bus hooks; first event-hook emit):**
  - [x] **kernel** — exposed `HostAPI.emit` (delegates to bus.emit), counterpart of `on`.
  - [x] **session-orchestrator** — `turnStarted`/`turnSettled` event hooks (carry conversationId/cwd/
    modelName) emitted per turn; `warm()` service (`cacheWarmHandle`) reusing assembly, refusing
    mid-turn, never persisting/emitting; returns Usage.
  - [x] **cache-warming** (new ext) — per-conversation timers (arm/cancel/in-flight token),
    calls `warm()`, computes `lastPct`, persists `{enabled,intervalMs}` (default on/240s) in
    host.storage; registers a controls Surface. 19 tests.
  - [x] **host-bin** — registered cache-warming; **transport-http** HostAPI stub fixed for `emit`.
- **Manual trigger endpoint:** `POST /chat/warm {conversationId, model?, cwd?}` → `WarmResponse`
  `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,cachePct}` (409 if generating). Powers a
  FE "warm now" button + fast tests. Types in `@dispatch/transport-contract`; route in transport-http.
- **LIVE-VERIFIED against Claude haiku:** automatic timer warm → journal `warm complete pct:100`;
  manual `POST /chat/warm` → `cacheReadTokens:6799, cachePct:100` (100% hit), HTTP 200. The external
  `../claude` provider-anthropic is loaded via `bin/up` (`DISPATCH_EXTERNAL_EXTENSIONS`).
- **Cache-metric fix + retention metric:** `provider-anthropic` (in `../claude`, commit `0e9d118`)
  now reports `Usage.inputTokens` as the TOTAL prompt (was the uncached remainder → the cache rate
  inflated/clamped to 100% on Claude). So `cacheRead/inputTokens` is now the true rate (live: a turn
  adding new content reads 61%, not 100%). Added **`expectedCacheRate`** = `cacheRead/(cacheRead+
  cacheWrite)` (retention/health, ~100% when warm, 0% when the cache expired) to `WarmResponse` +
  `POST /chat/warm` + the cache-warming surface (a "cache retention" stat). Live-verified: warm
  within TTL → 100%; warm after >5 min idle → 0% (cache expired). FE handoff updated with both
  metrics + the cross-turn real-turn `expectedCache = cacheRead_N/(cacheRead_{N-1}+cacheWrite_{N-1})`.
- **Surface framework extended (DONE):** added `NumberField` to `ui-contract` + per-conversation
  surface scoping (optional `conversationId` on subscribe/unsubscribe/invoke + surface/update; new
  `SurfaceContext` on `SurfaceProvider.getSpec/invoke`; transport-ws keys subscriptions by
  `(surfaceId, conversationId)` and tags updates). cache-warming now serves a PER-CONVERSATION
  surface: `Toggle`(enabled) · `Number`(interval, seconds, `cache-warming/set-interval`) ·
  `Stat`(last cache %). All backward-compatible (global surfaces like `surface-loaded-extensions`
  unchanged). **FE courier:** `frontend-cache-warming-handoff.md` (this repo) — the web must render
  the `number` field kind + send/handle `conversationId` on the surface WS protocol.

## Cache warming — FE CR-3 (DONE)
FE asked (dispatch-web `backend-handoff-cache-warming-timer.md`): expose next/last-warm timestamps +
make a manual warm reset the timer/refresh the surface. Done via an **inversion** (commit `bfbad3a`):
session-orchestrator `warm()` (the single chokepoint for manual `/chat/warm` AND the auto timer) emits
a `warmCompleted` bus event; cache-warming subscribes and does all post-warm handling — so manual
warms re-arm the timer + push a surface update with **no transport-http change** (core can't depend on
the standard cache-warming ext). Added `nextWarmAt`/`lastWarmAt` state + a `custom`
`rendererId:"cache-warming-timer"` surface field (no ui-contract bump). Caught + fixed a wiring bug
(`createWarmService` missed the `emit` dep → `deps.emit?.` silently no-oped; made it required).
Live-verified vs claude haiku (manual warm logs `warm complete` ~2s after the turn, not the 4-min
timer). FE handoff updated. (FE CR-1 table + CR-2 catalog `scope` flag still open, not requested.)

## LSP integration + per-conversation CWD (DONE)
Design: `notes/lsp-design.md`. FE courier: `frontend-lsp-cwd-handoff.md`. Decisions
(locked): **single `lsp` extension**; **hand-rolled pure JSON-RPC codec** (zero dep,
injected-stream tested); **diagnostics-on-write deferred** (on-demand `lsp` tool
only); **cwd persisted in `conversation-store`**; config = **built-in TypeScript +
`<cwd>/.dispatch/lsp.json` + `<cwd>/opencode.json` `lsp` fallback** (Roblox works
with its existing config). Glossary: added LSP, language server, diagnostics,
workspace root, working directory.
- **The bug we fixed** (opencode root cause, confirmed): opencode's
  `client/registerCapability` ignores all but `textDocument/diagnostic`, so
  `workspace/didChangeWatchedFiles` registrations are dropped + no real fs watcher
  → stale `sourcemap.json` → "Unknown require" mid-session. Fix = honor the
  registration + real fs watcher + forward `didChangeWatchedFiles` + auto-spawn
  `rojo sourcemap --watch` sidecar when `luau-lsp.sourcemap.autogenerate`. Covered
  by a regression test in `packages/lsp/src/client.test.ts`.
- **`lsp` extension** (new, bundled core): hand-rolled LSP client (framing + rpc +
  watched-files + diagnostics + config + root + tool + manager), zero external deps.
  Lazy-spawn one server per `(serverID, root)`; config resolved **per cwd**;
  `lspServiceHandle.status(cwd)` lazy-connects + reports state; `deactivate` kills
  all child procs (host-bin shutdown now calls `host.deactivate()`).
- **CWD:** `conversation-store.getCwd/setCwd`; `session-orchestrator` defaults a
  turn's cwd from the store; endpoints `GET`/`PUT /conversations/:id/cwd` +
  `GET /conversations/:id/lsp` in transport-http; wire types in
  `@dispatch/transport-contract` (→ `0.5.0`).
- **LIVE-VERIFIED:** this repo (`typescript`) → `connected`; `/home/tradam/projects/
  roblox` (`luau-lsp`) → `connected` (via the project's own `opencode.json` + rojo
  sidecar); cwd PUT/GET round-trip 200. Op note: LSP binaries must be on the server
  process PATH (`~/.local/bin` daemon-PATH caveat for `typescript-language-server`).
- **Recovery (scar tissue):** the `lsp` agent stalled on the final stretch (1 hung
  test + ~40 biome `!`/dot-key findings) → at the user's request the orchestrator
  finished it directly; also fixed a real design bug the agent missed: the manager
  read config statically instead of per-cwd (would have broken Roblox).

## Context size — current context-window usage (DONE)
User-gated decisions: term = **context size** (current usage; reserve "context window" for the
model's max LIMIT, a later feature); definition = the turn's **FINAL step `inputTokens +
outputTokens`** (NOT the aggregate `usage`, which sums per-step prompts and overcounts a
multi-step turn); delivery = a backend-computed field on BOTH the live `done` event and the
persisted `TurnMetrics`.
- [x] **Contract (orchestrator):** optional `contextSize?: number` added to `TurnDoneEvent` +
  `TurnMetrics` in `@dispatch/wire` (`0.4.0→0.5.0`); `@dispatch/transport-contract`
  `0.5.0→0.6.0` (re-exports both — no other change). Glossary: added **context size**.
- [x] **Wave (parallel, disjoint pkgs):**
  - [x] **kernel** — `run-turn.ts` tracks the last step's `Usage`; `doneEvent()` stamps
    `done.contextSize = lastStep.input + lastStep.output` (omitted when no usage). +3 tests.
  - [x] **session-orchestrator** — `metrics.ts build()` stamps `TurnMetrics.contextSize` from
    the final per-step metrics (same definition; equals the live value). +5 tests.
- [x] Verified: `tsc -b` EXIT 0, biome clean, 881 vitest pass; both owners stayed in-lane.
  `conversation-store` (JSON passthrough) + `transport-http` (forwards/serves) unchanged.
- [x] **LIVE-VERIFIED against flash** (`deepseek-v4-flash`): turn 1 → live `done.contextSize`
  1255 == persisted `turns[-1].contextSize` 1255 == final-step `1206 in + 49 out` (NOT the
  aggregate); turn 2 (same conversation) → 1286 (grew cumulatively), live == persisted. Both
  carriers agree; "current" = latest turn's value.
- [x] **FE courier handoff:** `frontend-context-size-handoff.md` (user couriers to
  `../dispatch-web`).

## Turn continuity — detached turns + multi-client live view (DONE)
Design: `notes/turn-continuity-design.md`. FE courier: `frontend-turn-continuity-handoff.md`.
Problem (code-traced): a turn's lifetime was bound to the WS connection — `transport-ws` aborted
the in-flight turn on socket close, so a backgrounded/reloaded mobile browser killed generation.
Principle enforced: **the FE is only a control interface; the AI runs independent of it**, and
**multiple clients may watch the same conversation** (multi-device handoff).
- **Decisions (locked):** broadcast hub lives in the CORE (`session-orchestrator`), not a
  transport; additive `SessionOrchestrator` handle (keep `handleMessage`); persist-at-seal kept,
  per-step R1 deferred; late-join served by an in-memory in-flight buffer; subscribers persist
  per-conversation independent of turns; no concurrent-send arbitration; no explicit stop op.
- **Contract (orchestrator):** `@dispatch/transport-contract` `0.6.0→0.7.0` — additive WS ops
  `chat.subscribe`/`chat.unsubscribe` on `WsClientMessage` (events still arrive as `chat.delta`).
- **Wave 1 — `session-orchestrator`:** detached per-conversation turn ownership + broadcast;
  `startTurn`/`subscribe`/`isActive` added to the handle; `handleMessage` → convenience wrapper
  (dropped `signal`). **Two-map model** (`subscribers` persistent + `activeTurns` buffer) — the
  fix for the live-found bug where pre-turn subscribers were dropped. 63 tests.
- **Wave 2 (parallel) — `transport-ws`** (fan-out: per-connection chat-subscription map;
  `chat.send` auto-subscribes sender + `startTurn`; new ops in pure `router.ts`; `close` drops
  subs but NEVER aborts a turn; removed the turn `AbortController`) + **`transport-http`** (only
  test fakes updated for the 3 new methods; runtime unchanged). host-bin untouched.
- **LIVE-VERIFIED against flash** (2-client WS test, `/tmp/ws_multi.ts`): (S1) two clients both
  stream a turn; closing the SENDER mid-turn → the other keeps receiving through `done` and the
  turn persists (1197 chars) — AI kept going independent of the interface; (S2) a client joining
  mid-turn gets `turn-start` replayed + the rest live. `RESULT OVERALL: OK`.
- **Recovery (scar tissue):** first Wave-1 impl stored listeners INSIDE the per-turn hub and
  `startTurn` made a fresh empty-listener hub → every pre-turn subscriber dropped; live test got
  zero deltas though the turn ran+persisted. Caught by live-verify (unit test had subscribed
  AFTER start, masking it). Fixed via the persistent-subscribers / per-turn-buffer split.

## Turn continuity — CR-3: user prompt on the event stream (DONE)
FE bug (multi-client): a pure watcher (subscribed, not the sender) couldn't see the USER prompt until
seal — the user message was passed to the provider + persisted only at seal, never on the turn's
outward stream/buffer. FE courier: `frontend-cr3-user-message-handoff.md`.
- **Contract:** `@dispatch/wire` `0.5.0→0.6.0` — additive `TurnInputEvent`
  `{ type:"user-message"; conversationId; turnId; text }` on the `AgentEvent` union (kernel barrels
  re-export it). `@dispatch/transport-contract` `0.7.0→0.8.0` (re-export only). Widening broke NO
  exhaustive switch (typecheck clean) — zero consumer fan-out.
- **session-orchestrator:** `emitToHub({type:"user-message",…})` as the FIRST event of `runTurnDetached`
  (before `runTurn`) → buffered + broadcast to all subscribers (live + late-join); HTTP path covered via
  `handleMessage`'s buffer replay. Persistence + metrics unchanged. +3 tests; 3 Wave-1 tests updated
  (user-message now precedes turn-start).
- **LIVE-VERIFIED vs flash:** a watcher that never sent receives `user-message` (correct text) as its
  FIRST `chat.delta`, before `turn-sealed`, then the streaming reply. `RESULT: OK`.
- **Process note:** implemented directly by the orchestrator as a one-off (user-approved at the
  time). SUPERSEDED — the user has since confirmed the ORCHESTRATOR.md model governs: the
  orchestrator summons owner-agents and does not write feature code itself.

## Cache warming — FE CR-4 lifecycle + CR-1 extensions table + CR-2 catalog scope (DONE)
FE courier in: `../dispatch-web/backend-handoff-cache-warming.md` (+ CR-1/CR-2 from their living
`backend-handoff.md`). Courier out: `frontend-cache-warming-lifecycle-handoff.md`. Full report:
`reports/cr4-cache-warming-lifecycle.md`.
- **CR-4a:** warming defaults OFF (opt-in per conversation) — `parseSettings` + `DEFAULT_STATE`;
  re-enabling now restores the persisted interval. Known gap (pre-existing, fail-safe): no boot
  hydration of persisted opt-in across server restarts.
- **CR-4b:** post-warm surface updates now carry the FUTURE `nextWarmAt` (re-arm BEFORE notify);
  `turnSettled`/`turnStarted` also push (fresh schedule after seal / `null` while generating).
- **CR-4c:** new `POST /conversations/:id/close` (tab close ≠ disconnect): aborts the in-flight
  turn via a per-turn `AbortController` → kernel `runTurn` `signal` (partial persist + normal seal,
  `done.reason:"aborted"`), and emits new typed hook `conversationClosed` → cache-warming disables
  sync + persists OFF. Disconnect/`chat.unsubscribe` semantics unchanged.
- **CR-4d:** no change — initial `surface` echo already at HEAD (FE probed a stale up2 boot).
- **CR-1:** loaded-extensions emits count stat + ONE `custom`/`rendererId:"table"` field
  (`TablePayload` exported); columns Name|Version|Trust|Activation, all trust tiers.
- **CR-2:** `SurfaceCatalogEntry.scope?: "global"|"conversation"` (`ui-contract` `0.1.0→0.2.0`);
  set on both surfaces. `transport-contract` `0.8.0→0.9.0` (additive `CloseConversationResponse`).
- 907 tests pass (+13 new); typecheck + biome clean. **LIVE-VERIFIED vs `bin/up`:** default-off,
  2 automatic warms @5s each pushing future `nextWarmAt`, mid-turn close → `abortedTurn:true` +
  `done.reason:"aborted"` + warming disabled, catalog scopes + table field present, echo present.

## History windowing — FE CR-5 (DONE)
FE courier in: `../dispatch-web/backend-handoff-chat-limit.md` (+ living `backend-handoff.md` §2
CR-5). Courier out: `frontend-history-windowing-handoff.md`. User-gated call: ask #3 shipped as
the INVARIANT option (no new field) — seq is contractually **1-based, monotonic, gap-free**; FE
derives `hasOlder` from `chunks[0].seq > 1`.
- **Wave 0 (orchestrator, contracts):** `limit`/`beforeSeq` query-param semantics + validation +
  `latestSeq` windowed-read caveat documented on `ConversationHistoryResponse`
  (`@dispatch/transport-contract` `0.9.0→0.10.0`); 1-based seq guarantee codified on
  `StoredChunk` (`@dispatch/wire` `0.6.0→0.6.1`, doc-only).
- **Wave 1 — `conversation-store`:** additive `loadSince(id, sinceSeq?, window?: { beforeSeq?,
  limit? })` — selection `sinceSeq < seq < beforeSeq`, newest-`limit` window, result stays
  ascending; garbage-in treated as absent (transport validates upstream). +8 tests.
- **Wave 2 — `transport-http`:** parses + validates the params (positive integers; malformed/
  zero/negative → 400 `{ error }`, store never called with an invalid window); two-arg call
  shape preserved when no params (regression-guarded). +20 tests.
- 935 vitest + 112 bun tests, typecheck + biome clean. **LIVE-VERIFIED** (isolated boot, real
  flash turns): firstSeq=1; `limit=2`→`[5,6]` ascending w/ correct `latestSeq`; `limit=9999`→
  full log; `beforeSeq=3`→`[1,2]`; `beforeSeq=3&limit=1`→`[2]`; `limit=0`/`beforeSeq=0`/
  `limit=abc`→400×3. `RESULT: OK` ×6.
- **Scar tissue (process):** (1) probing with a PRIVATE boot was overkill — the windowing checks
  are read-only GETs and the dev stack was running; prefer probing `bin/up`/`up2` or asking the
  user (ORCHESTRATOR §8 updated). (2) The §8 boot recipe was stale (`DISPATCH_API_KEY_OPENCODE1`
  doesn't exist; an empty re-export OVERRIDES `.env` → "No providers registered"; `.env`'s
  `BACKEND_PORT` beats `PORT`; un-isolated data paths spawn a duplicate collector on the dev
  DB) — recipe fixed in §8 + above. (3) Violated the bracket trick once (`pkill -f 'cr5-data'`
  self-matched → killed parent shell, timeout-with-no-output); the existing §8 rule stands.

## Reasoning effort (current milestone)
User-gated calls: canonical term **reasoning effort** (GLOSSARY); ladder `low|medium|high|xhigh|max`
(Anthropic-driven, includes xhigh/max); scope = **(c)** persisted per-conversation + per-turn
`ChatRequest.reasoningEffort` override; resolution default **`high`**; provider picks sensible
budget_tokens; `../claude` orchestrated DIRECTLY (mode A); CLI `--effort` now.
- [x] **Wave 0 (orchestrator, contracts):** `ReasoningEffort` in `@dispatch/wire` (`0.6.1→0.7.0`);
  `ProviderStreamOptions.reasoningEffort` (kernel contract; runtime untouched — providerOpts is
  forwarded verbatim); `ChatRequest.reasoningEffort` + `ReasoningEffortResponse`/
  `SetReasoningEffortRequest` GET/PUT types (`@dispatch/transport-contract` `0.10.0→0.11.0`);
  glossary entry. typecheck + biome clean.
- [x] **Wave 1 (parallel ×3, disjoint):** `conversation-store` get/setReasoningEffort (own key
  space, mirrors cwd; +12 tests); `provider-anthropic` (../claude commit `c0835a4`, mode A summon
  with `--dir ../claude`, contract excerpt INLINED per the cross-`--dir` hang rule) —
  `REASONING_EFFORT_BUDGETS` 4096/10240/16384/32768/65536, raises max_tokens above budget, strips
  temperature when thinking on, absent → byte-stable body (+12 tests); `cli` `--effort` flag,
  parse-validated, body key omitted when unset (+8 tests).
- [x] **Wave 2:** `session-orchestrator` — exported pure `resolveReasoningEffort` (override →
  stored → `"high"`), additive `StartTurnInput.reasoningEffort`, providerOpts always stamped,
  **warm() parity** (same resolved effort as a real turn — prompt-cache safe), own fakes fixed
  (+9 tests).
- [x] **Wave 3 (parallel ×2):** `transport-http` — `/chat` validation (400 names valid levels,
  orchestrator never sees bad input), threads to startTurn, GET/PUT
  `/conversations/:id/reasoning-effort` mirroring cwd endpoints, own fakes fixed; `transport-ws` —
  `chat.send` threading + validation (+3 tests).
- [x] Verified: `tsc -b` EXIT 0, biome clean, **993 vitest + 189 bun** green; all agents in-lane.
  Commits: arch-rewrite `35197ed` (contracts) + `020e051` (impl); ../claude `c0835a4`.
- [ ] Live-verify vs claude (thinking deltas streamed at xhigh; persisted PUT honored next turn).
- [x] FE courier handoff written: `frontend-reasoning-effort-handoff.md` (user couriers to
  `../dispatch-web`): ChatRequest/chat.send field + GET/PUT endpoints + ladder + default-`high`
  semantics + cache note.

## Message queue + steering injection (DONE)
Design: this file's roadmap item 3 (now implemented). User-gated calls: a **separate
`message-queue` standard extension** (dependsOn `surface-registry`) owns the queue STATE +
a per-conversation `custom` surface; the **session-orchestrator** owns delivery (drain →
inject → carry) + emits the `steering` event (it owns the chat hub — no `chatEmit` service
needed); the **kernel** gets a generic `drainSteering` callback. Glossary: added
**message queue**, **steering**, **queued message**. Enqueue when idle **starts a turn**
(user choice; `chat.queue` degrades to `chat.send`). Steering text rendered live via a new
additive `steering` `AgentEvent`; queue state via the surface (NOT the chat stream).
- **Wave 0 (orchestrator, contracts):** `RunTurnInput.drainSteering?: () => readonly
  ChatMessage[]` (kernel contract — generic, kernel stays pure); `QueuedMessage` +
  `QueuePayload` + `TurnSteeringEvent` (type `"steering"`, additive to `AgentEvent`) in
  `@dispatch/wire` (`0.7.0→0.8.0`); `POST /conversations/:id/queue` + WS `chat.queue` op +
  `QueueRequest`/`QueueResponse` in `@dispatch/transport-contract` (`0.11.0→0.12.0`). typecheck
  clean except the expected transport-ws exhaustive-switch fan-out (fixed in Wave 3).
- **Wave 1 (parallel ×2, disjoint):** `kernel` runtime — calls `drainSteering` at the
  tool-result boundary only when continuing to a next step (gated; no drain on max-steps),
  +6 pure tests (65 total); `message-queue` (NEW ext) — pure queue core (enqueue/getQueue/
  drain/combine) + `MessageQueueService`/`messageQueueHandle` + per-conversation `custom`
  surface (`rendererId:"message-queue"`, `QueuePayload`), 12 tests. (The message-queue agent
  DIED mid-task after writing all src+tests but before verifying/reporting; orchestrator
  recovered by running `bun install` + root tsconfig ref + verifying directly — tsc/vitest/
  biome clean, 12 tests pass; no hand-fixing of impl.)
- **Wave 2:** `session-orchestrator` — added `enqueue` facade (idle→`startTurn`,
  active→queue.enqueue) + `resolveQueue?` dep (self-wired lazily in `activate` via
  `host.getService(messageQueueHandle)` — host-bin does NOT wire it) + `drainSteering` wrapper
  (drain → emit `steering` → return one combined user `ChatMessage`) + post-seal carry
  (non-empty queue → new turn), +8 tests (85 total). `message-queue` is an OPTIONAL dep
  (feature degrades off if absent).
- **Wave 3 (parallel ×3):** `host-bin` — registered `message-queue` in `CORE_EXTENSIONS`
  (+dep+ref), 28 tests; `transport-http` — `POST /conversations/:id/queue` route + validation,
  145 tests; `transport-ws` — `chat.queue` op + fixed the Wave-0 exhaustive-switch fan-out,
  29 vitest + 20 bun.
- Verified: `tsc -b` EXIT 0, biome clean (280 files), **1043 vitest + 199 transport bun** pass;
  all agents in-lane. **Boot smoke:** private instance boots clean with `message-queue`
  registered (no activation crash).
- [x] FE courier handoff written: `frontend-message-queue-handoff.md` (user couriers to
  `../dispatch-web`): surface (`rendererId:"message-queue"`), `chat.queue` WS op, `steering`
  event, HTTP `POST /queue`, auto-start-when-idle, carry semantics, version bumps.

## Umans AI Coding Plan provider (DONE)
User-gated calls: a new **`provider-umans`** standard extension wrapping the Umans
OpenAI-compatible backend (`https://api.code.umans.ai/v1`). Built via the **full-refactor
path**: first extract a generic `@dispatch/openai-stream` library from
`provider-openai-compat`, then build `provider-umans` on top. Self-contained (reads
`UMANS_API_KEY` from env directly — no `auth-apikey` dep).
- **Wave 1 — `@dispatch/openai-stream` lib (NEW package):** extracted the generic OpenAI
  functions (convert-messages, convert-tools, parse-sse, listModels, stream, provider)
  from `provider-openai-compat` into a pure library package. `createOpenAICompatProvider`
  parameterized: `id: string` (was hardcoded `"openai-compat"`) + `transformBody?: (body,
  opts) => Record<string,unknown>` hook (for provider-specific body fields). Refactored
  `provider-openai-compat` to import from the lib (thin extension.ts, backward-compat
  re-exports, manifest unchanged, byte-identical behavior). Full tsc EXIT 0, 66 vitest,
  biome clean. Report: `reports/provider-umans-wave1-openai-stream.md`.
- **Wave 2 — `provider-umans` (NEW ext):** imports `createOpenAICompatProvider` from the
  lib; registers provider id `"umans"`; `transformBody` maps Dispatch `reasoningEffort`
  (`low|medium|high|xhigh|max`) → Umans `reasoning_effort` (`none|low|medium|high`,
  capping `xhigh`/`max`→`high`); dynamic `listModels` (GET /v1/models); default model
  `umans-coder` (env `UMANS_MODEL` or config `provider.umans.model`); baseURL env
  `UMANS_BASE_URL`; absent key → warn + skip registration (graceful). Pure core:
  `mapReasoningEffort` + `resolveUmansConfig` (factored out for direct unit testing).
  12 tests. Report: `reports/provider-umans.md`.
- **Wave 3 — host-bin wiring:** registered `provider-umans` in `CORE_EXTENSIONS` + added
  `@dispatch/provider-umans` dep + root tsconfig ref. No credential-store entry needed
  (self-contained — reads env directly, doesn't go through `auth-apikey`). 28 host-bin
  tests.
- Verified: full-graph `tsc -b` EXIT 0, biome clean (293 files), **1059 vitest** pass.
  **Boot smoke:** without `UMANS_API_KEY` → `"provider-umans: no UMANS_API_KEY. Provider
  not registered."` (graceful skip); with `UMANS_API_KEY=sk-test` → `"provider-umans:
  registered (model=umans-coder)"`.
- [x] **LIVE-VERIFIED against the real Umans API:** the dev stack (umans-glm-5.2) called
  `web_search` (Firecrawl) in a real turn — first live Umans API call, clean response.

## web_search tool — Firecrawl (DONE)
Standard tool extension `tool-web-search` backed by a self-hosted Firecrawl instance
(`http://100.102.55.49:31329/v1`, Tailscale, no API key). One tool `web_search` with 4
modes: search, scrape, crawl (polls status URL), map — mirroring the proven opencode tool.
Pure core: `validateArgs` (discriminated union by mode) + `format*` functions + `truncateOutput`.
Injected edge: `FirecrawlClient` (injectable `fetchFn` + `sleep` + `now`), `AbortSignal.any`
for per-request timeout + caller cancellation. `concurrencySafe: true`, `capabilities: { network: true }`.
38 tests. Report: `reports/tool-web-search.md`.
- **LIVE-VERIFIED:** the dev stack (umans-glm-5.2) called `web_search` → Firecrawl returned
  real results (Paris, France) — first live Umans API call too.

## todo tool — per-conversation task list + surface (DONE)
Standard tool extension with a single `todo_write` tool (opencode `todowrite` pattern:
full-list replace, returns JSON, no business-rule enforcement — the description guides
the model). Per-conversation in-memory state (`Map<conversationId, TodoItem[]>`). Per-
conversation surface (`rendererId: "todo"`, `scope: "conversation"`) via subscriber-notify
(message-queue pattern). `concurrencySafe: false` (mutates shared state).
- **Wave 0 (orchestrator, kernel contract):** added `conversationId?: string` to
  `ToolExecuteContext` (additive, backward-compatible). Wired in `dispatch.ts` — the
  kernel already had `conversationId` as a parameter, just wasn't passing it through to
  the tool context. 170 kernel tests pass.
- **Wave 1 (todo extension):** pure core (`validateTodos` — shape only; `getTodos`/
  `setTodos`/`clearTodos` — fresh array copies; `buildTodoSpec`; `formatTodoResult` →
  `JSON.stringify`). Shell: `createTodoWriteTool({ state, notify })` + surface provider.
  26 tests. Report: `reports/todo.md`.
- **Wave 2 (host-bin wiring):** registered `todo` in `CORE_EXTENSIONS` + dep + root tsconfig
  ref. 28 host-bin tests.
- Verified: full-graph `tsc -b` EXIT 0, biome clean (314 files), **1123 vitest** pass.
  **Boot smoke:** `"todo: registered"` + activated.
- [ ] Live-verify (model uses `todo_write` in a real turn — the dev stack has it loaded).

## youtube_transcript tool (DONE)
Standard tool extension `tool-youtube-transcript` backed by a self-hosted transcriber
service (`http://100.102.55.49:41090`, Tailscale, no API key). One tool
`youtube_transcript` — takes a YouTube URL, fetches the transcript (completed → full
text + timestamped segments; queued/processing → position + ETA + `.youtube_subtitles_pending`
retry convention; failed → error). Pure core: `validateUrl` + `format*` functions +
`truncateOutput`. Injected edge: `TranscriptClient` (injectable `fetchFn`, `AbortSignal.any`
for cancellation). `concurrencySafe: true`, `capabilities: { network: true }`. 30 tests.
Report: `reports/tool-youtube-transcript.md`.

## CLI — cross-client messaging + open tab (DONE)
Roadmap items 2 + 4. The CLI can now list conversations, read the last AI message
(blocking), send messages (blocking or `--queue`), and signal the frontend to open a
conversation tab. Short-ID prefix resolution (4+ chars → full ID via `GET /conversations?q=`).
- **Wave 0 (orchestrator, contracts):** `ConversationMeta` in `@dispatch/wire`
  (`0.8.0→0.9.0`); `ConversationListResponse`, `LastMessageResponse`,
  `OpenConversationResponse`, `SetTitleRequest`, `TitleResponse`, WS
  `conversation.open` in `@dispatch/transport-contract` (`0.12.0→0.13.0`);
  `listConversations()`/`getConversationMeta()`/`setConversationTitle()` on
  `ConversationStore`; new routes declared in transport-http manifest;
  `conversationOpened` hook in session-orchestrator.
- **Wave 1 (conversation-store):** metadata tracking (createdAt on first write,
  lastActivityAt on every append, title from first user message truncated 80 chars);
  `conv-index` key tracks all conversation IDs; `extractTitle` pure helper. 21 new
  tests (81 total).
- **Wave 2 (parallel, transport-http + transport-ws):** `GET /conversations` (list
  with `?q=` prefix filter), `GET /conversations/:id/last` (blocks until turn settles
  via subscribe-then-checkIsActive, returns last assistant text via pure
  `extractLastAssistantText`), `POST /conversations/:id/open` (emits
  `conversationOpened` hook), `PUT /conversations/:id/title`; `emit` threaded from
  `host.emit` → `createApp`. transport-ws subscribes to `conversationOpened` +
  broadcasts `ConversationOpenMessage` to all connected WS clients. 21+2 new tests.
- **Wave 3 (CLI):** `dispatch list` (table: short ID + title + activity),
  `dispatch read <id>` (blocking, prints last AI message), `dispatch send <id> --text`
  (blocking by default; `--queue` for non-blocking enqueue; `--open` signals FE).
  Short-ID resolution (4+ chars → prefix search; 32+ chars = full UUID). 48 new
  tests (108 total).
- Verified: full-graph `tsc -b` EXIT 0, biome clean (327 files), **1240 vitest** pass.
  **Boot smoke + endpoint smoke:** `GET /conversations` → `[]`, `GET /conversations/:id/last`
  → `{content:""}`, `POST /conversations/:id/open` → `{conversationId}`.
- [ ] Live-verify end-to-end (CLI → real conversation → FE tab open).

## Open items
- **Context window LIMIT (deferred, sibling of context size):** expose the selected model's max
  context-window token limit so the FE can render `contextSize / limit` (e.g. `1286 / 200000`).
  Source = the provider/model catalog (`ModelInfo`); likely a field on the models response
  and/or stamped alongside `contextSize`. "context size" = current usage (DONE); "context
  window" = this limit (GLOSSARY). FE handoff `frontend-context-size-handoff.md` already flags
  the denominator as not-yet-available.
- **`prefix.fingerprint` / `warm|real` cache-bust attributes (deferred):** decoupled
  from dedup by the content-addressed decision; also gated on cache-warming being
  built (not yet) so `warm|real` can't be honestly stamped. Later cache-bust-debug
  milestone (`notes/observability-design.md` §3.1, §12).
- **D9 analytics roll-ups (deferred):** rollup table shape + `GROUP BY` indexes +
  retention asymmetry + periodic rollup job (`notes/observability-design.md` §2 D9,
  §12). The scheduler mechanism (`host.scheduler.register`) already exists.
- **D8 `prompt.assembly` segments:** deferred-by-design (await the context-filter
  chain).
- **In-memory state persistence (message queue + todo list):** both the message
  queue and the todo list are in-memory only (`Map<conversationId, …>` in the
  extension's `activate`). Neither persists across server restarts. If persistence
  is needed later, both would write through `host.storage` (the conversation-store
  pattern: separate key space per feature, append/write per conversation).

## Roadmap
1. **Web frontend** (in progress, SEPARATE repo `../dispatch-web`; Svelte +
   DaisyUI, same methodology). Slice 2 = browser chat MVP consuming the
   wire/transport-contract + metrics. Cross-repo contract changes are couriered
   via the user (ORCHESTRATOR §7); `lsp references` does not span repos.
  2. ~~**CLI → open-tab handoff (cross-client messaging)**~~ — **DONE** (see CLI
     milestone section above; list, read, send, --queue, --open, short-ID resolution).
  3. **Message queue + steering injection — DONE** (see the milestone section above;
     prerequisite for item 2's `--queue` flag met).
  4. ~~**CLI flag to open/activate an FE tab**~~ — **DONE** (the `--open` flag on
     `dispatch send` calls `POST /conversations/:id/open` → backend broadcasts
     `conversation.open` WS message to all connected FE clients).
 5. ~~**`todo` tool**~~ — **DONE** (see milestone section above).
 6. ~~**`web_search` tool**~~ — **DONE** (see milestone section above).
 7. **Message queue — close-with-queued-messages (deferred product decision):**
    if a client closes a conversation (`POST /conversations/:id/close`) while the
    queue is non-empty, the carry currently still fires (starts a new turn on the
    closed conversation). Decide: does closing discard pending steering, or honor
    it? If "discard," gate the carry on `finishReason !== "aborted"` in
    session-orchestrator (one-line). No FE action either way.
 8. **Live-verify the steering flow (once the frontend is complete):** run a live
    `chat.queue` → tool-call → `steering` event flow against a real tool-calling
    model, end-to-end. The logic is unit/integration tested + boot-smoke-clean;
    this is the live end-to-end smoke. Blocked on the frontend wiring the queue
    surface + `chat.queue` op (or run it backend-only with a probe client).

(Done and dropped from the list: CLI; dedup / storage growth; message queue + steering injection.)
