# Dispatch

A **minimal kernel + extensions** agent runtime. The kernel runs one agent turn and hosts
extensions; every feature is an extension. Backend + a line-oriented CLI; a web frontend lives
in a separate repo and talks to the same typed contracts over HTTP + a surface WebSocket.

- **Stack:** Bun + TypeScript (strict, project references), Biome, Vitest, SQLite (`bun:sqlite`),
  the Vercel AI SDK for providers.
- **Architecture:** `kernel → core extensions → standard extensions`. The kernel touches no I/O
  and names no concrete feature; effects live in extensions, injected through typed contracts.
- **Tests:** 1453 vitest + bun:sqlite integration tests, zero internal mocks on pure-core packages.

---

## Prerequisites

- [Bun](https://bun.sh) (v1.3+).
- An OpenAI-compatible API key. The reference/default path is **OpenCode Go** (`/zen/go/v1`),
  whose `flash` models have generous limits.

```sh
git clone git@github.com:realtradam/dispatch.git
cd dispatch
bun install
```

---

## Quick start (dev)

1. **Create a `.env`** in the repo root (gitignored; see `.env.example`):

   ```sh
   DISPATCH_API_KEY=sk-...                         # your OpenAI-compatible API key (the secret)
   DISPATCH_BASE_URL=https://opencode.ai/zen/go/v1 # the provider base URL
   DISPATCH_MODEL=deepseek-v4-flash                # default model when a request omits one
   BACKEND_PORT=24203                              # HTTP server port (dev default)
   SURFACE_WS_PORT=24205                           # surface WebSocket port (dev default)

   # Optional — Umans AI Coding Plan provider (https://code.umans.ai)
   UMANS_API_KEY=sk-...                            # if set, the "umans" provider is registered
   ```

2. **Boot the server:**

   ```sh
   bun run dev          # = bun packages/host-bin/src/main.ts
   ```

   It loads config, activates every extension through the host, and serves HTTP on
   `BACKEND_PORT` (default 24203). It also spawns and supervises an out-of-process
   **observability collector** (restart-on-crash, drain-on-shutdown) and writes a structured
   journal to `.dispatch/journal/` plus a trace database. A collector failure never crashes the
   server. A **surface WebSocket** on `SURFACE_WS_PORT` (default 24205) carries live updates
   to connected frontends.

3. **Smoke-test it:**

   ```sh
   # list available models (the catalog)
   curl -s localhost:24203/models

   # one turn (NDJSON stream of events back); X-Conversation-Id header threads multi-turn
   curl -s -X POST localhost:24203/chat \
     -H 'content-type: application/json' \
     -d '{"conversationId":"c1","message":"Say hello in 3 words."}'
   ```

---

## Deploy as a systemd service (Arch Linux)

`bin/install` builds the binaries + frontend, installs them system-wide, and sets up a
systemd service.

```sh
sudo bin/install              # build + install + enable + start
sudo bin/install --no-build   # install only (skip the build step)
sudo bin/install --uninstall  # stop + disable + remove files (keeps config + data)
```

**What it installs:**

| Path | Description |
|---|---|
| `/usr/bin/dispatch-server` | Standalone backend binary (Bun compile) |
| `/usr/bin/dispatch` | Standalone CLI binary (Bun compile) |
| `/usr/share/dispatch/web/` | Built frontend static files |
| `/etc/dispatch/env` | Server config (systemd EnvironmentFile) |
| `/etc/systemd/system/dispatch.service` | systemd unit |
| `/var/lib/dispatch/` | Data directory (SQLite DBs) |
| `/var/log/dispatch/` | Journal + trace logs |

The production config (`systemd/dispatch.env`) uses ports **24991** (HTTP) and **24990**
(surface WS), distinct from the dev defaults (24203/24205). After install:

```sh
systemctl status dispatch
journalctl -u dispatch -f          # live logs
curl -s localhost:24991/health     # → {"ok":true}
```

`bin/sync-env` updates the API keys in `/etc/dispatch/env` without touching the ports.
`bin/setup-env` is the interactive first-time setup (prompts for keys, writes the env file).

---

## HTTP API

| Method & path | Body / params | Returns |
|---|---|---|
| `GET /health` | — | `{ "ok": true }` |
| `GET /models` | — | `{ "models": ["opencode/<model>", ...] }` — the catalog |
| `POST /chat` | `{ conversationId?, message, model?, cwd?, reasoningEffort? }` | NDJSON stream of `AgentEvent`s; resolved id in the `X-Conversation-Id` header |
| `POST /chat/warm` | `{ conversationId, model?, cwd? }` | Cache-warming result (tokens + cache %) |
| `GET /conversations` | `?q=<prefix>&status=<active|idle|closed>&workspaceId=<id>` | Conversation list |
| `GET /conversations/:id` | `?sinceSeq=<n>&beforeSeq=<n>&limit=<n>` | Conversation history (chunk log) |
| `GET /conversations/:id/status` | — | `{ conversationId, isActive, status }` |
| `GET /conversations/:id/last` | — | Last assistant message (blocks until turn settles) |
| `GET /conversations/:id/metrics` | — | Per-turn + per-step token/timing metrics |
| `GET /conversations/:id/cwd` | — | Persisted working directory |
| `PUT /conversations/:id/cwd` | `{ cwd, workspaceId? }` | Set working directory |
| `DELETE /conversations/:id/cwd` | — | Clear working directory |
| `GET /conversations/:id/model` | — | Persisted model selection |
| `PUT /conversations/:id/model` | `{ model }` | Set model selection |
| `GET /conversations/:id/reasoning-effort` | — | Persisted reasoning effort |
| `PUT /conversations/:id/reasoning-effort` | `{ reasoningEffort }` | Set reasoning effort |
| `GET /conversations/:id/lsp` | — | LSP server status for the conversation's cwd |
| `POST /conversations/:id/queue` | `{ message }` | Enqueue a steering message |
| `POST /conversations/:id/stop` | — | Stop generation (aborts in-flight turn) |
| `POST /conversations/:id/close` | — | Close conversation (aborts turn, marks closed) |
| `POST /conversations/:id/open` | — | Signal frontend to open a tab |
| `PUT /conversations/:id/title` | `{ title }` | Set conversation title |
| `POST /conversations/:id/compact` | — | Compact history (non-destructive fork + summary) |
| `GET /conversations/:id/compact-percent` | — | Auto-compaction threshold |
| `PUT /conversations/:id/compact-percent` | `{ percent }` | Set auto-compaction threshold |
| `GET /workspaces` | — | Workspace list |
| `PUT /workspaces/:id` | `{ title?, defaultCwd? }` | Create/update workspace |
| `GET /workspaces/:id` | — | Workspace detail |
| `PUT /workspaces/:id/title` | `{ title }` | Rename workspace |
| `PUT /workspaces/:id/default-cwd` | `{ defaultCwd }` | Set workspace default cwd |
| `DELETE /workspaces/:id` | — | Delete workspace (closes conversations, reassigns to default) |
| `GET /system-prompt` | — | Current system prompt template |
| `PUT /system-prompt` | `{ template }` | Set system prompt template |
| `GET /system-prompt/variables` | — | Available template variables |
| `GET /metrics/throughput` | — | Aggregate throughput metrics |

The request/response shapes are the `@dispatch/transport-contract` package — import it to build
any new frontend.

---

## Use the CLI

The CLI (`packages/cli`) is a one-shot HTTP client of the server above, so **the server must be
running** (the CLI reads `BACKEND_PORT`, or pass `--server <url>`).

```
Usage:
  dispatch models [--server <url>]
  dispatch list [<prefix>] [--status <active|idle|closed>] [--all] [--server <url>]
  dispatch stop <conversationId> [--server <url>]
  dispatch compact <conversationId> [--server <url>]
  dispatch read <conversationId> [--server <url>]
  dispatch open <conversationId> [--server <url>]
  dispatch send <conversationId> --text "..." [--queue] [--open] [--cwd <dir>] [--effort <level>] [--workspace <id>] [--server <url>]
  dispatch <modelName> --text "..." [--file <path>] [--cwd <dir>] [--conversation <id>] [--effort <level>] [--workspace <id>] [--server <url>] [--show-reasoning] [--open]
  dispatch --help

Effort levels: low, medium, high (default), xhigh, max
```

- **`<modelName>`** is a **model name** in `<credentialName>/<model>` form — exactly a line from
  `dispatch models` (e.g. `opencode/deepseek-v4-flash`).
- **`send <id> --text "..."`** sends a message to an existing conversation (`--queue` for
  non-blocking enqueue, `--open` to signal the frontend to open a tab).
- **`read <id>`** blocks until the turn settles, then prints the last assistant message.
- **`list`** shows conversations (short ID + title + activity); `--status` filters, `--all`
  includes closed.
- **`compact <id>`** manually compacts a conversation's history.
- **`--effort`** sets reasoning effort for the turn (low|medium|high|xhigh|max; default high).
- **`--workspace <id>`** scopes the conversation to a workspace.

### Examples

```sh
# see what you can talk to
bun run dispatch -- models

# a quick chat
bun run dispatch -- opencode/deepseek-v4-flash --text "Say hello in 3 words."

# let the model read a file in a given directory (uses the read_file tool, contained to --cwd)
bun run dispatch -- opencode/deepseek-v4-flash --cwd ./src --text "Read main.ts and summarize it."

# continue a conversation (id is printed after each turn)
bun run dispatch -- opencode/deepseek-v4-flash --conversation <id> --text "and in French?"

# list conversations, read the last reply, send a queued message
bun run dispatch -- list
bun run dispatch -- read <id>
bun run dispatch -- send <id> --text "follow up" --queue --open
```

---

## Web frontend (dispatch-web)

The web UI is a **separate repo** ([github.com/realtradam/dispatch-web](https://github.com/realtradam/dispatch-web),
Svelte 5 + Vite + DaisyUI), built to the same methodology and consuming the backend's typed contracts
(`@dispatch/wire`, `@dispatch/transport-contract`, `@dispatch/ui-contract`). The browser chat MVP
is in progress — it streams turns over the chat WebSocket, renders the surface system (loaded
extensions, cache-warming controls, message queue, todo list), and supports conversation lifecycle,
workspaces, LSP status, and per-conversation settings.

**Run both at once with live reload:** clone both repos as siblings, then from the workspace root:

```sh
git clone git@github.com:realtradam/dispatch.git
git clone git@github.com:realtradam/dispatch-web.git
bin/up      # backend (bun --watch :24203 + WS :24205) + frontend (vite HMR :24204)
```

`bin/up2` starts a second, stable stack on ports 25203/25205/25204 with isolated data — runs
alongside `bin/up` without interference. Both Ctrl-C cleanly (including the collector child).

Then open **http://localhost:24204** (or your Tailscale hostname). See the
[dispatch-web README](https://github.com/realtradam/dispatch-web#readme) for full setup.

---

## Packages

### Kernel & extensions

The **Depends on** column is each extension's manifest `dependsOn` (other extensions, resolved
topologically at activation). Every extension also depends implicitly on the kernel ABI.

#### Kernel (not an extension)

| Package | Description |
|---|---|
| **kernel** | The minimal runtime core — contracts (the ABI), the extension host, the turn loop (`runTurn`), and the event/hook/service bus; touches no I/O and names no concrete feature. |

#### Core extensions (minimum to complete one turn end-to-end)

| Package | Description | Depends on |
|---|---|---|
| **storage-sqlite** | Concrete `bun:sqlite` backend behind the kernel's storage interface (a host bootstrap dependency; its `activate` is an intentional no-op). | — |
| **auth-apikey** | Resolves an API key (the secret) from the environment into `ApiKeyCredentials` for a provider to consume. | — |
| **credential-store** | Owns named **credentials** and the **model catalog** — resolves a `<credential>/<model>` model name to a provider + model and aggregates `GET /models`. | — |
| **provider-openai-compat** | Wraps an OpenAI-compatible LLM backend (streaming chat + `listModels`); the OpenCode Go path. | auth-apikey |
| **conversation-store** | Append-only persistence of the turn/chunk log, with a pure `reconcile` that repairs any interrupted turn on load. | — |
| **session-orchestrator** | Drives one turn end-to-end: load history → resolve provider/model/tools → call `runTurn` → persist. | conversation-store, credential-store |
| **transport-http** | Hono HTTP transport exposing `POST /chat` (NDJSON event stream), `GET /models`, and the full conversation/workspace/LSP/system-prompt API. | session-orchestrator |

#### Standard extensions (shipped on-by-default)

| Package | Description | Depends on |
|---|---|---|
| **tool-read-file** | `read_file` tool with offset/limit pagination, directory listing, and workdir containment. | — |
| **tool-shell** | `run_shell` tool — foreground, streamed output, process-group kill on abort/timeout. | — |
| **tool-edit-file** | `edit_file` tool — exact-string replacement, `replaceAll` flag, workdir-contained. | — |
| **tool-write-file** | `write_file` tool — explicit `overwrite` flag, no parent auto-create. | — |
| **tool-web-search** | `web_search` tool — Firecrawl-backed (search, scrape, crawl, map). | — |
| **tool-youtube-transcript** | `youtube_transcript` tool — fetches transcripts from a transcriber service. | — |
| **todo** | `todo_write` tool — per-conversation task list with a surface. | surface-registry |
| **skills** | `load_skill` tool + per-turn tools filter that rewrites the skill list per cwd. | session-orchestrator |
| **system-prompt** | Template-based system prompt builder with variable placeholders (`[type:name]`) and conditionals. | — |
| **cache-warming** | Per-conversation prompt-cache warming timers + manual trigger (`POST /chat/warm`) + a surface. | session-orchestrator, surface-registry |
| **message-queue** | Per-conversation steering queue + surface; enqueue when idle starts a new turn. | surface-registry |
| **lsp** | Language Server Protocol client (hand-rolled JSON-RPC over stdio) — lazy-spawn, per-cwd config, diagnostics, `lsp` tool. | — |
| **provider-umans** | Umans OpenAI-compatible provider (`api.code.umans.ai`); self-contained (reads `UMANS_API_KEY` from env). | — |
| **surface-registry** | In-process registry where extensions contribute UI **surfaces** (frontend-agnostic data); exposes a typed `surfaceRegistryHandle` service. | — |
| **transport-ws** | WebSocket transport serving the surface catalog + per-surface subscribe / update / invoke to clients. | surface-registry |
| **surface-loaded-extensions** | Contributes the live "Loaded Extensions" surface (a `stat` per activated extension). | surface-registry |
| **throughput-store** | Aggregate throughput metrics storage + `GET /metrics/throughput`. | — |

### Supporting packages (not extensions)

The **Depends on** column is each package's `@dispatch/*` workspace dependencies.

| Package | Description | Depends on |
|---|---|---|
| **wire** | Types-only wire ABI (`AgentEvent` + conversation model + `Usage`); kernel + transport-contract re-export it so clients consume the wire without the kernel runtime. | — |
| **transport-contract** | Types-only description of the full HTTP API shared by the server and every client. | wire, kernel |
| **ui-contract** | Types-only, **frontend-agnostic** vocabulary for backend-declared **surfaces** (`SurfaceSpec`, field kinds, the surface WS protocol). | — |
| **openai-stream** | Generic OpenAI-compatible stream/convert/listModels library extracted from `provider-openai-compat` (shared by `provider-umans`). | wire |
| **cli** | The bundled one-shot terminal client documented above. | transport-contract |
| **host-bin** | The composition root: loads config, activates all extensions through the host, serves HTTP, and supervises the observability collector. | kernel, all extensions, journal-sink |
| **journal-sink** | Bootstrap `LogSink` that appends structured logs/spans to an NDJSON journal (rotation, fail-safe). | kernel |
| **observability-collector** | Out-of-process binary that tails the journal and inserts records into the trace store (idempotent, at-least-once). | kernel, trace-store |
| **trace-store** | `bun:sqlite` store for trace records/bodies (content-addressed dedup + retention), plus a `trace` CLI. | kernel |
| **trace-replay** | Generic HTTP-exchange record/replay library for hermetic, network-free provider tests. | — |

---

## Development

```sh
bun run typecheck   # tsc -b --pretty
bun run test        # vitest (pure/unit + integration)
bun run test:bun    # bun:sqlite-backed tests
bun run test:all    # both test suites
bun run check       # biome (lint + format)
bun run check:fix   # biome --write (auto-fix)
```

### Dev stacks

| Script | Backend | Frontend | Notes |
|---|---|---|---|
| `bin/up` | `:24203` + WS `:24205` (`bun --watch`) | `:24204` (vite HMR) | Full restart on backend change; loads external extensions if configured |
| `bin/up2` | `:25203` + WS `:25205` (no watch) | `:25204` (vite preview) | Stable second stack; isolated data; runs alongside `bin/up` |

### Workspace layout

Clone these repos as siblings:

```
dispatch/                  workspace root (shared bin/ scripts)
├── dispatch/              this repo — backend (branch dev)
├── dispatch-web/          [github.com/realtradam/dispatch-web](https://github.com/realtradam/dispatch-web) — web frontend
└── bin/                   shared dev scripts (up, up2)
```

---

## Documentation

- **Design & rationale:** `notes/restructure-plan.md`
- **Agent constitution (build rules):** `AGENTS.md`
- **Orchestration workflow:** `ORCHESTRATOR.md`
- **Canonical vocabulary:** `GLOSSARY.md`
- **Live status / task log:** `tasks.md`
- **Observability design:** `notes/observability-design.md`
- **LSP design:** `notes/lsp-design.md`
- **System prompt design:** `notes/system-prompt-design.md`
- **Turn continuity design:** `notes/turn-continuity-design.md`
- **CLI design:** `notes/cli-design.md`
- **Frontend design:** `notes/frontend-design.md`
