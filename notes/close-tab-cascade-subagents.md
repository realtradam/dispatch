# Close-tab cascade: backend Close/finalization race

## Scope and result

Frontend closes each tab in the snapshotted **visible tab-group** subtree through
`POST /conversations/:id/close`. Backend does not cascade; no new route or contract
is introduced. This backend companion fixes a pre-existing single-conversation race:
turn finalization used to write/publish `idle` after explicit Close wrote `closed`.
That reopened an active child after the frontend cascade had correctly closed it.

The fix is confined to `packages/session-orchestrator`:

- Keep the current turn's lifecycle identity until asynchronous settlement finishes,
  independently of the single-flight slot. Close marks that turn before abort callbacks.
- Suppress cancelled/stale active/queued/idle broadcasts, including after workspace lookup.
- Still emit turn settlement and retain durable messages/metrics, but skip idle persistence
  and auto-compaction for Close. Do not overwrite a newly started turn's state.
- Stop is not Close: it still settles idle. A later explicit turn reopens normally.
- Remove lifecycle tracking on settlement, checking identity so older turns cannot delete
  newer entries. No permanent tombstone or unbounded closed-id registry.

## Regression coverage

`orchestrator.test.ts` uses real `createConversationStore` + in-memory storage and
real `runTurn`, with a blocked provider as the outermost edge. Cases cover active
Close/Stop, deferred setup, terminal-event Close, settled-hook Close, final persisted
status/broadcasts, retained messages, compaction suppression, and explicit reopening.
Before the fix, active Close and deferred-setup Close both ended `idle` instead of `closed`.

## Isolated live verification

Per `ORCHESTRATOR.md` §8, only a private writable instance was used for verifying
this fix. No user's server was restarted. Private source boot used:

```sh
BACKEND_PORT=24303 SURFACE_WS_PORT=24305 \
  DISPATCH_DB=/tmp/close-tab-isolated/dispatch.db \
  DISPATCH_TRACE_DB=/tmp/close-tab-isolated/traces.db \
  DISPATCH_JOURNAL=/tmp/close-tab-isolated/app.ndjson \
  DISPATCH_IMAGE_DIR=/tmp/close-tab-isolated/images \
  DISPATCH_PLUGINS_DIR=/tmp/close-tab-isolated/plugins \
  bun packages/host-bin/src/main.ts
```

Provider secrets were inherited from the existing environment, never printed or
replaced with empty overrides. Enable `provider-umans` in the disposable workspace
using `PUT /workspaces/:id/plugins/provider-umans` with `{"state":"enabled"}`.

Repro sequence (against a **disposable** workspace/conversation only):

1. `PUT /conversations/:id/cwd` with `{"cwd":"/tmp","workspaceId":"close-tab-probe"}`.
2. `POST /chat` with that `conversationId`, model
   `umans/umans-deepseek-v4.1-flash-1017`, and a long-output prompt; keep its NDJSON reader open.
3. Wait for `turn-start`, then `POST /conversations/:id/close` exactly ONCE.
4. Expect `abortedTurn: true`, `done.reason: "aborted"`, `turn-sealed` and
   `turn-ended.reason: "aborted"`. After stream completion + 500ms, the id must NOT
   appear in `GET /conversations?status=active,idle`. Before this fix it appeared `idle`.

The real Chromium frontend test repeats this while the child is nested in a tab group:
parent confirmation → Yes → all four tabs gone; unrelated tab remains; child aborts;
server list and browser reload do not resurrect it. Desktop (1280px) and mobile (420px)
modal checks, No/Cancel/Escape/backdrop/remote close, focus trap/restoration and leaf
close pass. Browser fixture conversations were closed and workspaces archived.

## Verification

- `bun run typecheck`: exit 0.
- `bun run test`: 4,214 passed; 10 skipped (216 passing files + 1 skipped).
- `bun run check`: 743 files, no fixes/errors/warnings/infos.
- `bun run test:bun`: final combined run 188 passed, 0 failed. Earlier combined runs
  hit Bun 1.3.14 native crashes; all seven groups passed independently as well.
- Session-orchestrator targeted suite: 320 passed.
- Frontend standard live probe against private instance: 22/22 checks passed.

No public contract/version changes or backend API asks remain. Feature branches only;
no merge back/push. Runtime and test artifacts are under gitignored `reports/` or `/tmp`.
