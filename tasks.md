# tasks.md — live progress / milestone log

> Owned by the orchestrator. Status is NOT in ORCHESTRATOR.md — it lives here.

## feature/close-tab-cascade-subagents — explicit Close survives turn finalization

- COMPLETE in this isolated feature worktree, based on backend `dev` at `4bf4dd9`.
- `session-orchestrator` retains bounded per-turn lifecycle identity through async
  settlement. Close cancels pending active/queued/idle publication and skips idle
  persistence + auto-compaction; Stop still settles idle and a later explicit turn reopens.
- Five regression cases use the real conversation store over in-memory storage:
  active Close / Stop, close during deferred setup, close on terminal event, and
  close in settled hook. The two primary Close cases failed before the fix.
- Verification: `bun run typecheck` clean; `bun run test` **4,214 passed / 10 skipped**;
  `bun run check` clean; `bun run test:bun` **188 passed** on final combined run
  (two earlier combined runs crashed inside Bun 1.3.14; all seven groups also pass
  independently). Session-orchestrator suite: **320 passed**.
- LIVE: private source instance `24303`/`24305`, fresh SQLite/trace/journal/image/plugin
  paths under `/tmp/close-tab-isolated`. Direct HTTP close returns `abortedTurn: true`,
  stream seals aborted, and conversation stays absent from active/idle list. Real FE
  browser cascade aborts active child, closes parent + all descendants, survives reload;
  parent-only/cancel/Escape/backdrop/remote close + desktop/mobile checks pass.
- Standard FE live integration probe **22/22** against this private instance.
- Public contracts unchanged. Companion frontend consumes unchanged `file:` deps.
- Main checkouts and user's running backend untouched; no merge back or push.
  See `notes/close-tab-cascade-subagents.md` and `reports/close-tab-cascade-subagents.md`.

## feature/named-agents — Named Agents (backend)

Implemented the backend scope of `notes/named-agents-plan.md`.

### The feature
A user-curated registry of **Named Agents** (friendly name → one
provider/model). `list_agent_models` now returns ONLY local Named Agents (zero
provider-catalog calls); `summon_agent` selects by `agent` (a Named Agent) or
the backward-compatible raw `model`, snapshoting a Named Agent selection onto
the conversation (snapshot semantics — later edits/deletes never mutate an
existing conversation). `/named-agents` CRUD over SQLite-backed storage; the
raw `GET /models` catalog is preserved for configuration + internal consumers.

### Units built
- **`packages/named-agents`** (NEW extension) — registry: persistence
  (`host.storage("named-agents")`), pure validation/normalization, typed
  `NamedAgentsService` + `namedAgentServiceHandle`, manifest/extension. No
  provider-catalog dependency by design.
- **`packages/conversation-store`** — persisted per-conversation
  `NamedAgentSelectionSnapshot` (`get/setNamedAgentSelection`), cleared on
  `deleteConversation`, copied on `forkHistory`, and cleared together with the
  model on a model-clear.
- **`packages/agent-management`** — `list_agent_models` = local Named Agents
  only (dropped raw-catalog + vision-filter path; new `NamedAgentEntry` +
  `filterNamedAgentEntries`); `summon_agent` gets `agent` selector + snapshot +
  `unknown-agent` error; raw `model` path preserved. New error code
  `unknown-agent`.
- **`packages/transport-http`** — `/named-agents` GET/POST/PUT/DELETE CRUD
  (service-mapped to 4xx/5xx); snapshot surfaced on `GET/PUT
  /conversations/:id/model` + `POST /chat`; new pure validators
  (`isValidNamedAgentSelectionSnapshot`, `mapCreateError`/`mapUpdateError`).
- **`packages/host-bin`** — named-agents wired into CORE_EXTENSIONS (+ package/
  tsconfig deps).
- **Contracts** — `NamedAgent` + `NamedAgentSelectionSnapshot` in `@dispatch/wire`;
  HTTP named-agent types + `namedAgent` on ModelResponse/ChatRequest/SetModelRequest
  in `@dispatch/transport-contract`. GLOSSARY + README updated.

### Milestones (this branch's history)
- `fe0ec72` plan: named agents feature (base).
- NEW single feature commit (see `git log` after commit): the full backend
  implementation above.

### Verification (final)
- `bun run typecheck` → clean (exit 0)
- `bun run test` → 2452 passed / 6 skipped
- `bun run test:bun` → 124 passed
- `bun run check` → biome clean (0/0/0)
- Live probe (private instance, isolated db/port): create/list/update/delete +
  duplicate→409 + unknown→404 (PUT/DELETE) + model-with-snapshot GET/PUT
  round-trip + model-clear-clears-snapshot. No leaked server/collector procs.

### Frontend handoff
`notes/named-agents-frontend-handoff.md` — the finalized backend contract the
companion FE worktree builds against (HTTP surface, model-selector synthetic
provider + snapshot send rules, what to NOT rely on).

### Remaining / notes
- Not merged/pushed (per instructions). Companion FE implemented separately.
- No tasks.md existed when this branch was checked out; created fresh here.
## feature/claude-thinking-display — thinking signatures

- [x] Read architecture rules and attached plan; installed backend + Claude dependencies.
- [x] Add provider-opaque wire payloads and reasoning-end contract.
- [x] Runtime boundaries/abort safety, persistence round-trip, and audit history paths.
- [x] Verify backend and build wire/kernel dist; commit including plan note.

Backend verification: typecheck clean; 3145 Vitest tests passed / 6 skipped;
144 Bun tests passed; Biome clean. Wire/kernel dist built for Claude.
HTTP history strips opaque fields without mutating stored/provider-facing history.
Compaction and other prefix rewrites retain bytes but require provider validity fallback.
- [x] Claude SSE capture, ordered replay, prefix-mismatch fallback, documentation.
- [x] Verify Claude and commit (`3db10a5`). No merge/push/server restart or symlinked checkout edits.

Claude verification against rebuilt backend dist: typecheck clean; 165 tests
passed (114 provider tests); Biome clean. Independent integration reviews found
no blocking signature-feature bugs. Decisions and request-local recovery's
non-durable exclusion limitation are recorded in provider `THINKING.md`.
No live API probe was performed; no real credentials were read for validation.

## feature/unrestricted-agent-messaging — unrestricted messaging

- [x] Read rules and canonical vocabulary; installed dependencies with `bun install`
  in the isolated feature worktree (no lockfile changes).
- [x] Extend existing `agent-management` messaging target resolution to all existing
  conversations; preserve unrelated list/read/open policies and delivery semantics.
- [x] Regression coverage for parent/full/short IDs, siblings, unrelated and
  cross-workspace targets, queue/cancel, ambiguity, and validation.
- [x] Update messaging descriptions and project documentation.
- [x] Independently run typecheck, Vitest, Bun integration tests, and Biome.
- [x] Commit only this feature branch; no merge or push (single feature commit).

Ownership wave: `agent-management` package owner implements code/tests; independent
read-only deployment assessor examines bundled loading/reload semantics. Orchestrator
owns root documentation and verification. No unrelated live messages, replay, server restart,
force reload, privileged operations, or main-checkout/frontend edits permitted.
Deployment assessment complete: **skip hotfix; user rebuild/deploy needed**. Ordinary
reload imports a directory plugin rather than the updated worktree automatically;
unload-then-load has no rollback/atomic handoff, and active turns retain captured
tools/descriptions. No live replacement was performed. See the local assessment
report for source references and read-only plugin/process probes.

Task-agent setup only: cleared the invalid inherited SSH alias `remote` on the
two newly created task conversations so their tools execute locally on the backend
host. This is not a deployment change; no unrelated conversation was modified.

Verification (orchestrator rerun): `bun run typecheck` exit 0; `bun run test`
3509 passed / 7 skipped across 186 passed files / 1 skipped; `bun run test:bun`
145 passed / 0 failed; `bun run check` checked 657 files, no warnings/infos.
Package coverage increased from 76 to 103 tests (+27), using real in-memory
conversation-store/session-orchestrator/message-queue with an outer provider edge.
A second `bun install` refreshed `bun.lock` for the new test-only message-queue
dependency/reference. Standalone backend compiled successfully into ignored
worktree `dist/dispatch-server` (not installed or run). Plugin lifecycle verification
tests passed in the full suite. No leaked test server/collector processes observed.
Live read-only follow-up: health OK, same PID 2351539 and original start time.
Independent read-only code/docs review found no blockers. Related guidance follow-up
completed: send-result `read_agent` recommendations explicitly defer to the independent
read policy, with three additional regression cases. Root list-scope/feature
descriptions aligned; pre-existing Named Agent skill wording not changed by this
narrowly scoped messaging patch. All checks and backend compilation rerun green
after the follow-up.

## feature/inco-provider — Inco model backend

- [x] Read repository guidance, install dependencies in isolated worktree.
- [x] Verify official https://platform.inco.ai/docs and public/authenticated catalog at https://api.inco.ai/v1/models (HTTP 200); user references `glm-5.3-flash:fast`.
- [x] Add providers-tier `provider-inco`, credential identity `inco`, live catalog, safe reasoning mapping and boundary tests.
- [x] Bundle provider and add secure user-run `/etc/dispatch/env` setup helper (no shared restart).
- [x] Independently verify full checks, live streaming and tool round trip; clean temporary credential.
- [x] Commit feature branch only; no merge/push (commit recorded in git history).

Ownership wave 1: provider-inco package owner and disjoint bin/set-inco-key setup owner.
Orchestrator owns docs/root build wiring; host-bin owner runs after provider public surface settles.
No main checkout edits, service restarts, sudo execution, or secret logging permitted.

Final verification: `bun install` completed before building/testing and after workspace
wiring; `bun run typecheck` exit 0; `bun run test` 4209 passed / 10 skipped;
`bun run test:bun` 188 passed; `bun run check` clean (744 files); `git diff --check`
clean. Secure setup helper: bash syntax clean and 14 fixture assertions passed,
without sudo or real credential access. Provider tests include verifyPlugin lifecycle.
Live public/authenticated catalog HTTP 200 (11 models), direct official SSE HTTP
200, and actual new provider + kernel runTurn streaming/tool-call/result round trip
passed using `glm-5.3-flash:fast`; usage/reasoning observed. No real vision upload
or frontend dropdown interaction tested; backend catalog standard/fast identities
and image metadata verified. No shared service restarted or runtime env modified.
Temporary credential removed only after required live probes; private mode0600
user-local staging retained for operator setup. Activation: run bin/set-inco-key
with its private file + --consume-key-file, deploy updated build, obtain approval
before restart, enable provider-inco in target workspace. User asked to stop
subagents; final verification and completion performed directly, no new agents.

Standalone backend compile (`bun build packages/host-bin/src/main.ts --compile --outfile dist/dispatch-server`) passed; binary remains worktree-local, not installed or run.
