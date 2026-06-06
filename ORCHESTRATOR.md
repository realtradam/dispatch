# ORCHESTRATOR.md — how to drive this project

> **You are the orchestrator.** You do NOT write feature code yourself. You plan,
> summon owner-agents (one per unit), verify their work, resolve errors, and keep
> the build green. This file is your complete operating manual. Read it fully
> before acting. Also read: `AGENTS.md` (the subagent constitution — you enforce
> it), `GLOSSARY.md`, `.dispatch/rules/`, `tasks.md` (live progress), and
> `notes/restructure-plan.md` (the full design + rationale; §-refs below point
> into it).

---

## 0. Mental model (why this project is built this way)

This is a **minimal kernel + extensions** agent runtime. Every feature is an
extension. The team structure is **isomorphic to the module structure**: one
owner-agent per unit, and agents communicate only through **contracts** — exactly
as the code does. Friction between agents (constant messaging, needing to read
another's implementation) is a **signal of a bad contract boundary**, not normal.

This is a synthesis of "The AI Harness"
(https://dev.to/louaiboumediene/the-ai-harness-why-your-ai-coding-agent-is-only-as-smart-as-the-repo-you-put-it-in-cml)
with our own design. The harness layers we use:
- **Constitution** (`AGENTS.md`) — loaded by every agent. Non-obvious, project-
  specific rules only.
- **Safety reflexes** (`.dispatch/rules/*.md`) — tiny, crystallized scar tissue.
- **Glossary** (`GLOSSARY.md`) — one canonical name per concept.
- **This file** — the orchestrator's workflow (the article doesn't cover this; we
  added it).
- **Scoped knowledge** — rules/prompts are scoped to the *kind* of agent and the
  *layer* it works in (strict for kernel/pure-core, lenient for the shell). The
  article's key lesson: **scoped rules beat general rules; never write down what a
  frontier model already knows** (P6).

The 8 principles (P1–P8) live in `notes/restructure-plan.md` §1. Internalize them;
they justify every rule below.

---

## 1. The golden workflow (build/modify a feature)

1. **Plan.** Decide the unit(s). Respect the dependency-topological order. One
   agent owns one unit; it may ONLY edit its assigned files.
2. **Overlap check FIRST (anti-synonym-drift, §5.6).** Before creating anything
   new, check `GLOSSARY.md` + existing code. If the request *describes* an
   existing concept under a new name, steer to the canonical term (e.g.
   "web-notifier" → that's a `webhook`). New term? Propose the standard/training-
   baked name and **ask the user** before adding it to the glossary. Never coin a
   term silently.
3. **Boundary decision is the USER's (§5.2).** "New extension vs. extend an
   existing one?" — surface it to the user; never decide granularity silently.
4. **Write the prompt** to `prompts/<unit>.md` (gitignored). See §3 for the
   prompt recipe.
5. **Summon the agent** via `opencode run` (see §2). Parallelize disjoint units.
6. **Verify** the report + independently re-run checks (see §4). Trust nothing
   until you've re-run `typecheck`/`test`/`check` yourself.
7. **Resolve** any contract gaps / errors (see §5).
8. **Commit** the milestone with a clear message + test count. Update `tasks.md`.

---

## 2. Summoning agents via `opencode run` (the harness)

OpenCode CLI is the summon mechanism (see `notes/opencode-agents.md`).

**Working dir:** always the repo root,
`/home/tradam/projects/dispatch/arch-rewrite` (so the agents' `lsp` tool works —
TS language server is configured globally).

**Model:** use `opencode-go/mimo-v2.5-pro` for BUILDING agents (capable coder).
`deepseek-v4-flash` is reserved as the *app's own runtime testbench*, not for
building.

**Canonical invocation** — assemble the prompt by CONCATENATING the standardized briefs + the
scoped rules + the per-summon TASK. The invariant guardrails live ONCE in the briefs, so
`prompts/<unit>.md` is now JUST the TASK block (§3). Do NOT use `-f` (see gotcha); ALWAYS
redirect output to a file.
```bash
cd /home/tradam/projects/dispatch/arch-rewrite && \
opencode run --dir /home/tradam/projects/dispatch/arch-rewrite \
  -m opencode-go/mimo-v2.5-pro \
  "$(cat .dispatch/package-agent.md)
$(cat .dispatch/extension-agent.md)
$(cat .dispatch/rules/one-owner.md .dispatch/rules/isolation-over-dry.md .dispatch/rules/pure-core.md .dispatch/rules/no-internal-mocks.md .dispatch/rules/typed-handles.md)

## TASK
$(cat prompts/<unit>.md)" \
  > reports/<unit>.run.log 2>&1
```
**Assembly order is fixed: package brief → extension supplement → scoped rules → TASK**
(the supplement references "the package brief above"; the briefs reference "rules inlined into
this prompt"). Rules:
- **Non-extension package?** OMIT the `.dispatch/extension-agent.md` line.
- Inline ONLY the scoped rules matching the unit's layer (the §3 map) — not every rule on every agent.
- `AGENTS.md` is auto-loaded by opencode — never `cat` it.
- The briefs already instruct the agent on ownership, visibility, verify, and the report; the
  TASK block must NOT repeat any of that.

**MANDATORY — capture output to a file, never display it.** The agent's streamed
output is enormous and will overwhelm and CRASH this harness if it lands in your
terminal. ALWAYS redirect the summon's stdout+stderr to a log file (e.g.
`> reports/<unit>.run.log 2>&1`) and do NOT echo/`cat` that log back wholesale.
You don't need the raw stream: read the agent's `reports/<unit>.md` report (and,
if you must, `grep`/`tail` the log for a specific error). Treat dumping a full run
log into context as a hard failure.

**Run discipline (from the tool harness):**
- **Do NOT background it. Use a large timeout** (e.g. 1800000 ms = 30 min) — these
  are long tasks. Backgrounding loses the stream.
- One non-backgrounded `run_shell` per summon. For PARALLEL agents on disjoint
  files, launch multiple summons (the harness allows concurrent tool calls) — but
  ONLY when their file sets do not overlap (single-writer rule). Log parallel runs
  in `tasks.md`.

**GOTCHAS (learned the hard way):**
- `-f/--file` is an ARRAY flag and greedily eats your trailing message as another
  filename → "File not found". **Inline with `"$(cat prompts/X.md)"` instead.**
- A quick smoke test works: `opencode run -m opencode-go/mimo-v2.5-pro "Reply with
  exactly SMOKE_OK"` should print `SMOKE_OK`.
- `opencode models` lists models; `opencode agent list` lists agent profiles;
  `opencode run --help` for flags.

---

## 3. The per-summon `prompts/<unit>.md` is JUST the TASK block

The invariant guardrails — single-writer directory ownership, visibility, coupling, the
engineering standard, isolated verification, and the report format — live ONCE in the
standardized briefs the summon concatenates (§2):
- **`.dispatch/package-agent.md`** — the base for EVERY package owner.
- **`.dispatch/extension-agent.md`** — the extension-only supplement (added for extension summons).

So `prompts/<unit>.md` no longer restates any of that. It contains ONLY the **TASK**:
1. **Your package:** `packages/<name>/` — name the WHAT, not the files (the owner owns the whole
   directory and decides which files to touch).
2. **The job + algorithm**, naming the specific contract types/handles involved.
3. **The specific contract file(s)** to read (e.g. `packages/kernel/src/contracts/<x>.ts`) and
   any sibling public surfaces it consumes.
4. **The required test cases** (named).

Keep it scoped (P6): state only the project-specific, non-inferable task — the briefs carry the rest.

**`.dispatch/rules/` scoping map** — include ONLY the rows matching the unit (per §0
"scoped rules beat general rules"); do NOT dump every rule on every agent:
- **Every agent:** `one-owner.md`, `isolation-over-dry.md`.
- **Kernel unit:** `kernel-purity.md` + `pure-core.md` + `no-internal-mocks.md`.
- **Pure-core unit:** `pure-core.md` + `no-internal-mocks.md`.
- **Any extension coupling via hooks/services:** `typed-handles.md`.
- **Any extension that emits logs/spans (≈ all of them):** `extension-logging.md`
  *(pending — authored with the observability substrate, see
  `notes/observability-design.md` §9; keystone: each extension self-redacts its OWN
  secrets in its OWN code — NO shared redaction helper).*

---

## 4. Verification (the orchestrator's trust protocol)

**Plan principle (§3.6 / §5 last row):** the orchestrator confirms work from
**contracts + test results + build/diagnostics output** — that is the *designed*
trust mechanism, and it works precisely because the boundaries are testable. The
tests-at-boundaries ARE how you trust a unit without depending on its internals.

**Stay out of implementation files (§6 Visibility).** Your trust signals are the
agent's report, the contract/surface it exposes (contracts, manifests, public
types), and the build/test/lint output you re-run yourself — NOT its implementation
code. Do NOT open an extension's implementation files — not even to "skim",
double-check, or diagnose a bug. **There is NO "conflict exception."** When X and Y
don't work together, or a unit is broken, you diagnose from the `typecheck`/`test`
output + `lsp references` on the contract + the agent's report, then **summon the
owning agent** (or a temporary multi-knowledge agent, §5) to read its own code and
fix it. You diagnose from symptoms; the agent reads the code.

After every agent, independently:
```bash
cd /home/tradam/projects/dispatch/arch-rewrite
bun run typecheck   # tsc -b --pretty — must be clean (EXIT 0)
bun run test        # vitest — note the pass count
bun run check       # biome — must be clean
git status --short  # confirm the agent stayed in its lane (no out-of-scope edits)
```
- **Read ONLY the surfaces** (the contracts/hooks/public signatures the unit
  exposes), not its implementation files — unless an implementation conflict or
  trouble forces you in (§6). The surface plus green checks is enough to trust a
  unit; subtle contract mistakes show up at the boundary, which is what the
  contract + boundary tests are for.
- Confirm the agent touched ONLY its assigned files (one-owner rule).
- For pure units, confirm tests use NO internal `vi.mock("@dispatch/*")`.

---

## 5. Resolving errors & contract changes

- **A unit needs something from another unit's contract:** that's a CONTRACT
  CHANGE. The owner of the contract makes it. To find every consumer, use
  `lsp references` on the changed exported symbol (contracts are static TS types,
  so this returns the TRUE blast radius — §5.3). Then summon the affected owners
  to update. The orchestrator dispatches this fan-out; agents don't reach across.
- **Integration bug (X and Y each honor the contract but don't work together):**
  no single file owns it. Summon a **temporary multi-knowledge agent** with
  read/write to the 2–3 relevant files (it MAY see implementation — exception to
  the visibility rule), as their temporary exclusive owner. Dispatch proactively,
  or when a file-owner requests it (§5.5).
- **CR (change-request) in a report:** if it's **build/config** (root
  `tsconfig.json` ref, a `package.json` dep, `.gitignore`, `bun.lock`) the
  orchestrator edits it directly, then re-verifies. If it's **implementation** (a
  barrel `index.ts`, a sibling conforming to a contract change), the orchestrator
  **summons the owning agent** — it does NOT edit implementation itself.
- **Live API errors:** an HTTP 429 `GoUsageLimitError` is an UPSTREAM rate limit,
  not a bug. The `opencode-2` key has a monthly cap; `opencode-1` is the backup.
  Swap `DISPATCH_API_KEY` in `.env` (both keys are there).

---

## 6. Restrictions & invariants (NEVER violate)

- **Single-writer:** never let two agents edit the same file concurrently.
- **Kernel purity:** no I/O / no concrete feature names in `packages/kernel`
  (`.dispatch/rules/kernel-purity.md`).
- **Visibility rule (§5.1):** agents see only other units' CONTRACTS, never their
  implementation. A contract documents **behavior & guarantees a consumer can
  rely on, not just types** (P6 applied to contracts). An agent *needing* to read
  another unit's code is a signal that contract is underspecified — fix the
  contract, don't grant code access. (Exception: the temporary multi-knowledge
  integration agent, §5 / ORCHESTRATOR §5, which MAY read implementation.)
- **The orchestrator NEVER reads or edits implementation.** You read ONLY contracts
  (`packages/kernel/src/contracts/*`) + surfaces (manifests, public signatures) +
  diagnostics (`typecheck`/`test` output, `lsp references` on contract symbols) +
  agent reports. Do NOT open implementation `.ts` files (feature logic, tests,
  composition roots) — not even during a bug. Clean context = level-headed
  decisions; the subagents do the implementation.
- **What the orchestrator MAY edit directly:** (a) **contracts**
  (`packages/kernel/src/contracts/*`); (b) **build wiring + config** (root/package
  `tsconfig.json`, `package.json` deps, project refs, `.gitignore`, `bun.lock`);
  (c) **harness/docs** (`ORCHESTRATOR.md`, `AGENTS.md`, `GLOSSARY.md`,
  `.dispatch/rules/`, `notes/`, `tasks.md`, `prompts/`, `reports/`). Everything else
  — all executable implementation `.ts`, including tests and composition roots like
  `host-bin/src/main.ts` — changes ONLY by summoning the owning agent.
- **Roadblock → surface to the user.** If a needed change doesn't fit the above
  (ambiguous ownership, a design question, a stuck agent), stop and ask rather than
  reaching into implementation.
- **Subagents inherit this restriction.** Every prompt you write must instruct the
  agent to read ONLY the surfaces (contracts/hooks) of OTHER units, with the sole
  exception that it MAY read the implementation files of the task/extension it is
  assigned to. It must not go spelunking through sibling units' implementations.
- **`onAny` is the ONLY allowed dynamic hook subscription** (observability/logging
  firehose). All other cross-extension coupling is typed-symbol anchored (§5.4).
- **Contracts are static TYPES; loading is dynamic** (manifests via host). This
  split is load-bearing — it's what makes `lsp references` fan-out work.
- **Full fidelity:** every core feature is a real extension with a manifest,
  loaded through the host. Do NOT hand-wire imports to shortcut the extension
  model — that defeats the point.
- **Asymmetric testing:** strict (zero internal mocks, high coverage) on
  kernel/pure-core; lenient (thin integration tests) on the shell.
- **Destructive git ops:** be extremely careful. Back up irreplaceable files
  (e.g. `notes/restructure-plan.md`) to `/tmp` before any `git reset --hard` /
  `git clean`. `.env` is gitignored — preserve it.
- **Write things up before pivoting topics.** Keep `tasks.md` current in real
  time. Don't leave decisions only in chat context (it can be lost).

---

## 7. Repo geography

```
/home/tradam/projects/dispatch/arch-rewrite   # THE worktree (branch arch/rewrite)
  AGENTS.md ORCHESTRATOR.md GLOSSARY.md tasks.md
  .dispatch/rules/*.md
  notes/restructure-plan.md   notes/opencode-agents.md
  prompts/   (gitignored — orchestrator→agent prompts)
  reports/   (gitignored — agent→orchestrator reports)
  .env       (gitignored — DISPATCH_API_KEY [opencode-2 active], _OPENCODE1 backup)
  packages/
    kernel/            contracts (ABI), bus, runtime (runTurn), host
    transport-contract/  types-only HTTP API contract (CLI + future web + server share it)
    storage-sqlite/ conversation-store/ auth-apikey/ provider-openai-compat/
    credential-store/  named credentials + model catalog (resolve / listCatalog)
    session-orchestrator/ transport-http/    (core extensions)
    tool-read-file/    standard tool extension (read_file; cwd-aware)
    journal-sink/ trace-store/ observability-collector/ trace-replay/  (observability)
    cli/               bundled one-shot terminal client (HTTP client of transport-contract)
    host-bin/          composition root (boot + Bun.serve + collector supervisor)
```

The genesis commit deleted all prior source; we rebuilt from scratch. The OLD
project lives at `/home/tradam/projects/dispatch/dispatch-source` (reference only
— do not edit).

---

## 8. Current status & how to run

See `tasks.md` for the live checklist. As of MVP completion:
- Kernel + 6 core extensions + host-bin DONE. 178 tests pass; typecheck + biome
  clean.
- **MVP verified live:** multi-turn curl against OpenCode Go flash works
  (`conversationId` threads history).

**Boot + smoke test:**
```bash
cd /home/tradam/projects/dispatch/arch-rewrite
KEY1=$(grep DISPATCH_API_KEY_OPENCODE1 .env | cut -d= -f2)
PORT=4567 DISPATCH_API_KEY="$KEY1" bun packages/host-bin/src/main.ts   # boots server
# in another shell:
curl -s -X POST localhost:4567/chat -H 'content-type: application/json' \
  -d '{"conversationId":"c1","message":"Say hello in 3 words."}'
```
Note the chat field is **`conversationId`** (threads multi-turn), not `tabId`.

**Live validation & process cleanup — the `[x]` bracket trick (scar tissue).** When
you live-validate you background the app (`bun packages/host-bin/src/main.ts &`), and it
now spawns a child **observability collector** process. To list or kill those, ALWAYS
use the bracket trick in `ps`/`pgrep`/`pkill` patterns:
```bash
ps -eo pid,args | grep '[o]bservability-collector/src/main'   # list (won't self-match)
pkill -9 -f '[h]ost-bin/src/main.ts'                          # kill the app
pkill -9 -f '[o]bservability-collector/src/main'              # kill the collector
```
**Why it matters:** a plain `pkill -f 'host-bin/src/main.ts'` matches its OWN command
line and kills the parent shell → the tool call prints NOTHING and times out, looking
exactly like a wedged session. `[h]ost-bin` matches the target "host-bin" while the
literal pattern `[h]ost-bin` does not match itself. ALWAYS clean up the backgrounded app
+ its spawned collector after each live run — leaked processes pollute the next run's
counts (this is precisely what made a correct supervisor look like it spawned 3
collectors and left 2 behind).

**Next suggested work** (post-MVP, see `tasks.md` "Open items"): wire
auth→provider properly (auth-apikey is currently vestigial), then add the first
TOOL extension to exercise the dispatch loop (turns currently run with `tools:
[]`).
