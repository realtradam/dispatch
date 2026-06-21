# Dispatch

A **minimal kernel + extensions** agent runtime. The kernel runs one agent turn and hosts
extensions; every feature is an extension. Backend + a line-oriented CLI; a web frontend lives
in a separate repo and talks to the same typed contracts over HTTP + a surface WebSocket.

- **Stack:** Bun + TypeScript (strict, project references), Biome, Vitest, SQLite (`bun:sqlite`),
  the Vercel AI SDK for providers.
- **Architecture:** `kernel → core extensions → standard extensions`. The kernel touches no I/O
  and names no concrete feature; effects live in extensions, injected through typed contracts.

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

## Deploy the server

1. **Create a `.env`** in the repo root (it is gitignored):

   ```sh
   DISPATCH_API_KEY=sk-...                         # your OpenAI-compatible API key (the secret)
   DISPATCH_BASE_URL=https://opencode.ai/zen/go/v1 # the provider base URL
   DISPATCH_MODEL=deepseek-v4-flash                # default model when a request omits one
   BACKEND_PORT=24203                              # port the HTTP server listens on
   FRONTEND_PORT=24204                             # reserved for the future web UI

   # Optional — Umans AI Coding Plan provider (https://code.umans.ai)
   UMANS_API_KEY=sk-...                            # if set, the "umans" provider is registered
   # UMANS_BASE_URL=https://api.code.umans.ai/v1   # override the default base URL
   # UMANS_MODEL=umans-coder                       # default model (umans-coder|umans-kimi-k2.7|umans-glm-5.2|umans-flash)
   ```

   Bun auto-loads `.env`. (If your shell also needs the vars: `set -a; source .env; set +a`.)

2. **Boot the server:**

   ```sh
   bun run dev          # = bun packages/host-bin/src/main.ts
   ```

   It loads config, activates every extension through the host, and serves HTTP on
   `BACKEND_PORT`. It also spawns and supervises an out-of-process **observability collector**
   (restart-on-crash, drain-on-shutdown) and writes a structured journal to `.dispatch/journal/`
   plus a trace database. A collector failure never crashes the server.

   ```
   Dispatch listening on http://localhost:24203
   ```

   It also serves a **surface WebSocket** on `:24205` (the `transport-ws` extension) — the channel
   the web frontend uses to discover and render backend-declared *surfaces*.

3. **Smoke-test it:**

   ```sh
   # list available models (the catalog)
   curl -s localhost:24203/models

   # one turn (NDJSON stream of events back); X-Conversation-Id header threads multi-turn
   curl -s -X POST localhost:24203/chat \
     -H 'content-type: application/json' \
     -d '{"model":"opencode/deepseek-v4-flash","message":"Say hello in 3 words."}'
   ```

### HTTP API (for any client)

| Method & path | Body / params | Returns |
|---|---|---|
| `GET /models` | — | `{ "models": ["opencode/<model>", ...] }` — the model catalog |
| `POST /chat` | `{ conversationId?, message, model?, cwd? }` | NDJSON stream of `AgentEvent`s; resolved id in the `X-Conversation-Id` header |

The request/response shapes are the `@dispatch/transport-contract` package — import it to build
any new frontend.

---

## Use the CLI

The CLI (`packages/cli`) is a one-shot HTTP client of the server above, so **the server must be
running** (the CLI reads `BACKEND_PORT`, or pass `--server <url>`). Run it via:

```sh
bun run dispatch -- <args>
# or directly:
bun packages/cli/src/main.ts <args>
```

### Commands

```
dispatch models [--server <url>]
dispatch <modelName> --text "..." [--file <path>] [--cwd <dir>] [--conversation <id>] [--server <url>] [--show-reasoning]
dispatch --help
```

- **`<modelName>`** is a **model name** in `<credentialName>/<model>` form — exactly a line from
  `dispatch models` (e.g. `opencode/deepseek-v4-flash`).
- **`--text`** and/or **`--file`** supply the message (at least one is required); `--file` folds
  the file's contents into the message.
- **`--cwd`** sets the working directory for tools this turn (defaults to the current directory).
- **`--conversation <id>`** continues a prior conversation; each turn prints its id so you can
  pass it back.
- **`--show-reasoning`** also prints the model's reasoning stream (hidden by default).

### Examples

```sh
# see what you can talk to
bun run dispatch -- models

# a quick chat
bun run dispatch -- opencode/deepseek-v4-flash --text "Say hello in 3 words."

# let the model read a file in a given directory (uses the read_file tool, contained to --cwd)
bun run dispatch -- opencode/deepseek-v4-flash --cwd ./src --text "Read main.ts and summarize it."

# attach a file's contents to your message
bun run dispatch -- opencode/deepseek-v4-flash --file notes.md --text "Summarize this."

# continue a conversation (id is printed after each turn)
bun run dispatch -- opencode/deepseek-v4-flash --conversation <id> --text "and in French?"
```

---

## Web frontend (dispatch-web)

The web UI is a **separate repo** at `../dispatch-web` (Svelte 5 + Vite), built to the same
methodology and consuming the backend's typed contracts. As of slice 1 it renders the backend's
**surface system** (e.g. the live "Loaded Extensions" surface); chat UI is a later slice.

It needs **this server running** — it connects to the surface WebSocket on `:24205`. To run both:

```sh
# terminal 1 — backend (this repo)
bun run dev                       # HTTP :24203 + surface WS :24205

# terminal 2 — frontend (sibling repo)
cd ../dispatch-web
bun install                       # links @dispatch/ui-contract via a file: dep to this repo
bun run dev                       # Vite dev server on http://localhost:24204
```

Then open **http://localhost:24204**. See `../dispatch-web/README.md` for full setup, including
visiting over a LAN / Tailscale.

**Or run both at once with live reload:** `bin/up` (also `bun run dev:all`) starts the backend
(`bun --watch`) and the frontend (Vite HMR) together and **Ctrl-C stops both** — including the
backend's observability collector. (The backend reloads via a full process restart; the frontend
hot-reloads in place.)

---

## Packages

### Kernel & extensions

The **Depends on** column is each extension's manifest `dependsOn` (other extensions, resolved
topologically at activation). Every extension also depends implicitly on the kernel ABI.

| Package | Tier | Description | Depends on |
|---|---|---|---|
| **kernel** | kernel | The minimal runtime core — contracts (the ABI), the extension host, the turn loop (`runTurn`), and the event/hook/service bus; touches no I/O and names no concrete feature. | — |
| **storage-sqlite** | core | Concrete `bun:sqlite` backend behind the kernel's storage interface (a host bootstrap dependency; its `activate` is an intentional no-op). | — |
| **auth-apikey** | core | Resolves an API key (the secret) from the environment into `ApiKeyCredentials` for a provider to consume. | — |
| **credential-store** | core | Owns named **credentials** and the **model catalog** — resolves a `<credential>/<model>` model name to a provider + model and aggregates `GET /models`. | — |
| **provider-openai-compat** | core | Wraps an OpenAI-compatible LLM backend (streaming chat + `listModels`); the OpenCode Go path, holding opencode-go specifics for now. | auth-apikey |
| **conversation-store** | core | Append-only persistence of the turn/chunk log, with a pure `reconcile` that repairs any interrupted turn on load. | — |
| **session-orchestrator** | core | Drives one turn end-to-end: load history → resolve provider/model/tools → call `runTurn` → persist. | conversation-store, credential-store |
| **transport-http** | core | Hono HTTP transport exposing `POST /chat` (NDJSON event stream) and `GET /models` (the catalog). | credential-store, session-orchestrator |
| **tool-read-file** | standard | A `read_file` tool with offset/limit pagination and two-layer workdir containment, honoring the per-turn `cwd`. | — |
| **surface-registry** | standard | In-process registry where extensions contribute UI **surfaces** (frontend-agnostic data); exposes a typed `surfaceRegistryHandle` service. | — |
| **transport-ws** | standard | WebSocket transport (`:24205`) serving the surface catalog + per-surface subscribe / update / invoke to clients. | surface-registry |
| **surface-loaded-extensions** | standard | Contributes the live "Loaded Extensions" surface (a `stat` per activated extension) — the first real surface. | surface-registry |

### Supporting packages (not extensions)

The **Depends on** column is each package's `@dispatch/*` workspace dependencies.

| Package | Description | Depends on |
|---|---|---|
| **transport-contract** | Types-only description of the HTTP API (`ChatRequest`, `ModelsResponse`, `AgentEvent`) shared by the server and every client. | kernel |
| **ui-contract** | Types-only, **frontend-agnostic** vocabulary for backend-declared **surfaces** (`SurfaceSpec`, field kinds, the surface WS protocol) — shared by the backend and any client (web, CLI). | — |
| **cli** | The bundled one-shot terminal client documented above. | transport-contract |
| **host-bin** | The composition root: loads config, activates all extensions through the host, serves HTTP, and supervises the observability collector. | kernel, all extensions, journal-sink |
| **journal-sink** | Bootstrap `LogSink` that appends structured logs/spans to an NDJSON journal (rotation, fail-safe). | kernel |
| **observability-collector** | Out-of-process binary that tails the journal and inserts records into the trace store (idempotent, at-least-once). | kernel, trace-store |
| **trace-store** | `bun:sqlite` store for trace records/bodies, plus a `trace` CLI to render a turn's timeline. | kernel |
| **trace-replay** | Generic HTTP-exchange record/replay library for hermetic, network-free provider tests. | — |

---

## Development

```sh
bun run typecheck   # tsc -b --pretty
bun run test        # vitest (pure/unit + integration)
bun run test:bun    # bun:sqlite-backed tests
bun run check       # biome (lint + format)
```

---

## Documentation

- **Design & rationale:** `notes/restructure-plan.md`
- **Agent constitution (build rules):** `AGENTS.md`
- **Orchestration workflow:** `ORCHESTRATOR.md`
- **Canonical vocabulary:** `GLOSSARY.md`
- **Live status / task log:** `tasks.md`
