# CLI — Design Scratch

> **Status:** IDEATION / scratch. NOT decided, NOT building yet. This is the HOME for the
> CLI design pass (per user: **CLI first, then web frontend**). Promote settled parts into
> `notes/restructure-plan.md` + harness files when we commit to building.
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

## 2. Open questions (DECIDE in the design pass)
- **Pure-core / shell split:** what's pure (message formatting, state reducer, event
  parser) vs. what's the shell (readline, fetch/stream, stdout, ANSI/colour).
- **Unit boundaries / first units:** transport client, message-loop engine, output
  renderer, conversation store (persisted across sessions?). Granularity = USER's call.
- **Conversation management:** list recent, pick one, start new — basic selectors (arrow
  keys + enter, or numbered list). In-memory vs. a small local store.
- **Output rendering:** streaming is incremental (ProviderEvent deltas → printed as they
  arrive); tool calls / thinking — how to render (collapsible? plain text? ANSI
  indentation?).
- **Transport:** reuse the same `/chat` NDJSON fetch+ReadableStream path the web FE
  would use. `trace-replay` could even feed CLI transport tests hermetically.
- **Persistence:** remember the active `conversationId` across sessions? history? simple
  JSON file or the conversation-store extension via HTTP.
- **Testing tools:** vitest for pure logic (already in repo); shell integration tests
  via PTY / spawned process? Or keep it thin-integration only (asymmetric).
- **Monorepo placement:** `packages/cli/` — run as `bun packages/cli/src/main.ts`.
- **Harness artifacts:** `.dispatch/rules/cli-*.md`, GLOSSARY terms (no synonym-drift),
  ORCHESTRATOR additions for CLI summons.

## 3. Decisions settled
- (none yet — IDEATION.)
