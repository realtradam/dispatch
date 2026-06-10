# Dispatch — tasks (live progress)

> **Live status + roadmap only.** Completed milestones are summarized, not
> narrated. Old blow-by-blow history is pruned — it lives in git (`git log`).
> Keep this lean and current; do not let it re-accrete a step-by-step changelog.

## Status (current)
`tsc -b` EXIT 0 · biome clean · **686 vitest + 89 bun = 775 tests**.

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
KEY1=$(grep DISPATCH_API_KEY_OPENCODE1 .env | cut -d= -f2)
PORT=4567 DISPATCH_API_KEY="$KEY1" bun packages/host-bin/src/main.ts   # boots app + collector
curl -s -X POST localhost:4567/chat -H 'content-type: application/json' \
  -d '{"conversationId":"c1","message":"Say hello in 3 words."}'        # field = conversationId
```
Process cleanup uses the `[x]` bracket trick (ORCHESTRATOR §8) — leaked
server/collector procs poison the next run's counts.

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

## Open items
- **`prefix.fingerprint` / `warm|real` cache-bust attributes (deferred):** decoupled
  from dedup by the content-addressed decision; also gated on cache-warming being
  built (not yet) so `warm|real` can't be honestly stamped. Later cache-bust-debug
  milestone (`notes/observability-design.md` §3.1, §12).
- **D9 analytics roll-ups (deferred):** rollup table shape + `GROUP BY` indexes +
  retention asymmetry + periodic rollup job (`notes/observability-design.md` §2 D9,
  §12). The scheduler mechanism (`host.scheduler.register`) already exists.
- **D8 `prompt.assembly` segments:** deferred-by-design (await the context-filter
  chain).

## Roadmap
1. **CLI** — done.
2. **Web frontend** (in progress, SEPARATE repo `../dispatch-web`; Svelte +
   DaisyUI, same methodology). Slice 2 = browser chat MVP consuming the
   wire/transport-contract + metrics. Cross-repo contract changes are couriered
   via the user (ORCHESTRATOR §7); `lsp references` does not span repos.
3. **dedup / storage growth** — after the frontend (see Open items).
