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

### Phase B — span nesting + supervision ✅ DONE + verified live
- [x] **Span nesting fix (kernel run-turn):** `step`←`turn` (`turnSpan.child`),
  `prompt`/`provider.request`←`step` (step span's logger into `provider.stream`) →
  the trace is now a tree. Also fixed a latent `buildSpanOpen` parent-propagation bug
  in `logging/logger.ts`. 279 tests. `2bf8f9e`
- [x] **host-bin supervision:** `collector-supervisor.ts` (injected spawn → unit-tested
  with a fake): spawn-first before `Bun.serve`, restart on unexpected exit (backoff +
  restart-guard cap), drain-last on SIGINT/SIGTERM (collector final-drain, SIGKILL
  fallback). Collector failure never crashes the app (D3). 288 tests. `dded4cc`
- [x] **Orchestrator scar-doc:** the `[x]` bracket trick for `ps`/`pgrep`/`pkill`
  (avoids self-match killing the parent shell) — ORCHESTRATOR.md §8. `966caf7`
- typecheck clean, **288 tests** (279 vitest + 9 supervisor) + 72 bun, biome 0/0.
  **Live (clean run):** supervisor spawns exactly 1 collector; trace DB auto-populated
  with the nested turn→step→{prompt,provider.request} easy-view; 0 collectors after
  graceful shutdown. Summons: prompts/phase-b-{span-nesting,supervision}.md.

### Record/replay fixtures — IN PROGRESS (user chose: shared library unit, §5.2)
Boundary call (user): build a reusable **`trace-replay`** library (NOT provider-local),
so future edge extensions can reuse it. Realizes the §7 / D5 replay affordance as
hermetic fixtures: capture one real flash exchange → commit → replay via a fixture-driven
`fetch` double (mock `fetch`, no network). NOTE: "trace" here = a captured HTTP exchange,
independent of the SQLite trace-store; the lib is redaction-free (caller self-redacts).
- [x] **Unit 1 — `trace-replay`** (`packages/trace-replay/`, mimo-v2.5-pro): generic
  HTTP-exchange record/replay lib — DONE + verified. `replayFetch` (PURE: fixture → fetch
  double + captured request), `recordFetch` (tee real fetch → fixture), `serialize/parse`
  + `save/load` fixture I/O. **Redaction-free** (caller self-redacts — isolation over DRY),
  zero `@dispatch/*` deps, NO `bun:sqlite`. 39 tests (replay 12 / record 8 / fixture 19);
  root tsconfig ref wired → **327 vitest**, typecheck + biome 0/0. reports/trace-replay.md.
- [x] **Unit 2 — provider-openai-compat consumer** — DONE + verified (hermetic). Internal
  `fetchFn?: FetchLike` on `StreamConfig` (injectable fetch — P3, NOT a kernel contract
  change); env-gated record mode (`DISPATCH_RECORD_FIXTURE`) self-redacts auth via the
  provider's existing `maskSecret()` (no shared helper); 2 committed SSE fixtures
  (text-turn + tool-call) + 4 new tests (2 replay w/ chunk-split, 2 redaction). Provider
  44→48 tests → **331 vitest**, typecheck + biome 0/0. CR: none.
  prompts/provider-trace-replay.md, reports/provider-trace-replay.md.
- [x] **Build wiring** (orchestrator): root tsconfig ref ✓; provider dep `@dispatch/trace-replay` ✓; `bun install` ✓.
- [x] **Live capture** (orchestrator): FOUND A BUG (the whole point of D5). The first real
  capture leaked the live API key — record-mode self-redaction MISSED the `Authorization`
  header (capital A + `Bearer ` prefix; redaction matched lowercase). Caught PRE-COMMIT
  (fixture /tmp-only, scrubbed); committed span/journal path was SAFE (ZERO_LEAKS). After
  the fix, a clean re-capture verified 0 leaks + masked `Bearer sk-…redacted…UN0`.
- [x] **Record-mode redaction fix** (provider owner): case-insensitive auth mask + 3
  regression tests (incl. one reproducing the exact capital-`Authorization` leak). `5ae88d4`.
- [x] **Re-capture + swap** (orchestrator): real flash text-turn fixture installed
  (`src/__fixtures__/flash-text-turn.json`); reply "Hello there friend"; text-turn replay
  assertions updated to real values (inputTokens 665 / outputTokens 90); secret-free
  re-verified pre-commit. **334 tests**, typecheck + biome 0/0.
- [x] **Cache-token mapping fixed** (real-data, D5): parser now maps nested
  `prompt_tokens_details.cached_tokens` → `Usage.cacheReadTokens` (flat `cache_read_tokens`
  still wins via `??`; `cacheWriteTokens` flat-only, never fabricated; partial/null details
  safe; no contract change). +5 parser tests + real-fixture regression (`cacheReadTokens===384`).
  339 tests. reports/provider-cache-tokens.md.
- [ ] **DEFERRED — trace body de-dup / storage growth** (user-flagged): the `provider.request`
  span stores the FULL post-transform request body on EVERY request → ~O(N²) body text for
  long conversations (history is resent each turn; cache hits are the signature of it).
  Mitigation already DESIGNED, not built: D5 "Volume control" (persist body only when
  `prefix.fingerprint` changed) + §6 retention/rotation/compression; thin/fat split already
  built. `cacheReadTokens` (just added) + the future `prefix.fingerprint` are the cheap dedup
  signals. **Sequenced AFTER the Frontend MVP** (user-set roadmap below); also relevant
  once cache-warming / longer conversations land.

Summons: prompts/phase-a-{kernel-logging,journal-sink}.md;
reports/phase-a-{kernel-logging,journal-sink}.md.

### Logging-coverage audit (post FE-Slice-2 backend work)
The core turn round-trip is well-instrumented (kernel turn/step/tool-call/prompt spans +
provider-openai-compat `provider.request` D5 capture + session-orchestrator per-turn childing).
But a survey found per-extension/edge coverage thin, and a HARNESS gap as the root cause:
- [x] **#3 ROOT CAUSE FIXED — `.dispatch/rules/extension-logging.md` authored** (was "(pending)"
  in ORCHESTRATOR §3 for the whole substrate's life, so EVERY extension summon — incl. this
  session's conversation-store/transport-http/transport-ws/credential-store — was built blind to
  it). Rule now exists (self-redaction in own code, no shared helper, §6 tiers; use injected
  `host.logger`/`ctx.log`; flat scalar attrs; no token-delta logging; one-way; edge verbatim
  capture). ORCHESTRATOR §3 row updated to "Every extension — include on EVERY extension summon."
  Future extensions now get logging guidance by construction.
- [ ] **#1 INSTRUMENTATION DEBT — `reconcile.repair` span (conversation-store).** It has ZERO
  logger refs and `createConversationStore(storage)` receives no logger, so a load-time history
  repair (the §3.4 / bug-catalog "API rejected corrupted history" class) leaves NO trace. Inject a
  logger + emit a `reconcile.repair` span. Address when conversation-store is next touched (or as
  a dedicated pass).
- [x] **#2 DONE — transport-edge logging.** Both edges now emit structured logs via the injected
  logger (D7-compliant: NO per-`AgentEvent`/`chat.delta` frame logging). **Verified live** — the
  journal contains the edge records (`{level:info, msg:"conversations: read", attrs:{conversationId,
  sinceSeq, count}}`, `{level:warn, msg:"chat: validation failed"}`, etc.).
  - **transport-ws (owner):** +5 log points (connection open/close debug, chat.send accepted info,
    surface-op + malformed-chat.send warn, abort-on-close debug); +4 bun tests. Correctly attributed
    `extensionId: transport-ws` (it runs its own `Bun.serve` in `activate` → extension-scoped logger).
  - **transport-http (owner):** info on accepted `/chat`, warn on 400, error on turn failure, info
    on `GET /conversations` read, error on `/models`/store failure; +4 vitest tests. (First summon
    left the build broken — made `logger` required but missed call sites + biome; re-summoned to
    finish. Trust = independent re-verify.)
  - **Verified:** typecheck clean, **498 vitest** (+4) + **84 bun** (+4), biome clean, no internal mocks.
  - **Attribution caveat — FIXED (transport-http now owns its `Bun.serve`).** Was: transport-http
    edge logs were stamped `__host__` because host-bin ran the HTTP server via
    `createServer(getHostAPI())`. Fix (coordinated multi-knowledge agent, ORCHESTRATOR §5.5, owning
    transport-http + host-bin/main.ts): transport-http is now a FULL-FIDELITY extension — its
    `activate(host)` builds the Hono app with the extension-scoped `host` and runs `Bun.serve`
    itself (factory `createTransportHttpExtension`, mirroring transport-ws), reading the port from
    `host.config.get("httpPort") ?? 24203` (host-bin `config.ts` maps `BACKEND_PORT`/`PORT` →
    `httpPort`). **host-bin now serves NO transport** (both transports self-serve; it just boots
    extensions + supervises the collector). +5 bun lifecycle tests (wired into `test:bun`).
    **Verified live:** HTTP still serves on :24203 (200); the journal now shows
    `extensionId: "transport-http"` for ALL edge logs (`listening`/`chat: request accepted`/
    `conversations: read`/`chat: validation failed`) — no more `__host__`. typecheck clean, 498
    vitest + **89 bun** (+5), biome clean. prompts/transport-http-owns-server.md,
    reports/transport-http-owns-server.md.
- D8 `prompt.assembly` segments remain deferred-by-design (await the context-filter chain).

---

## ROADMAP — what's next (user-decided, §5.2)

### 1. CLI (first, before web frontend)  [x] MVP DONE + verified live
A **CLI** (NOT a TUI — line-oriented command-line interface; may have basic selectors
for things like picking a conversation). Terminal client for Dispatch: send a message,
render the streamed multi-turn response (`conversationId` threads history). Same
methodology constraint as the backend: pure core (zero I/O) / inject effects / no ambient
state / typed contracts / one owner per unit / asymmetric testing. A design pass FIRST
— seed `notes/cli-design.md` (IDEATION with the user, like `notes/observability-design.md`
and `notes/frontend-design.md`) before any summon.

**Design decisions (user, see `notes/cli-design.md` §3):** HTTP client for BOTH the CLI and
the future (separate-repo) web frontend; one-shot invocation; named **credentials** addressed
as **model names** `<credentialName>/<model>`; per-provider `listModels()`; `--cwd` threaded
to tools (cache-safe); `provider-openai-compat` keeps opencode-go specifics (deferred split
noted in code). New vocab in GLOSSARY: credential / key / model name / model catalog.

**Built (full fidelity, owner-agent per unit, mimo-v2.5-pro):**
- **contracts (orchestrator):** `ProviderContract.listModels()`+`ModelInfo`, `RunTurnInput.cwd`,
  `ToolExecuteContext.cwd` (all additive/optional).
- **`transport-contract`** (NEW, types-only): `ChatRequest`/`ModelsResponse` + re-export
  `AgentEvent` — the HTTP API contract every client imports.
- **`credential-store`** (NEW core ext): named credentials + `resolve(modelName)` +
  `listCatalog()`; typed `credentialStoreHandle`.
- **`cli`** (NEW bundled pkg): pure core (arg parse / render / ndjson / message / catalog) +
  injected shell (fetch NDJSON client, fs, stdout). HTTP client of the wire contract only.
- **modified:** kernel-runtime (cwd thread), provider-openai-compat (`listModels` + code note),
  tool-read-file (`ctx.cwd` honored), session-orchestrator (modelName+cwd; `resolveModel` dep
  wired via the handle), transport-http (`GET /models` + model/cwd on `/chat`), host-bin
  (registers credential-store w/ the `opencode` credential).

**RESULT:** typecheck clean, **429 vitest + 72 bun = 501 tests**, biome 0/0. **Verified LIVE**
(opencode-go flash on :24203): `GET /models` → 18 `opencode/*` models; `dispatch models`;
chat `opencode/deepseek-v4-flash` → "Hello there friend."; `--cwd` → live `read_file` round-trip
resolving against cwd (VELVET-WALRUS-93); `--file` folded into the message; `--conversation`
threaded multi-turn (PINEAPPLE recalled). Run: `bun packages/cli/src/main.ts <args>`.
Phasing: contracts → [kernel-runtime] → [provider ∥ tool ∥ credential-store ∥ cli] →
session-orchestrator (+extension wiring) → transport-http → host-bin → live integration.

### 2. Web frontend (after CLI)
Svelte + DaisyUI (same stack as old Dispatch). **Methodology mirror** — same constraints
as the backend and the CLI. Design scratch lives at `notes/frontend-design.md` (IDEATION
mode). Old Dispatch FE (`/home/tradam/projects/dispatch/dispatch-source`) is
REFERENCE-ONLY for UX/tech — do NOT copy its architecture. Port `FRONTEND_PORT=24204` is
reserved in `.env`. When FE build begins: retire the AGENTS.md "Backend only for now (no
frontend)" line, author new scoped `.dispatch/rules/frontend-*.md`, and update
ORCHESTRATOR.md §7 (repo geography) + §3 (rule scoping map).

**STATUS — slice 1 STARTED (user front-loaded the architecture: surface system + WS FIRST,
not chat-first).** Done: `notes/frontend-design.md` LOCKED (no-mandatory-spine model;
chat is a decomposable feature, NOT a surface); authored `packages/ui-contract` (types-only
surface ABI — `SurfaceSpec`/field kinds/`region`/`ActionRef`/catalog; verified green);
scaffolded the SEPARATE repo `../dispatch-web` (Vite + Svelte 5 + vitest + biome;
svelte-check/biome/`vite build` all green; `@dispatch/ui-contract` linked via `file:` dep);
authored the FE harness (AGENTS/ORCHESTRATOR/GLOSSARY/.dispatch rules). Retired the AGENTS.md
"Backend only" line; updated ORCHESTRATOR §7/§3. Vocab locked (surface/view/region/field
kind/action+action ref/surface catalog); backend `command`→`action` unification logged as a
future review (restructure-plan §8). NEXT (summons): backend B2 kernel wire-types split, B3
surface-contribution mechanism, B4 `transport-ws`, B5 loaded-extensions surface; FE F1–F5.

**FE SLICE 1 — DONE + verified live (2026-06-06): the surface system.** Built across both repos
(orchestrated, mimo-v2.5-pro owner-agents): NEW backend pkgs `ui-contract` (surface ABI + WS
protocol), `surface-registry` (typed service handle), `transport-ws` (Bun WS server :24205),
`surface-loaded-extensions` (first surface); kernel `HostAPI.getExtensions`; NEW repo
`../dispatch-web` (Vite+Svelte5) with `core/protocol` · `features/surface-host` · `adapters/ws` ·
`app`. **Live WS probe: catalog → subscribe → surface rendered the 10 loaded extensions.** Backend
460 vitest + 77 bun (typecheck+biome clean); FE 76 vitest + build (svelte-check+biome clean).
Scar tissue captured: headless cross-repo read hang (in-repo `ui-contract.reference.md` + brief
guards); live boot-probe tool-timeout (ORCHESTRATOR §8). Deferred: F-app CR-1 (vitest browser
condition), DaisyUI styling, B2 kernel wire-types split (chat slice). Full plan + status:
`notes/frontend-design.md` §10.

### FE SLICE 2 — chat slice (browser chat MVP): backend prerequisites — IN PROGRESS
The product MVP: send a message, render the streamed multi-turn response, with §6 caching/delta
streaming. Spans both repos; the backend prereqs live HERE (FE work runs in `../dispatch-web`).
- [x] **B2 — wire-types split** (`@dispatch/wire`, NEW types-only pkg). The pure wire ABI —
  `AgentEvent` (+11 variants), the conversation model (`Chunk`/`ChatMessage`/`Role`/`TurnId`/
  `StepId` + 6 chunk variants), and `Usage` — moved out of the kernel into `@dispatch/wire`
  (zero `@dispatch/*` deps, zero runtime). `@dispatch/kernel` re-exports them via shim files →
  its public surface is **byte-identical** (zero consumer blast radius). `transport-contract`
  now re-exports `AgentEvent` from `@dispatch/wire` and **dropped its `@dispatch/kernel`
  dependency** → the FE can consume the wire contract without pulling the kernel runtime (the
  whole point of B2). Coordinated multi-file owner-agent (mimo-v2.5-pro, ORCHESTRATOR §5.5) +
  orchestrator build wiring (new pkg scaffold, project refs, deps). typecheck + biome clean;
  **460 vitest + 77 bun** (unchanged — pure type move). Summon: prompts/b2-wire-split.md,
  report: reports/b2-wire-split.md.
- [x] **per-chunk `seq`** on the wire — monotonic cursor for incremental sync. DONE + verified.
  Design (user-confirmed): envelope `StoredChunk { seq, role, chunk }` in `@dispatch/wire`
  (keeps `Chunk` pure / provider-facing — `Chunk` never carries a cursor); `seq` is monotonic,
  gap-free, 1-based, per-conversation, **chunk-granular** (rekeyed from the old per-message seq).
  - **Wire/contract (orchestrator):** added `StoredChunk` to `@dispatch/wire` + threaded through
    the two kernel re-export shims (`contracts/conversation.ts`, `contracts/index.ts`). Additive
    (minor, §2.9). GLOSSARY: added `seq`, `StoredChunk`.
  - **conversation-store (owner, mimo-v2.5-pro):** rekeyed `conv:<id>:msg:<seq>` →
    `conv:<id>:chunk:<seq>`; `append` explodes messages → role-tagged seq'd chunks (stores
    internal `msgIdx`/`chunkIdx` for lossless boundary reconstruction — NOT exposed); `load()`
    signature + behaviour UNCHANGED (round-trips exact `ChatMessage[]`, no same-role merge, still
    reconciles); NEW `loadSince(conversationId, sinceSeq?) → readonly StoredChunk[]` (raw
    persisted stream, ascending, `seq > sinceSeq`; reconciliation deferred to the read-side
    endpoint step). +8 store tests. prompts/seq-conversation-store.md, reports/conversation-store.md.
  - **Fan-out (session-orchestrator owner):** its in-memory `ConversationStore` test fake grew
    `loadSince` to satisfy the additive interface (full `tsc -b` caught this; the agent's
    per-package typecheck did not — re-verify the WHOLE build, §4). Test-fake conformance only;
    production logic unchanged. prompts/seq-session-orchestrator-fanout.md.
  - **Verified (orchestrator):** typecheck clean (EXIT 0), **469 vitest** (460→+9), biome clean,
    zero internal `@dispatch/*` mocks, both agents in-lane.
  Read-side HTTP endpoint (`GET /conversations/:id?sinceSeq=`) + WS turn-deltas remain their own
  following steps.
- [x] **read-side endpoint** `GET /conversations/:id?sinceSeq=` → RAW seq'd stream. DONE + verified.
  Design (user-confirmed): returns `ConversationHistoryResponse { chunks: StoredChunk[], latestSeq }`
  — the RAW, append-order, seq-filtered slice from `conversation-store.loadSince`, **NOT
  reconciled**. `reconcile` (message-level repair) conflicts with per-chunk `seq` (a synthesized
  repair chunk has no seq), so reconciliation stays on the TURN path (session-orchestrator before
  `runTurn`); the read path is a pure sync primitive (FE renders a dangling tool-call as
  interrupted; FE commits only sealed turns §6.6). `latestSeq` = last returned chunk's seq, else
  `sinceSeq` (true server high-water mark deferred until a consumer needs it — avoids widening the
  store contract).
  - **Contract + wiring (orchestrator):** added `ConversationHistoryResponse` + `StoredChunk`
    re-export to `@dispatch/transport-contract`; added `@dispatch/conversation-store` dep +
    project ref to transport-http; `bun install`.
  - **transport-http (owner, mimo-v2.5-pro):** `GET /conversations/:id?sinceSeq=` route; reaches
    the log DIRECTLY via `conversationStoreHandle` (`dependsOn:["conversation-store"]`), not through
    the orchestrator; pure `parseSinceSeq` (absent→0, invalid/negative/float→400) in `logic.ts`;
    +6 logic + 6 app integration tests (via real Hono `app.fetch`). prompts/read-side-endpoint.md,
    reports/transport-http.md.
  - **Verified (orchestrator):** typecheck clean, **481 vitest** (469→+12), biome clean, no internal
    `@dispatch/*` mocks, in-lane. Live boot-probe deferred to the WS step (this GET route has no
    effectful-shell surprise surface; host wiring mirrors `/chat`).
- [x] **WS turn-deltas** — `transport-ws` multiplexes chat ops alongside surface ops. DONE + verified live.
  Design (user-confirmed): chat WS ops live in `@dispatch/transport-contract` (NOT ui-contract —
  it stays surface-only/zero-`@dispatch`-deps); new non-colliding `type` variants (`chat.send`
  client; `chat.delta`/`chat.error` server) widen unified `WsClientMessage`/`WsServerMessage`
  unions — NO channel wrapper, so the shipped slice-1 surface protocol is byte-identical.
  - **Contract + wiring (orchestrator):** added `ChatSendMessage`/`ChatDeltaMessage`/
    `ChatErrorMessage` + `WsClientMessage`/`WsServerMessage` to transport-contract (now imports
    `ui-contract`; doc broadened to "HTTP + WebSocket"); deps/refs for transport-contract→ui-contract
    and transport-ws→{session-orchestrator,transport-contract}; `bun install`.
  - **transport-ws (owner, mimo-v2.5-pro):** pure `routeClientMessage` extended to the full union
    (`kind:"chat"|"chat-error"|"surface"`); shell drives `sessionOrchestratorHandle.handleMessage`,
    streaming each `AgentEvent` as `{type:"chat.delta",event}` via `onEvent`; per-connection
    `AbortController` aborted on socket close (no leaked turns); error-isolated (`chat.error`,
    never crashes the connection). `dependsOn:["session-orchestrator"]`. +4 router + 3 bun:test
    integration (real `Bun.serve` WS + fake orchestrator). prompts/ws-turn-deltas.md, reports/transport-ws.md.
  - **Verified (orchestrator):** typecheck clean, **485 vitest** (481→+4) + **80 bun** (77→+3),
    biome clean, in-lane. **Live (host-bin :24203 HTTP / :24205 WS, real flash):** one WS connection
    delivered `catalog` (surface op) AND a real chat turn — `chat.delta` streamed
    reasoning-delta×37 → text-delta×4 → usage, reply "Hello my friend". No leaked procs after
    bracket-trick cleanup.
  - **Probe-artifact lesson (scar tissue):** the first probe reported FAIL because it asserted
    `turn-start`/`done`/`turn-sealed` frames — but the runtime emits NONE of those (see open item).
    transport-ws faithfully forwarded exactly what `onEvent` delivered; the failure was bad probe
    criteria, NOT a transport bug (cf. slice-1 "10 vs 11 extensions" artifact). Verified by
    confirming HTTP `/chat` emits the identical event set.

#### Turn-lifecycle event emission — FIXED + verified live
Was: the runtime emitted `reasoning-delta`/`text-delta`/`usage` but NOT `turn-start`/`done`/
`turn-sealed` on either transport (the wire defined them; nothing fired them). **`turn-sealed`
is the FE's cache-commit signal (frontend-design §6.3); `done` ends the stream.** Architecture-
correct split (NO contract change — all three wire types already existed):
- **kernel-runtime (owner, mimo-v2.5-pro):** `runTurn` now emits `turn-start` as the FIRST event
  and `done` (carrying the final `finishReason`) as the LAST kernel event — on every exit path
  (stop / tool-calls / max-steps / error / aborted). +2 event factories in `runtime/events.ts`;
  updated the existing event-sequence assertions; +6 lifecycle tests. (NOTE: first summon
  PLANNED but applied nothing — a planning-not-executing failure caught by `git diff --stat`
  showing 0 kernel changes + the stale report's bogus CRs; re-summoned with an explicit
  "EXECUTE, do not plan" directive. Trust = independent re-verification, not the report.)
- **session-orchestrator (owner, mimo-v2.5-pro):** emits `turn-sealed` via `onEvent` AFTER
  `conversationStore.append` succeeds (history persisted/final = the seal); not emitted if append
  throws. +3 tests. (Kernel owns start/done — orchestrator owns the post-persist seal, since the
  kernel touches no DB.)
- **Verified (orchestrator):** typecheck clean, **494 vitest** (485→+9), 80 bun, biome clean,
  no internal mocks, both in-lane. **Live (host-bin, real flash):** HTTP `/chat` AND WS chat now
  both stream `turn-start … done turn-sealed` — first=`turn-start`, last=`turn-sealed` on both
  carriers. Summons: prompts/lifecycle-{kernel-runtime,session-orchestrator}.md.

Then FE (`../dispatch-web`): `core/transcript` reducer + `conversation-cache` + `chat` feature.

#### FE Slice-2 backend handoff — ANSWERED + unblocked
The dispatch-web orchestrator couriered `backend-handoff.md` (in the FE repo). Reply written to
`../dispatch-web/backend-handoff-reply.md`. Resolution:
- **A (dep consumability, BLOCKER):** ready as-is — `wire`/`transport-contract` match the working
  `ui-contract` shape (`main: dist/index.js`, `types: dist/index.d.ts`); all three `dist/*.d.ts`
  emitted; `transport-contract` pulls only `ui-contract`+`wire` (no kernel/runtime). Refresh ritual:
  `bun run typecheck` (dist is gitignored but `file:` reads from disk).
- **B (versions):** bumped `wire`/`transport-contract`/`ui-contract` `0.0.0`→`0.1.0` (FE-consumable
  baseline; major = cross-repo fan-out signal, couriered + `.reference.md` regen).
- **C (invariants C1–C4):** all confirmed (sinceSeq raw/seq-ordered + latestSeq; one WS socket for
  surface+chat; turn-sealed after persist; deltas carry conversationId/turnId but no seq).
- **D (deferred):** `GET /conversations` list + `POST /conversations/:id/cancel` intentionally absent.
- **E (CORS):** wildcard `*` added to transport-http (user's call), verified live (OPTIONS→204 +
  headers on all routes incl. the NDJSON stream). HTTP=24203, WS=24205; no WS origin allow-list.
  Commit `812621c`.

### FE ask — step grouping (`stepId`) for batched tool calls  [x] DONE + verified live (`904c6d7`)
FE handoff (`../dispatch-web/backend-handoff.md` §3): render a model's parallel/batched tool
calls (the set emitted in ONE step) as a single grouped unit, on BOTH the live stream and
replayed history. Decisions (user, §5.2): **full scope (live + persisted)**; key = the
already-defined branded **`StepId`** derived `` `${turnId}#${stepIndex}` `` (0-based).

**Design pivot from the investigation (read-only multi-knowledge agent):** step boundaries do
NOT align with message boundaries in `RunTurnResult.messages` (a 2-step turn returns
`[assistant(2 calls), tool(r1), tool(r2), assistant(text)]`), and persistence is result-driven
(`orchestrator.append(result.messages)` once at turn end). So a `StoredChunk`-ENVELOPE `stepId`
was infeasible without enlarging `RunTurnResult` + `append` + the orchestrator. Chosen shape:
carry `stepId` **on the tool `Chunk` variants** (`ToolCallChunk`/`ToolResultChunk`) — generation
provenance, intrinsic to the chunk, so it rides `append`/`load`/`reconcile` for FREE (zero change
to `RunTurnResult`, `append`, orchestrator). `seq` stays the envelope sync cursor; `stepId` is
on-chunk provenance (distinct concepts — doc'd in wire + GLOSSARY).

- [x] **Contract (orchestrator):** `@dispatch/wire` — `stepId?: StepId` on `ToolCallChunk` +
  `ToolResultChunk` (optional: old rows / non-turn chunks); `stepId: StepId` (required) on
  `TurnToolCallEvent` + `TurnToolResultEvent`; `StepId` doc clarified (provenance vs cursor).
  Wire compiles in isolation. GLOSSARY `stepId` row added.
- [x] **Build wave (3 disjoint owner-agents, parallel, mimo-v2.5-pro — all compiled against the wire):**
  - **kernel-runtime:** mints `stepId=`${turnId}#${step}`` per step (run-turn.ts:365, via
    `StepContext.stepId`); stamps on tool-call chunk (126) + tool-result chunk (295) + both event
    factories (events.ts). +3 tests. reports/kernel-runtime.md.
  - **conversation-store:** confirmed chunk-carried `stepId` round-trips `append`/`load`/`loadSince`
    for FREE (whole-chunk JSON, no schema change); `reconcile` now copies a dangling call's `stepId`
    onto the synthesized result (exactOptional-safe). +4 tests. reports/conversation-store.md.
  - **cli:** added `stepId` to the `tool-call`/`tool-result` EVENT fixtures (render unchanged) +
    `@dispatch/wire` dep. reports/cli.md.
  - **NOT touched (confirmed):** session-orchestrator (envelope unchanged), transport-{http,ws,
    contract} (pass-through), storage-sqlite (generic KV).
- [x] **Post-wave (orchestrator):** full typecheck EXIT 0, **509 vitest + 89 bun**, biome 0/0, all
  agents in-lane, zero internal `@dispatch/*` mocks. Bumped `wire`+`transport-contract` `0.1.0→0.2.0`;
  regen FE `.dispatch/{wire,transport-contract}.reference.md`; courier reply
  `../dispatch-web/backend-handoff-reply.md`. **Live (host-bin :24233, real flash):** asked it to read
  2 files → flash **batched both `read_file` calls in ONE step** → 2 tool-call + 2 tool-result events
  all sharing `stepId` `turn-…#0`; 4 persisted tool chunks all carry it; live↔persisted cross-match ✓.
  The FE's exact use case (group a parallel batch by `stepId`) proven end-to-end.

### Per-step TTFT + decode timing (observability)  [x] DONE + verified live (`3ecc977`)
User ask (granularity follow-up): isolate time-to-first-token from generation time. Decisions
(user, §5.2): **observability-only** (trace-store, NO wire/contract change); **kernel/step
measured** (provider-agnostic, self-consistent); **first token = first text OR reasoning delta**.
- **kernel-runtime (owner, mimo-v2.5-pro):** in `executeStep`, opens a `ttft` child span of the
  step at stream start, ends it on the first text/reasoning delta (`firstToken:true`) and opens a
  `decode` child span (first token → stream end). `decode = generation total − TTFT`; both
  `durationMs` retrievable from the trace-store. No-content step (tool-call-only / pre-first-token
  error) ends `ttft` with `firstToken:false` and emits no misleading `decode`. **Span-based — no
  clock injection, no contract change** (runtime has no direct clock; logger's injected `now`
  drives span durations → deterministic tests). +3 runtime tests. (Agent left reports/ stale; impl
  independently verified.) prompts/ttft-kernel-runtime.md.
- TTFT is inherently per-step (each round-trip re-prefills): step 0's `ttft` = the turn's
  user-visible first-token latency; Σ`decode` = generation minus all prefill; Σ`ttft` = total prefill.
- **Verified (orchestrator):** typecheck EXIT 0, **512 vitest** (509→+3), biome 0/0, in-lane, no
  internal mocks. **Live (host-bin :24234, real flash):** journal carries balanced `ttft`/`decode`
  spans with valid `durationMs` (ttft 1090ms, decode 1673ms) + `firstToken:true`. GLOSSARY: TTFT,
  decode time. NOT on the wire (clients don't receive it) — a future wire+FE step if desired.

### Expose backend metrics to clients (timing/tokens) — Pass 1 DONE + verified live (`7c459c7`)
User ask: surface the backend's authoritative metrics (tokens, TTFT/decode, TPS, tool-exec +
turn durations) to clients (CLI/web FE). Decisions (user, §5.2):
- **Delivery = inline in the existing chat stream**, as distinct `AgentEvent` types/fields —
  push-everything, FE routes by `type` and ignores what it doesn't render (NOT a separate live
  endpoint, NOT a negotiation handshake — events are tiny/low-frequency, not per-token).
- **Carrier = a new `step-complete` event** (per-step end, ordering-safe timing) + additive fields.
- **Scope = LIVE now**; persisted-for-replay is a documented fast-follow (below).

#### Pass 1 — LIVE stream metrics  [x] DONE + verified live
Metric set (all wire fields additive/optional): per-step tokens (`usage` += `stepId`), per-step
`ttftMs`/`decodeMs`/`genTotalMs` (new `step-complete` event), tool-exec `durationMs` (`tool-result`),
turn `durationMs` + aggregate `usage` (`done`). TPS derived FE-side (`outputTokens/decodeMs`);
context-size proxy = `usage.inputTokens` (already present).
- [x] **Contracts (orchestrator):** `@dispatch/wire` — new `TurnStepCompleteEvent` (+ union);
  `stepId?` on `TurnUsageEvent`; `durationMs?` on `TurnToolResultEvent`; `durationMs?`+`usage?` on
  `TurnDoneEvent`. Kernel re-export shims (events.ts/index.ts) updated. `RunTurnInput.now?: () =>
  number` (additive optional clock — runtime has no clock today; needed to put real numbers on the
  wire). **Whole-graph typecheck clean** → new variant breaks NO consumer (no exhaustive switches;
  cli/transport unaffected). GLOSSARY: TTFT/decode already added.
- [x] **Build wave (2 disjoint owner-agents, parallel, mimo-v2.5-pro):**
  - **kernel-runtime:** emits `step-complete` per step (ttft/decode/genTotal), `stepId` on `usage`,
    `durationMs` on `tool-result`, `durationMs`+`usage` on `done`; gated on injected `now`; trace
    spans kept. +6 tests. reports/kernel-runtime.md.
  - **session-orchestrator:** `now?` on `SessionOrchestratorDeps`, threaded into `RunTurnInput`;
    extension `activate` injects `() => Date.now()`. +2 tests. reports/session-orchestrator.md.
  - **NOT touched (typecheck-confirmed):** transport-http/ws, cli, host-bin.
- [x] **Post-wave (orchestrator):** typecheck EXIT 0, **520 vitest** (512→+8) + 89 bun, biome 0/0,
  in-lane, no internal mocks. Bumped `wire`+`transport-contract` `0.2.0→0.3.0`; regen FE
  `.dispatch/{wire,transport-contract}.reference.md`; wrote **`frontend-metrics-handoff.md`** (in
  arch-rewrite root, for the user to courier — full FE consumption guide). **Live (host-bin :24235,
  real flash, tool turn):** 2 `step-complete` (genTotal==ttft+decode ✓), both `usage` carry
  `stepId`, `tool-result.durationMs=3`, `done.durationMs=3294`+turn `usage` (cacheRead 768),
  derived TPS≈107 tok/s. All green.

#### Pass 2 — DEFERRED: persisted metrics for REPLAY
Today usage/timing are NOT persisted (conversation-store stores chunks only), so reopening a past
conversation (`GET /conversations/:id`) shows messages but no metrics. To show historical
tokens/timing:
- Persist a per-turn (and/or per-step) metrics record in `conversation-store` (new storage shape —
  metrics are not chunks; e.g. a `conv:<id>:turn:<turnId>:metrics` key or a sibling namespace).
- Expose on the read path: a `metrics` field on `ConversationHistoryResponse`, or a sibling
  `GET /conversations/:id/metrics` (read endpoint = the right home for historical metrics, vs the
  live stream). New contract + transport-http route + conversation-store schema + FE.
- The trace-store already holds rich per-span timing durably; Pass 2 could alternatively expose a
  read slice of THAT rather than duplicating into conversation-store (decide at Pass-2 design time).
Sequenced after Pass 1 lands (and can ride alongside the FE-Slice work that consumes Pass 1).

### 3. dedup / storage growth (after frontend)
The deferred trace-body de-duplication + rotation/compression (D5 volume-control +
`prefix.fingerprint` + §6 retention strategy) — already designed in
`notes/observability-design.md`, not yet built. `cacheReadTokens` (committed) is the
cheap dedup signal; the workspace is ready.
