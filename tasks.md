# MVP Tasks — kernel + core extensions → working `curl` turn

Goal: send a message via HTTP `curl` and get a real multi-turn response from
OpenCode Go (flash), through the **actual architecture** (full fidelity: every
core feature is an extension loaded via manifest through the host).

Contracts are referenced **statically as types** (so `tsc` + `lsp references`
drive fan-out); extension **loading is dynamic** (manifests via the host).

## Legend: [ ] todo  [~] in progress  [x] done (verified + committed)

### Kernel
- [x] **contracts** — the ABI. `fd855ff` (+ `974ce6f`)
- [x] **bus** — event/hook/service bus. `669c269`
- [x] **runtime** — `runTurn` turn loop (dispatch §3.3), 16 tests. `ae22da5`
- [x] **host** — discovery→DAG→activate→registries; builds HostAPI (wraps bus). `dbcf219`
- [x] **kernel-crs** — CR-2 (HostAPI.getProviders/getTools), CR-3 (runTurn tabId/turnId). `e56b591`

### Core extensions (each ships a real manifest, loaded via the host)
- [x] **storage-sqlite** — bun:sqlite StorageNamespace + migrations. `9b611d6`
- [x] **auth-apikey** — pure resolver env → ApiKeyCredentials. `9b611d6`
- [x] **provider-openai-compat** — OpenAI-compatible SSE → ProviderEvents. `9b611d6`
- [x] **conversation-store** — append-only persistence + pure reconcile. `8b9cc0c`
- [x] **session-orchestrator** — load history → resolve provider/tools → runTurn → persist. `357ad35`
- [x] **transport-http** — Hono `/chat` NDJSON stream. `357ad35`

### Integration
- [x] **host-bin** — boot: config (.env), discover+activate extensions, Bun.serve. `bf52b11`
- [x] **curl smoke test** — ✅ VERIFIED LIVE against OpenCode Go flash (opencode-1 key).

## ✅ MVP ACHIEVED (verified live)
- Single turn: `curl -d '{"message":"Say hello in exactly 3 words."}'` → `"Hello my friend"`.
- **Multi-turn:** `conversationId` threads history — turn 1 "remember PINEAPPLE" →
  turn 2 "what was the secret word?" → `"PINEAPPLE"`. ✓ (target B, §2.8)
- Full path: curl → transport-http → session-orchestrator → host/registry →
  provider-openai-compat → OpenCode Go flash → ProviderEvents → AgentEvents → NDJSON.
- 178 vitest tests pass; `tsc -b` clean; biome clean.

### API note (for callers)
- Chat request field is **`conversationId`** (not `tabId`) to thread multi-turn.
  Omit it → a fresh conversation (random id) each call.

## Open items (post-MVP, not blocking)
- **auth-apikey is vestigial:** provider reads creds from `host.config`, does NOT
  yet use `AuthContract.resolve()`. Wire auth→provider properly (see host-bin CR).
- **host CR-1:** `createHost` should expose `getHostAPI()` so host-bin drops its
  adapter duplication.
- **storage-sqlite CR-2:** manifest declares `contributes.services:["storage"]`
  but activate is a no-op (backend is a kernel dep). Reconcile manifest vs reality.
- **Stale detached server** on port 18390 from an earlier run — harmless, ignore/kill.
- Tools path unexercised by MVP (turn completes with `tools: []`). Add a tool ext next.

## Parallelization log
- host + conversation-store ran in parallel (disjoint). ✓
- session-orchestrator + transport-http ran in parallel (disjoint). ✓
- kernel-crs solo (touched shared contracts/extension.ts).

---

## Post-MVP backlog (orchestrator: mimo-v2.5-pro summons)

### Step 1 — Wire auth → provider properly  [x] DONE (verified live)
Design: provider self-registers in `activate` (full-fidelity), so it must reach
the `AuthContract` via the HostAPI. HostAPI exposes `getProviders`/`getTools` but
NOT auth. Fix = small contract addition mirroring the existing provider/tool
precedent.
- **kernel-host** (owner of `host.ts`/`extension.ts`/`host.test.ts`): add
  `getAuthProviders()`/`getAuthProvider(id)` to `HostAPI` + implement in
  `buildHostAPI()` + tests. `lsp references` drives fan-out.
- **provider-openai-compat** (owner): in `activate`, resolve creds via
  `host.getAuthProvider("apikey").resolve()` (ApiKeyCredentials → baseURL/apiKey)
  instead of reading `host.config` apiKey/baseURL. Add `dependsOn:["auth-apikey"]`.
  Model stays config-driven (not a credential).
- **host-bin** (orchestrator CR wiring): mirror the two getters in
  `buildPostActivationHostAPI`.
Sequence: kernel-host FIRST (adds contract surface), THEN provider (consumes it),
THEN host-bin wiring. NOT parallel (provider depends on kernel surface).

**Step 1 RESULT:** done + verified. kernel-host added `getAuthProviders`/
`getAuthProvider` to HostAPI; provider-openai-compat `activate` now resolves creds
via `host.getAuthProvider("apikey").resolve()` (`dependsOn:["auth-apikey"]`);
host-bin stub mirrors the getters. 185 tests, typecheck+biome clean. Live curl
returned a real response with auth-apikey on the path (boot log shows auth-apikey
activates before provider; provider registered = creds resolved through contract).
NOTE: host-bin's `buildPostActivationHostAPI` stub is slated for removal in Step 3
(host CR-1). Summons: prompts/step1-kernel-host.md, prompts/step1-provider.md (mimo-v2.5-pro).

### Step 2 — First TOOL extension (read_file)  [x] DONE (verified live)
New unit `packages/tool-read-file/` (owner-agent, mimo-v2.5-pro). Pure-core/shell
split: `createReadFileTool(workdir)` → `ToolContract` named `read_file` (offset/
limit pagination, 1-indexed; two-layer workdir containment incl. realpath symlink
guard); `activate` calls `host.defineTool`. 29 unit tests. session-orchestrator's
`resolveTools: () => [...host.getTools().values()]` flows it into runTurn for free.
Orchestrator wiring CRs (done): root tsconfig ref, host-bin dep + import +
CORE_EXTENSIONS (before session-orchestrator), bun install, biome import-sort.

**Step 2 RESULT:** done + verified. typecheck clean, **214 tests pass** (185→+29),
biome clean. LIVE: booted on 24203, asked flash to read a test file → stream
contained a real **`tool-call` + `tool-result`** round-trip and the final answer
quoted the file's secret passphrase (MAGENTA-OTTER-42) correctly. The kernel
tool-dispatch loop is now proven end-to-end against a live model (§3.3). Summon:
prompts/step2-tool-read-file.md, report: reports/step2-tool-read-file.md.

### Step 3 — Small CRs / hygiene  [x] DONE (verified live)
Parallel summons (disjoint file sets, mimo-v2.5-pro; output→reports/*.run.log):
- **host CR-1** (kernel-host owner): `createHost` exposes `getHostAPI()` (registration
  closed post-activation) so host-bin drops its `buildPostActivationHostAPI` duplicate.
  prompts/step3-kernel-host.md. Files: packages/kernel/src/host/{host.ts,host.test.ts}.
- **storage-sqlite CR-2** (owner): remove false `contributes.services:["storage"]`
  from manifest (backend is a kernel bootstrap dep via HostDeps.storageFactory, not a
  bus service); document the intentional no-op activate. prompts/step3-storage-sqlite.md.
  Files: packages/storage-sqlite/src/extension.ts.
After both land: orchestrator wires host-bin to use `host.getHostAPI()` (deletes adapter).

**Step 3 RESULT:** done + verified. (1) kernel-host: `createHost` now exposes
`getHostAPI()` returning the canonical post-activation HostAPI with registration
methods closed (single builder w/ `registrationClosed` flag — zero duplication);
+4 host tests. (2) storage-sqlite: removed false `contributes.services:["storage"]`;
documented the intentional no-op activate (backend is a kernel bootstrap dep via
HostDeps.storageFactory). (3) host-bin wiring (orchestrator): deleted the
`buildPostActivationHostAPI` adapter, now calls `host.getHostAPI()`; dropped the
now-unused `HostAPI` import. typecheck clean, **218 tests pass**, biome clean.
Live boot: all 7 extensions activate, curl returns real responses. Summons:
prompts/step3-{kernel-host,storage-sqlite}.md (mimo-v2.5-pro, parallel, disjoint).

### Step 4 — Vocab drift: tabId → conversationId  [x] DONE (verified)
Interlocked contract rename (every consumer breaks at once) → ONE coordinated
multi-file owner-agent (mimo-v2.5-pro, output→reports/step4-*.run.log) owns the
full 10-file set; orchestrator updates GLOSSARY + tasks separately.
Files: contracts/{events,runtime}.ts, runtime/{events,run-turn,dispatch,run-turn.test}.ts,
session-orchestrator/orchestrator.ts, transport-http/{app,app.test,logic.test}.ts.
External `/chat` field is ALREADY conversationId — unchanged; only the internal
field + emitted NDJSON event field flip tabId→conversationId. prompts/step4-rename-conversationid.md.

**Step 4 RESULT:** done + verified. The agent renamed `tabId` → `conversationId`
across all 10 files in one atomic change: all 11 `AgentEvent` variants
(`contracts/events.ts`) + `RunTurnInput` (`contracts/runtime.ts`), the runtime
event factories/`run-turn`/`dispatch`, the session-orchestrator bridge (dropped
the redundant `tabId: conversationId` line), transport-http emit wiring, and all
three test files (inputs + assertions). Doc comments updated ("turn/tab identity"
→ "turn/conversation identity"; StatusEvent "tab / session" → "conversation").
Orchestrator re-verified independently: **typecheck clean (EXIT 0)**, **218 tests
pass** (unchanged count — pure rename, no behavior change), **biome clean**, and
`grep tabId packages/` → **zero matches**. Agent stayed in-lane (exactly the 10
owned files). External `/chat` request field + `X-Conversation-Id` response header
untouched (already canonical); emitted NDJSON events now carry `conversationId`.
GLOSSARY drift note removed. Report: reports/step4-rename-conversationid.md.

---

## 🏁 Post-MVP backlog COMPLETE (Steps 1–4 all done + verified)
All four ordered HANDOFF steps landed: auth→provider seam wired, first live tool
extension (read_file), hygiene CRs (getHostAPI + manifest honesty), and the
tabId→conversationId vocab rename. typecheck + biome clean; 218 tests green.
Remaining work is the parked design decisions (persistent waking agents, etc.) —
non-blocking. See HANDOFF.md "Open design decisions still parked".

---

## Observability — Phase A (logging substrate) ✅ DONE + verified live
Goal: structured logs + spans captured durably to a journal file — the substrate
for the agent-first observability subsystem (design: notes/observability-design.md).

- [x] **Unit 1 — kernel-logging** (mimo-v2.5-pro): Logger/Span ABI
  (`contracts/logging.ts`) — leveled/attributed/auto-scoped (host stamps
  `extensionId`), incremental span records (open/close, crash-reconstructable, D3),
  injected `LogSink` (pure record-builder). `ctx.log` on ToolContract; runTurn
  opens turn/step/tool-call spans + the verbatim **"before"** prompt on the step span.
- [x] **Unit 2 — journal-sink** (`packages/journal-sink/`, mimo-v2.5-pro): bootstrap
  `LogSink` → NDJSON append-only journal (pure `serialize` + thin fs edge, rotation,
  fail-safe drop — never blocks a turn). NOT an extension (HostDeps bootstrap dep).
- [x] **Orchestrator fan-out + wiring** (direct): bus error-attrs `{ err }`,
  FakeLogger/`ctx.log` test conformance; host-bin injects `logSink`+`logDeps`
  (journal at `.dispatch/journal/`); session-orchestrator threads `host.logger`
  (childed per turn) into runTurn.

**Result:** typecheck clean, **250 tests** (218 → +22 journal-sink, +10 kernel),
biome clean. **Live boot verified:** a turn's journal contains host logs + turn/step
spans (open+close) + the `prompt:before` record carrying the verbatim messages array
— the pre-mutation prompt is fully reconstructable. 2-process model: app + in-process
sink → journal file; the collector (process 2) is Phase B. Redaction is
per-extension self-redaction (no shared helper — isolation over DRY).

### Phase A.2 — AFTER capture ✅ DONE + verified live
- [x] **Contract** (orchestrator): `ProviderStreamOptions.logger?` threads the step's
  correlated logger into `stream()` (optional, non-breaking).
- [x] **Unit K — kernel run-turn**: passes the step span's logger into `provider.stream`.
- [x] **Unit P — provider-openai-compat**: `provider.request` span capturing the
  verbatim post-transform request + status/cache-tokens/raw-error; **auth self-redacted
  in its own code** (graduated tiers, no shared helper); fail-safe; **15 hermetic
  fetch-mocked tests** (first provider HTTP coverage).
- typecheck clean, **267 tests** (250→+17), biome fully clean (0 warnings / 0 infos).
  **Live:** `provider.request` shares the turn's `turnId` with `prompt:before`
  (before↔after diffable); **auth-key leak count = 0** (self-redaction verified live).
  Summons: prompts/phase-a2-{kernel-runturn,provider-after-capture}.md (+ 2 test cleanups).

### Phase A.3 — body channel + pure-types contracts ✅ DONE + verified live
- [x] **contracts/logging.ts → pure types**: `createLogger` moved to `kernel/src/logging/`;
  `@dispatch/kernel` still exports it. Contracts are types-only again.
- [x] **Span body channel** (Option A): `span/child/end` accept optional `body?` →
  `LogRecord.body`. Large verbatim payloads now use `body`, not stringified attributes.
- [x] **before** (kernel run-turn): a `prompt` span carrying verbatim messages+tools in
  `body` (small scalars in attrs). **after** (provider): `provider.request` body = the
  verbatim request (attrs thin, auth redacted).
- typecheck clean, **273 tests**, biome **0/0**. Live: prompt + provider.request bodies
  present, correlated (shared turnId), `request.body` no longer in attributes, key leak 0.
  Summons: prompts/phase-a3-{kernel-body-channel,provider-body}.md.

### Phase B — collector + trace store ✅ DONE + proven (first slice)
- [x] **trace-store** (`packages/trace-store/`, `bun:sqlite`): records+bodies schema
  (thin/fat split), idempotent `insertRecords` (FNV-1a id + `INSERT OR IGNORE`),
  `getTurn`/`getBody`, pure `renderEasyView` (D8 timeline skeleton), `trace` CLI. 30 tests.
- [x] **observability-collector** (`packages/observability-collector/`): out-of-process
  bin — tail journal → `splitLines`/`drainOnce` → `insertRecords`; offset sidecar;
  at-least-once + idempotent; fail-safe; clean SIGINT/SIGTERM drain. 21 tests.
- [x] **Build-config wiring** (orchestrator): root tsconfig refs; both excluded from
  vitest + added to `test:bun` (`bun:sqlite`); `bun install`.
- typecheck clean, **345 tests** (273 vitest + 72 bun), biome 0/0. **Pipeline proven:**
  app → journal → collector → SQLite → `trace <turnId>` easy-view.
  Summons: prompts/phase-b-{trace-store,observability-collector}.md.

### Next (observability)
- **Span nesting fix (kernel run-turn):** spans are currently flat (all `parent=ROOT`);
  nest `step`←`turn` and `prompt`/`provider.request`←`step` (pass the step span's logger
  into `provider.stream`) so the trace is a tree. (`renderEasyView` already nests once
  parents exist.)
- **host-bin supervision** (deferred): spawn-first / drain-last / restart the collector.
- **Record/replay test fixtures** (goal): captured verbatim provider.request/response
  traces → hermetic `stream.test.ts` fixtures (mock `fetch`, replay real flash). D5; §7.

Summons: prompts/phase-a-{kernel-logging,journal-sink}.md;
reports/phase-a-{kernel-logging,journal-sink}.md.
