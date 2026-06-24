# HANDOFF — next steps for the incoming orchestrator

> Read `ORCHESTRATOR.md` first (your operating manual), then `tasks.md` (live
> status), then this file (what to do next). The project is mature; this file
> points at the live source of truth and the current open work.

## Where things stand (one paragraph)

Kernel + core extensions + host-bin are built, full-fidelity (every core feature
is a real manifest-loaded extension). The turn loop runs real tools end-to-end
against live models. LSP integration, observability (journal/collector/trace-store),
cache warming, turn continuity (detached turns + multi-client), skills, message
queue + steering, metrics (live + persisted), per-conversation model/cwd/reasoning
persistence, and broken-chat self-repair are all DONE and live-verified.
**`tsc -b` EXIT 0 · biome clean · 1468 vitest green.** The web frontend is a
separate repo (`../dispatch-web`); contract changes are couriered via the user.

## How to boot & smoke-test
```bash
cd /home/tradam/projects/dispatch/dispatch-backend
# .env auto-loads DISPATCH_API_KEY + BACKEND_PORT (24203).
# Dev stack (live-reload): bin/up  (ports 24203/24205/24204)
# Stable second stack:    ../bin/up2  (ports 25203/25205/25204, isolated data)
bun packages/host-bin/src/main.ts   # boots app + collector
curl -s -X POST localhost:24203/chat -H 'content-type: application/json' \
  -d '{"conversationId":"c1","message":"Say hello in 3 words."}'
```
Process cleanup uses the `[x]` bracket trick (ORCHESTRATOR §8) — leaked
server/collector procs poison the next run's counts.

## What's open now

See `tasks.md` for the live checklist. As of this writing:
- **Per-edit LSP diagnostics** (commit `8f6114b`) — committed + green, NOT yet
  live-verified against a real running server.
- **MCP (Model Context Protocol) integration** — the next major feature. Research
  + plan in progress; see `notes/mcp-design.md` (when written) + `PLAN-mcp.md`.
- `notes/pending-issues.md` item 1 (workspace tab) — awaiting a user handoff.

## Standing reminders (from ORCHESTRATOR.md — don't relearn the hard way)
- Summon via `opencode run` (ORCHESTRATOR §2). Parallel wave = multiple concurrent
  summons on disjoint file sets only.
- Verify independently (typecheck/test/check) + confirm single-lane edits.
- Keep `tasks.md` current; write decisions down before pivoting.
- Be careful with destructive git; back up `notes/` before any reset/clean.
