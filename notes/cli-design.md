# CLI — Design Scratch

> **Status:** ✅ **MVP BUILT + verified live** (2026-06-05). All §3 decisions implemented; the
> §4 unit plan landed (501 tests green; live CLI: models / chat / --file / --cwd / --conversation).
> Vocab promoted to `GLOSSARY.md`; milestone logged in `tasks.md` (ROADMAP §1). This file
> remains the CLI design HOME — future CLI work (e.g. `dispatch serve`, conversation listing,
> richer rendering) starts here.
>
> **Read order (fresh agent picking this up):** `ORCHESTRATOR.md` → `AGENTS.md` (the
> backend methodology we are MIRRORING) → `GLOSSARY.md` → this file.
> **Mode = IDEATION WITH the user** (design/discuss, do NOT build yet). The user owns the
> boundary (§5.2) + vocabulary (§5.6) calls.
> **Constraints:** line-oriented CLI (NOT a TUI); may have basic selectors for e.g.
> picking a conversation, but standard/basic stuff only. Same methodology as the backend
> (minimal core, pure-core/inject-effects, typed contracts, one owner per unit,
> asymmetric testing).

---

## 0. Goal
A terminal CLI client for Dispatch: send a message, stream the multi-turn response
(`conversationId`). Interactive: you're in a chat session, type a line, hit enter, see
the streamed response line-by-line.

## 1. Hard constraints (mirroring the backend methodology)
- **Minimal core + feature modules.** Core = message loop + transport client + state
  manager; features = output renderers, conversation picker, etc. Core never references
  a concrete output mechanism directly — injected.
- **Typed contracts as the only cross-unit surface.** Cross-module coupling anchored to
  typed symbols (no string keys). The CLI↔backend seam is the `AgentEvent` union +
  `/chat` NDJSON stream — ideally a shared typed contract so `lsp references` spans the
  boundary.
- **Pure-core / inject-effects / no ambient state.** Pure functions for every decision
  (format output, merge state, parse input), zero I/O; the shell = `readline`/`stdin` +
  `fetch` transport + `stdout`/`process.stdout.write` + filesystem — all injected.
- **One owner per unit; asymmetric testing** — strict zero-internal-mock on pure logic;
  lenient integration on the shell.

## 1.5 Locked inputs (user, 2026-06-05)
- **Bundled package.** The CLI is `packages/cli/` — shipped so Dispatch is usable at the
  "bare minimum". The **web frontend lives in a SEPARATE repo** (not in this monorepo).
- **Command shape (user's stated UX):**
  - `dispatch models` (working title) → **view the model catalog**: a list shown as
    `key-name/model`.
  - `dispatch <model> --text "…" | --file <path> [--text+--file both] [--cwd <dir>]` →
    send one message. `<model>` is the **required** identifier copied from the catalog.
    `--text` and/or `--file` supply the message; `--cwd` defaults to the process CWD.

## 1.6 Backend surface audit (grounding — what exists TODAY) + gaps

### What the backend exposes right now
- **The ONLY client-facing surface is one HTTP route:** `POST /chat`, body
  `ChatCommand = { conversationId: string; message: string }` (omit `conversationId` →
  server mints one), response = **NDJSON stream** of `AgentEvent` JSON lines +
  `X-Conversation-Id` response header. No other routes (no models, no conversations, no
  cancel — the old `/chat/cancel|stop|warm` were NOT rebuilt).
- **`AgentEvent`** union (the render contract) = `status | turn-start | text-delta |
  reasoning-delta | tool-call | tool-result | tool-output | usage | error | done |
  turn-sealed`, each carrying `conversationId` (+ `turnId` on turn events).
- **Internal seams (NOT over HTTP):** `SessionOrchestrator.handleMessage({ conversationId,
  text, onEvent, signal })` — **no model param, no cwd**; `resolveProvider()` is
  model-agnostic (`selectFirstProvider`). `HostAPI` has `getProviders()/getTools()/
  getAuthProviders()/getAuthProvider(id)`. `ProviderContract = { id, stream(msgs, tools,
  opts?) }` — **no model catalog** (a provider can't enumerate its models).
- **Already model-ready at the kernel layer:** `ProviderStreamOptions.model?` exists and
  `runTurn` forwards it verbatim — selection just isn't threaded through transport/orch.
- **`ToolExecuteContext = { toolCallId, onOutput, signal, log }` — no `cwd`.** The one
  tool (`read_file`) bakes its workdir at activate (`createReadFileTool(workdir)`) → cwd
  is process-global, not per-request.

### Gaps the CLI's UX requires (each = a decision below)
| CLI feature | Backend gap | Likely change |
|---|---|---|
| `dispatch models` (catalog) | No catalog source; no route | NEW: catalog source (config list / provider method / new ext?) + `GET /models` |
| `<model>` required param | `/chat` ignores model; orch picks first provider | `ChatCommand.model`; `handleMessage(model)`; `resolveProvider(model)` (contract fan-out) |
| `--text` | maps to `message` | none |
| `--file` | — | CLI-side: read file, fold into the message text (no backend change for basic case) |
| `--cwd` | no per-turn cwd; tools cwd-baked at activate | DEEP: thread cwd `/chat`→orch→tool (`ToolExecuteContext.cwd`? per-turn toolset?) |

## 1.7 Emerging target — new backend surfaces the CLI needs
Resolution chain for a chat: **model name `<credentialName>/<model>`** → look up the
`credential` by name → its provider + `key` → run that provider with the key and
`providerOpts.model = <model>`.
- **`ProviderContract.listModels(): Promise<ModelInfo[]>`** — additive contract change; each
  provider extension implements it ITS OWN way (per user Q4), using the credential's key.
- **Credential registry:** named credentials → `{ provider, key, baseURL? }`. MVP: host-bin
  hardcodes ONE (from `DISPATCH_API_KEY`); FUTURE: a TOML. Lookup: credential name → key+provider.
- **`GET /models`** (transport-http) → the model catalog as `<credentialName>/<model>` entries.
- **`/chat` body gains `model: "<credentialName>/<model>"`**; orchestrator resolves the
  credential→provider+key and the model→`providerOpts.model`. Fan-out: `ChatCommand`,
  `SessionOrchestrator.handleMessage`, `SessionOrchestratorDeps.resolveProvider`.
- **`cwd`** on `RunTurnInput` → `ToolExecuteContext.cwd` (cache-safe; never enters the prompt).
- **CLI-side only (no backend change):** `--file` (read + fold into the message), arg parse,
  NDJSON event→terminal render.

## 2. Open questions / FORKS (DECIDE in the design pass)
All backend-surface forks are RESOLVED (see §3). Remaining = CLI-internal + small UX:

**Secondary (deciding now):**
- **Pure/shell split:** pure = arg parse, event→render reducer, catalog formatting, state;
  shell = stdin/readline, fetch/NDJSON stream, stdout/ANSI, fs (file read), spawn.
- **Conversation continuity:** does the CLI remember/resume a `conversationId` across runs?
  If so, need a local store and possibly `GET /conversations` to list them.
- **Output rendering:** how to show tool-call/tool-output/reasoning vs plain text deltas.
- **Testing:** vitest for pure logic; thin integration via `trace-replay`-style fixtures.
- **Harness artifacts:** `.dispatch/rules/cli-*.md`, GLOSSARY terms, ORCHESTRATOR additions.

## 3. Decisions settled (user, 2026-06-05)
- **Placement:** `packages/cli/` (bundled). Web FE = separate repo.
- **Coupling = HTTP for BOTH clients.** CLI + web are HTTP clients of host-bin's routes —
  shared endpoints/types, backend is the single source of truth, less total work. Tradeoff:
  the server must be running → mitigate later with `dispatch serve`/auto-spawn (deferred).
- **Invocation = one-shot only.** `dispatch <modelName> --text|--file [--cwd]` → stream → exit.
  Multi-turn by re-passing a `conversationId`.
- **Vocabulary (user-chosen; promote to GLOSSARY when we build):**
  - **credential** = a named credential profile `{ name, provider, key, baseURL? }`
    (config-defined; many allowed, even of the same provider). Its name = the credential name.
  - **key** = the API key (the secret) held inside a credential.
  - **model name** = the selectable identifier the catalog lists and the CLI takes, of the
    form `<credentialName>/<model>`.
  - **model catalog** = the list of available model names.
- **Selection.** MVP hardcodes ONE credential (from `DISPATCH_API_KEY`) but is invoked the
  SAME way (`<credentialName>/<model>`); TOML multi-credential config is FUTURE.
- **Catalog source = per-provider extension.** Each provider is its own extension and owns
  its model-listing (`listModels()`); the catalog aggregates credentials × that provider's
  models. (generic-vs-opencode-go layering = the remaining fork in §2.)
- **`--cwd` = Option 1: `cwd` on the turn input + `ToolExecuteContext`** (kernel passes it
  through, never interprets it). **Cache-safe** — `cwd` flows to tool execution only, never
  into the model prompt (messages/system/tool-defs), so it does NOT bust the prompt cache.
- **B1 wire contract = new types-only `packages/transport-contract`** (zero runtime): the
  typed description of the HTTP API (request bodies + `/models` response; re-exports
  `AgentEvent` as the stream payload). Imported by transport-http (server), the CLI, and the
  future web repo → "dead simple to create new frontends." Each side owns its own
  (de)serialization (no shared helper — isolation-over-DRY).
- **B2 credential registry = new `credential-store` core extension.** Separation of concerns:
  `auth-apikey` owns the SECRET (key); `credential-store` owns the NAMED PROFILE (name →
  provider binding) + catalog aggregation; the `provider` lists/streams using its key. MVP:
  host-bin injects ONE credential `{ name, providerId:"openai-compat" }` (name configurable,
  default `"opencode"`); the future TOML grows it (and may then own keys too).
- **B3 multi-turn = `--conversation <id>` + print the returned id.** No new backend route
  (conversation-store already threads history by id).
- **Command UX** as in §1.5.

## 4. Unit plan (LOCKED)

### 4.1 Contract changes (orchestrator-owned, `packages/kernel/src/contracts/`)
- **provider.ts** — add `ModelInfo { id; displayName? }` + `ProviderContract.listModels():
  Promise<readonly ModelInfo[]>` (additive/minor). Doc-note: future per-credential
  `listModels(creds)` when multi-credential lands (today the provider uses its own key).
- **runtime.ts** — add `RunTurnInput.cwd?: string` (passthrough; kernel never interprets it —
  stays pure).
- **tool.ts** — add `ToolExecuteContext.cwd?: string` (tools resolve paths against it; fall
  back to their activate-time workdir when absent). Cache-safe (never enters the prompt).
- After edits → `lsp references` each changed symbol → dispatch the fan-out.

### 4.1b New types-only contract package (B1) — `packages/transport-contract` (orchestrator-authored)
- `ChatRequest { conversationId?: string; message: string; model?: string; cwd?: string }`
- `ModelsResponse { models: readonly string[] }`  (each = a model name `<credName>/<model>`)
- re-export `type { AgentEvent }` from `@dispatch/kernel` (the NDJSON stream payload).
- Zero runtime; both server and clients implement their own (de)serialization.

### 4.2 Owner-agent units (one writer each; pure-core/injected-shell; feature-as-a-library)
| Unit | Owns | Job | Tests |
|---|---|---|---|
| kernel-runtime | `kernel/src/runtime/*` | thread `RunTurnInput.cwd` → `ToolExecuteContext.cwd` | fake tool sees ctx.cwd |
| provider-openai-compat | its pkg | implement `listModels()` (GET `{baseURL}/v1/models`); KEEP opencode-go specifics; add deferred-split CODE NOTE | hermetic fetch-mock |
| credential-store (B2) | new/owner | named credentials + `resolve(modelName)→{providerId,model}` + `listCatalog()→modelName[]`; typed service handle; MVP = 1 cred from env | pure resolve/split + catalog |
| session-orchestrator | its pkg | `handleMessage` gains `modelName`+`cwd`; resolve via credential-store; thread cwd→RunTurnInput | pure + integration |
| transport-http | its pkg | `/chat` body +`model?`+`cwd?`; new `GET /models` (catalog) | parse + route |
| tool-read-file | its pkg | use `ctx.cwd ?? bakedWorkdir` for resolution + containment | pure path tests |
| host-bin | `main.ts` | register credential-store; wire 1 hardcoded credential (name+provider+key from env); load order | boot |
| **cli (NEW `packages/cli/`)** | new pkg | PURE: argv parse, `AgentEvent`→render reducer, request builder, catalog formatter. SHELL: fs (`--file`,cwd), fetch NDJSON client, stdout | pure (zero mock) + thin integration via injected fetch |

### 4.3 Build order (two milestones)
- **M1 — backend surface (curl-verifiable):** §4.1 contracts → **∥** {kernel-runtime · provider
  listModels · tool ctx.cwd · credential-store} → session-orchestrator → **∥** {transport-http ·
  host-bin}. Verify: `GET /models`; `curl /chat {model:"<cred>/<model>", message, cwd}`;
  read_file honoring cwd.
- **M2 — CLI:** `packages/cli` (HTTP client). Depends only on the wire contract → can build **∥**
  with M1's tail; integration-tested live once the server is up. Verify: `dispatch models`,
  `dispatch <cred>/<model> --text|--file [--cwd]`, multi-turn via `--conversation`.

### 4.4 Proposed UX defaults (veto welcome — not boundary calls)
- **Render:** stream assistant text; show tool-call/result compactly; usage line at end;
  reasoning behind `--show-reasoning`. (Decision B-render if you want different.)
- **`--text` + `--file`:** message = text, then a labeled file block; either alone is valid.
- **Server URL:** default `http://localhost:${BACKEND_PORT:-24203}`; `--server` to override.
- **No local HTTP auth** for localhost MVP (note it; revisit if exposed).

### 4.5 Boundary decisions (RESOLVED — see §3)
- **B1** → new types-only `packages/transport-contract` (§4.1b).
- **B2** → new `credential-store` core extension (auth-apikey keeps the secret; credential-store
  owns name→provider + catalog).
- **B3** → `--conversation <id>` + print the returned id; no new backend route.

### 4.6 Contract shapes to be authored (orchestrator; veto before they hit the ABI)
- kernel `provider.ts`: `ModelInfo { id: string; displayName?: string }`;
  `ProviderContract.listModels(): Promise<readonly ModelInfo[]>`.
- kernel `runtime.ts`: `RunTurnInput.cwd?: string`.  kernel `tool.ts`: `ToolExecuteContext.cwd?: string`.
- `transport-contract`: as §4.1b.
- `credential-store` service (`credentialStoreHandle`): `resolve(modelName: string):
  { providerId: string; model: string } | undefined` (split on first "/", look up credential);
  `listCatalog(): Promise<readonly string[]>` (per credential → its provider's `listModels()`
  → `<credName>/<id>`). Sync resolve (map+split), async catalog (providers are async).
