# LSP integration — design + plan

> Orchestrator-authored plan (notes/ is orchestrator-editable). Drives the
> `prompts/<unit>.md` TASK blocks. Status: AWAITING USER SIGN-OFF on the
> decisions in §6 before summoning.

## 1. Goal

A **general-purpose, config-driven LSP** (Language Server Protocol) integration that
is trivial to set up for any project, exposed to the agent as a tool and to the
frontend as status. Hard requirements:

- **MUST work for this repo** (`arch-rewrite`, TypeScript) — zero/low config.
- **MUST work for the Roblox project** (`/home/tradam/projects/roblox`, Luau via
  `luau-lsp`), including the bug opencode got wrong (§2).
- Frontend endpoint: is the LSP connected, and which servers are loaded **per tab**
  (per conversation).
- **Per-conversation CWD**: persist it, expose get/set to the frontend (this does
  not exist yet — cwd is currently per-turn only).
- Frontend **handoff** document.

## 2. The bug we must NOT reproduce (root cause, confirmed)

opencode's `client/registerCapability` handler ignores every registration except
`textDocument/diagnostic` (`references/opencode/.../lsp/client.ts:198-206` does
`continue` for anything else). It *declares* `workspace.didChangeWatchedFiles.
dynamicRegistration: true` (client.ts:249-251) but never honors the server's
watcher registration and never runs a real filesystem watcher. So when `luau-lsp`
registers a watch for `sourcemap.json` / `**/*.luau`, opencode silently drops it.
Disk changes never reach the server → stale sourcemap → `TypeError: Unknown
require` for any file created mid-session. (Confirmed against
`/home/tradam/projects/roblox/LUA_TOOLING.md:61-66`.)

**Our fix (spec-compliant, general — fixes sourcemap-style staleness for ANY
server):**
1. Declare `workspace.didChangeWatchedFiles.dynamicRegistration: true`.
2. **Honor** `client/registerCapability` / `unregisterCapability` for
   `workspace/didChangeWatchedFiles`: store the registered `watchers` (globPattern
   + kind).
3. Run a **real filesystem watcher** over the workspace root; on create/change/
   delete matching a registered glob, send a `workspace/didChangeWatchedFiles`
   notification with the correct `FileChangeType`.
4. Keep derived files fresh: optional per-server **`watch` sidecar command** (for
   Roblox: `rojo sourcemap <project> --watch -o sourcemap.json`). The Roblox docs
   only avoided `--watch` *because* opencode couldn't consume the updates — once
   (1-3) work, the sidecar + watcher close the loop with zero edits to the Roblox
   project.

## 3. Architecture (synthesized from old-dispatch + opencode references)

- **JSON-RPC over stdio**, LSP `Content-Length` framing. Lazy-spawn one server
  process per `(serverID, workspaceRoot)`; dedup concurrent spawns; track `broken`
  servers (no retry storm). Initialize handshake (45s timeout) → `initialized` →
  `workspace/didChangeConfiguration`.
- **Diagnostics:** push (`textDocument/publishDiagnostics`) + pull
  (`textDocument/diagnostic`), merged + deduped. `touchFile → didOpen/didChange →
  waitForDiagnostics`.
- **Server registry / matching:** by file extension + workspace-root markers.
  Workspace root = the conversation's cwd (or nearest root-marker ancestor up to
  cwd). Spawn cwd = workspace root.
- **Pure core / injected shell** (constitution): the protocol codec (framing,
  request/response correlation, capability-registration state machine, diagnostic
  merge) is a **pure module** tested with an injected in-memory duplex stream — no
  real child process, zero internal mocks. The edges (spawn child process, fs
  watcher, read file) are injected adapters.
- **Lifecycle/cleanup:** the extension owns its manager; child processes MUST be
  killed on shutdown (no leaked LSP/sidecar procs — cf. the bracket-trick scar
  tissue). Needs the host to call `deactivate()` on shutdown (verify; CR to
  host-bin if missing).

## 4. Units & waves (one owner per unit; single-writer)

**Wave 1 (parallel — disjoint packages, kernel-only deps):**
- **`conversation-store`** (existing, owner-summon): add per-conversation **cwd**
  persistence to its contract + impl + tests (`getCwd`/`setCwd`, separate key
  space). Exposes the typed surface session-orchestrator + transport-http consume.
- **`lsp`** (NEW extension): the whole LSP client/manager/registry/file-watcher/
  config-resolver + the model-facing `lsp` tool + a typed `lspServiceHandle`
  (`status(root)`, `diagnostics(...)`). Depends only on kernel contracts (uses
  `ctx.cwd`) + reads a per-cwd config file. The big unit.
- **`transport-contract`** (existing, types-only): add `CwdResponse`/`SetCwdRequest`
  and `LspStatusResponse` (per-tab loaded servers + connected status).

**Wave 2 (parallel — depend on wave 1):**
- **`transport-http`**: `GET`/`PUT /conversations/:id/cwd` (persist via
  conversation-store) + `GET /conversations/:id/lsp` (resolve conversationId→cwd→
  `lspServiceHandle.status(root)`).
- **`session-orchestrator`**: when `/chat` omits cwd, default to the persisted
  per-conversation cwd (load from conversation-store); persist cwd when provided.

**Wave 3 (composition):**
- **`host-bin`**: register `lsp` in `CORE_EXTENSIONS`; wire shutdown so LSP/sidecar
  procs are killed (deactivate). Orchestrator does the build wiring (root tsconfig
  ref for `packages/lsp`, `bun install`, any new dep, devDep
  `typescript-language-server` for live verification).

**Wave 4 (orchestrator):** full-graph typecheck/test/check; live-verify against
this repo (TS) + Roblox (luau-lsp); write the FE handoff.

## 5. Config & how each target works

- **This repo (zero config):** built-in `typescript` server definition (root
  markers `tsconfig.json`/`package.json`; command `typescript-language-server
  --stdio`), matched on `.ts`/`.tsx`.
- **Roblox (its existing config, ideally zero new setup):** read
  `<cwd>/.dispatch/lsp.json` if present, else fall back to `<cwd>/opencode.json`'s
  `lsp` key (the Roblox project already has it). When a server's
  `initialization.luau-lsp.sourcemap.autogenerate === true` with a
  `rojoProjectFile`, auto-spawn the `rojo sourcemap --watch` sidecar (the §2 fix).

## 6. DECISIONS FOR THE USER (boundary/granularity/scope — ORCHESTRATOR §5.2)

See the chat message accompanying this doc.
