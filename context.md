# Dispatch — Phase 1 Implementation Context

This file captures all decisions, open questions, and constraints established during planning. It serves as the source of truth for any agent working on Phase 1 implementation.

---

## Stack Decisions

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Bun** | Runtime + package manager. Native SQLite, fast installs/execution |
| Backend framework | **Hono.js** | Lightweight, WebSocket support |
| Frontend framework | **Vite + Svelte + DaisyUI** | Strict TypeScript throughout |
| Language | **TypeScript (strict mode)** | Both frontend and backend |
| LLM SDK | **Vercel AI SDK (`ai`)** | Provider-agnostic, streaming, tool calling |
| Default LLM | **DeepSeek V4 Flash Free** | Via OpenCode Go (Zen). Hardcoded for Phase 1 |
| Database | **SQLite (no ORM)** | `bun:sqlite` (native), no Drizzle or other ORM |
| Testing | **Vitest** | Set up across all packages from day one |
| Linting/Formatting | **Biome** | Single tool for both linting and formatting. Confirmed compatible with OpenCode |
| Package Manager | **Bun workspaces** | Monorepo with `@dispatch/*` packages |
| Dev Server | **Separate ports + CORS** | Frontend `:5173`, backend `:3000`, explicit CORS |

---

## Resolved Decisions

### Streaming Architecture: WebSocket Only
All real-time communication flows over a single WebSocket connection:
- Chat messages (user -> server)
- Streaming LLM tokens (server -> client)
- Tool call notifications and results (server -> client)
- Agent status updates (server -> client)

`POST /chat` is not a streaming endpoint — it just queues/sends a message. The WebSocket handles all real-time data. `GET /status` remains as a simple REST endpoint for polling agent state.

### Database: SQLite Without ORM
No Drizzle ORM. Use `better-sqlite3` (or equivalent) directly with raw SQL. Keep it simple. The question of whether to set up persistence in Phase 1 or defer to Phase 5 is still open — the user indicated willingness to use SQLite but the timing wasn't finalized. **Default assumption: defer heavy persistence to Phase 5, but the library choice is locked in.**

### Tool Scoping: Working Directory
File tools (`read_file`, `write_file`, `list_files`) will be scoped to a configurable working directory from Phase 1. This prevents accidental filesystem damage and provides a clean foundation for the permission system in Phase 2.

### Testing: Vitest From Day One
Vitest set up across the monorepo. Unit tests for core logic (agent loop, tool registry, individual tools).

### DaisyUI Theme: Configurable With Persistence
Support multiple DaisyUI themes with a user-selectable theme switcher in settings. The selected theme is remembered across sessions (localStorage or equivalent).

### Default LLM Provider: DeepSeek V4 Flash via OpenRouter
The Phase 1 hardcoded model is DeepSeek V4 Flash, accessed through OpenRouter. This means:
- The Vercel AI SDK OpenRouter provider will be used
- A single `OPENROUTER_API_KEY` env var (or equivalent) is needed
- Model ID will be the OpenRouter model string for DeepSeek V4 Flash

---

## Resolved Decisions (Previously Open Questions)

### 1. Package Manager and Monorepo Tooling: Bun Workspaces
**Decision:** Bun as both runtime and package manager, using Bun workspaces.

Bun workspaces work similarly to pnpm workspaces — `packages/core`, `packages/api`, and `packages/frontend` reference each other as `@dispatch/*` dependencies, and Bun symlinks them locally.

### 2. Runtime: Bun
**Decision:** Bun is the runtime.

Implications:
- Native SQLite via `bun:sqlite` — no need for `better-sqlite3`
- Bun is faster for installs, script execution, and testing
- Vitest is the test runner (works with Bun)
- No Node.js version to manage

### 3. Dev Server Setup: Separate Ports + CORS
**Decision:** Frontend on `:5173` (Vite dev server), backend on `:3000` (Hono). Explicit CORS configuration on the backend.

This means:
- Hono backend needs CORS middleware allowing the frontend origin
- WebSocket connections go directly to `:3000` from the frontend
- No Vite proxy configuration needed
- Production will also be cross-origin (matches the split deployment model)

### 4. Biome Compatibility: Confirmed
**Decision:** Biome is fully compatible with OpenCode.

OpenCode has Biome as a **built-in formatter**. It auto-detects `biome.json(c)` config files and handles `.js`, `.jsx`, `.ts`, `.tsx`, `.html`, `.css`, `.md`, `.json`, `.yaml`, and more. Just needs a `biome.json` in the project root and formatters enabled in OpenCode config (`"formatter": true` or `"formatter": {}`).

---

## Phase 1 Scope (from plan.md)

**Goal:** Chat with one agent in a browser, watch it read and write files.

### Backend Tasks
- Project scaffolding (monorepo with `packages/core`, `packages/api`, `packages/frontend`)
- Agent runtime: message -> LLM -> tool call -> result -> repeat loop
- Vercel AI SDK integration with streaming responses
- Single provider config (DeepSeek V4 Flash via OpenRouter, env var for API key)
- Basic tools:
  - `read_file` — read file contents (scoped to working directory)
  - `write_file` — write/overwrite a file (scoped to working directory)
  - `list_files` — glob/list directory contents (scoped to working directory)
- HTTP API:
  - `POST /chat` — send a message (non-streaming, queues to agent)
  - `GET /status` — agent status (idle, running, etc.)
- WebSocket: stream agent output tokens and tool calls in real-time

### Frontend Tasks
- Single chat panel — text input field, send button
- Streamed response rendering (tokens appear as they arrive via WebSocket)
- Tool call display (collapsible: show tool name, arguments, result)
- Model/provider indicator in header
- Basic layout: chat takes full screen, clean and minimal
- Theme switcher in settings (DaisyUI themes, persisted to localStorage)

### Done When
Open a browser, type "read the contents of package.json and summarize it," see the agent call `read_file`, stream back a summary. Ask it to create a new file — it calls `write_file` and confirms.

---

## Project Structure (Planned)

```
dispatch/
  packages/
    core/              # Agent runtime, LLM integration, tools
      src/
        agent/         # Agent loop, lifecycle
        llm/           # Vercel AI SDK wrapper, provider config
        tools/         # Tool registry, built-in tools (read_file, write_file, list_files)
        types/         # Shared TypeScript types
      tests/
    api/               # Hono HTTP + WebSocket server
      src/
        routes/        # HTTP route handlers
        ws/            # WebSocket handlers
      tests/
    frontend/          # Vite + Svelte + DaisyUI client
      src/
        lib/           # Svelte components, stores, utilities
        routes/        # Page routes (if using SvelteKit) or views
      tests/
  biome.json           # Biome config (pending compatibility check)
  tsconfig.base.json   # Shared TypeScript config
  package.json         # Root workspace config
  .env.example         # Environment variables template (OPENROUTER_API_KEY, etc.)
```

---

## Concurrency Map (What Can Be Built in Parallel)

Once scaffolding is complete, the following sections can be developed concurrently:

```
[A] Scaffolding (sequential — must be first)
        |
        +---> [B] Core Agent Runtime (agent loop, LLM, tool system)
        |
        +---> [C] API Server Shell (Hono setup, route stubs, WebSocket setup)
        |
        +---> [D] Frontend Shell (Svelte app, chat UI, WebSocket client, theme system)

Then integration (sequential — depends on B, C, D):

[E] Wire core into API (connect agent runtime to routes/WebSocket)
[F] Wire frontend to API (connect UI to live WebSocket)
[G] End-to-end testing and polish
```

Sections B, C, and D are independent and can be coded by concurrent agents. Section E requires B and C. Section F requires C and D. Section G requires everything.
