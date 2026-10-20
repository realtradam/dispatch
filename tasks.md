# tasks.md — live progress / milestone log

> Owned by the orchestrator. Status is NOT in ORCHESTRATOR.md — it lives here.

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
