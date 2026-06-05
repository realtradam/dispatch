# Frontend MVP — Design Scratch

> **Status:** IDEATION / scratch. NOT decided, NOT building yet. This is the HOME for the
> "carefully plan the frontend" pass the user asked for (per ORCHESTRATOR "write up before
> pivoting"). Promote settled parts into `notes/restructure-plan.md` + `GLOSSARY.md` +
> harness files when we commit to building.
>
> **Read order (fresh agent picking this up):** `ORCHESTRATOR.md` → `AGENTS.md` (the
> backend methodology we are MIRRORING) → `GLOSSARY.md` → this file.
> **Mode = IDEATION WITH the user** (design/discuss, do NOT build yet). The user owns the
> boundary (§5.2) + vocabulary (§5.6) calls.
> **Driver:** a minimal chat frontend, **Svelte + DaisyUI** (same stack family as old
> Dispatch), built with the SAME methodology as the backend — NOT a default-SvelteKit ball
> of mud. Old FE at `/home/tradam/projects/dispatch/dispatch-source` is REFERENCE-ONLY.
> Ports reserved: `FRONTEND_PORT=24204` (.env).

---

## 0. Goal in one paragraph
A minimal browser chat client — the FE analogue of the curl MVP: send a message and render
the streamed, multi-turn response (`conversationId` threads history). Svelte + DaisyUI for
the view; but the architecture must be a **minimal core + feature modules** with the same
discipline that makes the backend testable and agent-buildable.

## 1. The hard constraint — methodology parity with the backend (why this needs care)
Translate each backend principle to the frontend (these are the constraints, not yet the
"how"):
- **Minimal core + feature modules / tiers.** A FE "kernel" that owns app shell + routing +
  state-core + a module host, and **names no concrete feature**; every feature (chat view,
  conversation list, composer, message-stream renderer, settings…) is a module/"extension".
- **Contracts are the only cross-unit surface.** Cross-module coupling anchored to **typed
  symbols** (no string-keyed lookups → must be a compile error so `lsp references` finds
  every consumer). The **FE↔BE seam** is the backend's HTTP/event contract (the
  `AgentEvent` union + `/chat` NDJSON + `conversationId`) — ideally a **shared typed
  contract** so `lsp references` spans the boundary.
- **Pure-core / inject-effects + no ambient state.** Pure view-models / stores / reducers /
  formatters: zero DOM, zero I/O, exhaustively unit-testable. Svelte components + transport
  (`fetch`/streaming) + browser effects (localStorage, history, clipboard) are the
  **injected imperative shell**.
- **One owner per unit**; orchestrator summons owner-agents; units communicate via
  contracts; the orchestrator never edits implementation.
- **Asymmetric testing** — strict zero-internal-mock + high coverage on pure logic; lenient
  integration on components/shell. Mocking our own module = a design bug.
- **Durability where it matters** (e.g. optimistic UI + reconcile on reconnect) — pure
  `reconcile(state, events)`.

## 2. Open questions (DECIDE in the design pass — all UNDECIDED)
- **FE "kernel" shape:** what exactly is core vs. feature? Module-host mechanism (manifest
  analogue?) vs. simpler composition. How far to take the kernel/extension metaphor before
  it's cargo-culting the backend (P6 — don't copy structure that earns nothing).
- **Unit boundaries / first units** for the MVP (composer, transport client, message-stream
  store + renderer, conversation state). Granularity = USER's call.
- **The FE↔BE contract package:** reuse kernel `AgentEvent`/types directly? a new shared
  `@dispatch/protocol` package both sides depend on? how do FE pure-cores import it.
- **Transport in the browser:** consume the `/chat` NDJSON stream (fetch + ReadableStream
  reader) — framing, backpressure, abort, reconnect, `conversationId` threading. (Note:
  `trace-replay`'s fixture model could even feed FE transport tests hermetically.)
- **State approach:** Svelte stores vs runes; keep ALL logic framework-thin & pure so it's
  testable without mounting components.
- **Testing tools:** vitest for pure logic (already in repo); component/integration via
  `@testing-library/svelte`; e2e via Playwright? — decide + how it joins `bun run test`.
- **Build/tooling + monorepo placement:** `packages/frontend` vs `apps/web`; Vite + Svelte;
  Tailwind + DaisyUI; how it fits `tsc -b` project refs, biome, the bun workspace.
- **Harness artifacts to author:** new scoped `.dispatch/rules/frontend-*.md` (the FE
  pure-core/shell + inject-effects + no-ambient-state rules), GLOSSARY terms (no
  synonym-drift with backend vocab), ORCHESTRATOR additions for FE summons, and the
  AGENTS.md scope update (**the current "Backend only for now (no frontend)" line retires
  when FE build starts** — leave it until then).
- **MVP scope cut:** what's in v1 (send + stream + multi-turn render) vs. deferred (history
  list, tool-call/▷thinking rendering, settings, theming).

## 3. Decisions settled
- (none yet — IDEATION.)

## 4. References (do NOT copy blindly — keep our methodology)
- Old Dispatch FE: `/home/tradam/projects/dispatch/dispatch-source` (Svelte + DaisyUI) —
  reference-only for UX + tech, NOT structure.
- Backend seam: `packages/kernel/src/contracts/events.ts` (`AgentEvent`),
  `packages/transport-http` (`/chat` NDJSON), `GLOSSARY.md`.
