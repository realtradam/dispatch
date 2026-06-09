# Dispatch — tasks (live progress)

> **Live status + roadmap only.** Completed milestones are summarized, not
> narrated. Old blow-by-blow history is pruned — it lives in git (`git log`).
> Keep this lean and current; do not let it re-accrete a step-by-step changelog.

## Status (current)
`tsc -b` EXIT 0 · biome clean · **546 vitest + 89 bun = 635 tests**.

Built and verified live (full-fidelity: every feature is a manifest-loaded
extension through the host):
- **kernel** — contracts (ABI), bus, `runTurn` turn loop, extension host.
- **core extensions** — storage-sqlite, auth-apikey, provider-openai-compat
  (OpenCode Go), conversation-store, session-orchestrator, transport-http,
  credential-store; tool extension `read_file`.
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
- [ ] **FE courier handoff** for the new types + endpoint (in-repo handoff doc;
  user couriers to `../dispatch-web`; ORCHESTRATOR §7 — backend does not write
  the FE repo).
- [ ] **Live re-probe** of `GET /conversations/:id/metrics` end-to-end (first
  probe came back empty — re-run with a longer boot wait).

## Open items
- **logging-audit #1:** conversation-store has no injected logger, so a load-time
  `reconcile` repair leaves no trace. Inject a logger + emit a `reconcile.repair`
  span when conversation-store is next touched.
- **dedup / storage growth (deferred):** trace-body de-dup (D5 volume control +
  `prefix.fingerprint`) + rotation/compression/retention
  (`notes/observability-design.md` §6, D9). `cacheReadTokens` is the cheap dedup
  signal; thin/fat split already built.
- **D8 `prompt.assembly` segments:** deferred-by-design (await the context-filter
  chain).

## Roadmap
1. **CLI** — done.
2. **Web frontend** (in progress, SEPARATE repo `../dispatch-web`; Svelte +
   DaisyUI, same methodology). Slice 2 = browser chat MVP consuming the
   wire/transport-contract + metrics. Cross-repo contract changes are couriered
   via the user (ORCHESTRATOR §7); `lsp references` does not span repos.
3. **dedup / storage growth** — after the frontend (see Open items).
