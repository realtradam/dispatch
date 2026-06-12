# HANDOFF — next steps for the incoming orchestrator

> Read `ORCHESTRATOR.md` first (your operating manual), then `tasks.md` (live
> status), then this file (what to do next). The MVP is DONE and verified live;
> this is the post-MVP backlog, ordered.

## Where things stand (one paragraph)
Kernel (contracts, bus, runtime/`runTurn`, host) + 6 core extensions
(storage-sqlite, conversation-store, auth-apikey, provider-openai-compat,
session-orchestrator, transport-http) + host-bin are built, full-fidelity
(every core feature is a real manifest-loaded extension). **178 tests pass;
typecheck + biome clean.** Multi-turn `curl` against OpenCode Go flash works
(use the `conversationId` field). Keys are rotated to **opencode-1** (active);
ports are **24203 backend / 24204 frontend** (in `.env`).

## How to boot & smoke-test
```bash
cd /home/tradam/projects/dispatch/arch-rewrite
set -a; source .env; set +a            # loads DISPATCH_API_KEY + BACKEND_PORT
bun packages/host-bin/src/main.ts       # boots on BACKEND_PORT (24203)
# another shell:
curl -s -X POST localhost:24203/chat -H 'content-type: application/json' \
  -d '{"conversationId":"c1","message":"Say hello in 3 words."}'
# multi-turn: send a 2nd POST with the SAME conversationId; it sees turn 1.
```
A 429 `GoUsageLimitError` = upstream monthly cap, not a bug. opencode-1 is active;
opencode-2 (in `.env` as `DISPATCH_API_KEY_OPENCODE2`) is rate-limited until reset.

---

## Next steps (ordered; each is one summon unless noted)

### 1. Wire auth → provider properly  ⟵ DO FIRST (correctness, small)
**Problem:** `auth-apikey` is currently **vestigial**. `provider-openai-compat`
reads its credentials straight from `host.config` (`provider.openai-compat.*`)
and never calls `AuthContract.resolve()`. So the auth extension exists but does
nothing — the architecture isn't actually exercising the auth seam.
**Goal:** the provider obtains credentials via the `AuthContract` (resolved by
the orchestrator/host-bin and handed to the provider), not by reading config
directly.
**Likely a 2-unit change (contract-touching → coordinate):**
- `provider-openai-compat`: accept resolved `Credentials` (apiKey/baseURL) at
  registration/stream instead of reading `host.config`.
- `host-bin` (composition root): resolve `auth-apikey`'s `AuthContract` →
  feed the provider. (Orchestrator may do this small wiring edit directly.)
- Watch the **`ProviderContract.stream` credentials gap** noted since the
  contracts were written — decide whether creds flow via `ProviderStreamOptions`,
  a provider factory arg, or a resolve-at-activate step. If `provider.ts`
  contract must change, run `lsp references` and fan out (§5.3).
**Verify:** boot + curl still returns a real response; auth-apikey now on the
path. Add/adjust tests so the seam is covered without internal mocks.

### 2. First TOOL extension — exercise the dispatch loop  ⟵ proves §3.3
**Problem:** every turn so far runs with `tools: []`. The kernel's tool-dispatch
loop (eager / semaphore / dedup / concurrencySafe / abort) has unit tests but has
NEVER run end-to-end with a real tool + a real model.
**Goal:** add a `read_file` tool extension (standard tier), register it via the
host, and have a live turn where flash actually calls it.
- New unit `packages/tool-read-file/` (or `tools-fs/`): a `ToolContract`
  (`name`, `description`, JSON-schema `parameters`, `execute` using `node:fs`,
  workdir-contained — see the OLD repo's `read-file.ts` for the containment
  guard, `/home/tradam/projects/dispatch/dispatch-source/packages/core/src/tools/read-file.ts`,
  as a REFERENCE only — do not copy blindly).
- Manifest with `capabilities: { fs: true }`.
- host-bin registers it; session-orchestrator passes the tool set to `runTurn`.
- **Live test:** ask the model to read a file → confirm a `tool-call` +
  `tool-result` round-trip + final answer using the content.
**This is the highest-value next step** — it's the first real validation that the
turn loop's tool path works against a live model.

### 3. Small CRs / hygiene (batch; mostly orchestrator wiring)
- **host CR-1:** `createHost` should expose `getHostAPI()` so host-bin drops its
  duplicate `HostAPI` adapter (`buildPostActivationHostAPI`). Kernel-host unit.
- **storage-sqlite CR-2:** manifest declares `contributes.services:["storage"]`
  but `activate` is a no-op (backend is a kernel dep passed via host-bin). Either
  remove the misleading `contributes`, or make it provide the factory as a
  service. Reconcile manifest vs reality.
- **Stale detached server** may linger on an old port from earlier runs — harmless;
  kill if it blocks a port.

### 4. Vocabulary drift fix: `tabId` → `conversationId`  ⟵ contract change
**Problem (tracked in GLOSSARY.md "Known vocabulary drift"):** the canonical term
is **`conversationId`**, but `AgentEvent`s and `RunTurnInput` still use **`tabId`**
(the orchestrator bridges `conversationId → tabId`). This is pure P8 debt.
**Goal:** rename `tabId` → `conversationId` across `events.ts` + `runtime.ts`
contracts and every consumer.
**Process (textbook §5.3 fan-out):** kernel-contracts owner renames the symbols,
runs `lsp references` to get the TRUE consumer list, orchestrator dispatches the
affected owners (runtime, session-orchestrator, transport-http, host-bin) to
update. Do this as ONE coordinated change; expect ~4–5 files. Update GLOSSARY
(remove the drift note) when done.

---

## Standing reminders (from ORCHESTRATOR.md — don't relearn the hard way)
- Summon via the **Task tool** (`subagent_type: "Opus 4.8"`, ORCHESTRATOR §2). The Task
  `prompt` is a SHORT pointer that tells the agent to READ the briefs + scoped rules +
  `prompts/<unit>.md` ITSELF — **never `Read`/`cat` those files into your own context to
  inline them** (that burns your tokens; the whole point of the file harness is to keep the
  guardrails in the *subagent's* context, not yours). Parallel wave = multiple Task calls in
  ONE message (disjoint file sets only).
- **`deepseek-v4-flash` is the app's runtime testbench, NOT for building agents.**
- Parallelize ONLY disjoint file sets (single-writer). Log parallel runs in tasks.md.
- Verify independently (typecheck/test/check) + confirm single-lane edits. Trust
  nothing until green yourself.
- Keep `tasks.md` current; write decisions down before pivoting.
- Be careful with destructive git; back up `notes/` before any reset/clean.

## Open design decisions still parked (post-rewrite, from plan §8)
- Persistent *waking* agents + wake-time contract-delta sync (we use fresh
  summons for now).
- These are NOT blocking the next steps above.
