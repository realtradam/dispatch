# Dispatch Restructure — Living Plan

> **Status:** Planning only. No implementation has begun.
> **Purpose:** Capture the target architecture, the engineering principles that
> govern it, and the current-state map — so any agent or human picking this up
> has the full picture in one place. This is a *living* document: update it as
> decisions are made and pieces land.

---

## 0. The goal in one paragraph

Restructure Dispatch so the **kernel is the absolute minimum** — just enough to
run an agent turn and host extensions — and **every feature is an extension**.
Extensions must be creatable and loadable *from outside this project* (custom /
third-party extensions), with identical contracts to the bundled ones. For now
we are planning the **backend only**; the frontend will be reworked separately
and modularly later, so **no design decision here should be driven by the current
frontend**.

---

## 1. Engineering principles (the standard for this project)

These are adopted because each solves a **specific, named problem in this
codebase** — not because they are popular. Each carries its stopping point so we
don't over-apply it.

### P1 — Feature-as-a-library
Every feature is independently importable with a clean, documented, minimal API.
The acceptance test: *can you import just this feature and use it standalone,
without dragging in the whole app?*

- **Evidence:** `agent-manager.ts` is ~2,453 lines where no single behavior
  (queueing, tool-assembly, fallback) can be extracted or reasoned about in
  isolation. By contrast `chunks/transform.ts` is deliberately DB-free so the
  backend *and* frontend share the same pure logic — feature-as-a-library done
  right, already in the repo.
- **Stopping point:** Do **not** over-split into dozens of micro npm packages
  with version-skew and `package.json` ceremony. Internal import-cleanliness
  first; a separately *publishable* package only when there's a genuine outside
  consumer.

### P2 — Functional core / imperative shell
Pure *decision* logic ("given this state + event, what should happen?") as pure
functions; the actual I/O (shell, fs, LLM, SQLite) lives in thin adapters
**injected** at the edges.

- **Evidence:** `wake-scheduler.ts` already does this and says so: "Pure helpers…
  side-effect-free so the logic can be unit-tested without spinning up Hono or
  touching SQLite." The giant `vi.mock("@dispatch/core")` blocks in
  `agent-manager.test.ts` exist *because* effects are reached for instead of
  passed in.
- **The honest framing:** An agent system *is* side effects — running shell,
  writing files, calling the LLM are the product. The goal is **testability and
  predictability, not purity for its own sake.**
- **Stopping point:** Where separating decision from effect makes a unit
  obviously testable, do it. Where it would only add ceremony (DI containers,
  effect-wrapper types) around an unavoidable `await spawn(cmd)`, don't. Purity
  is a means; if it stops paying for itself, drop it.

### P3 — No ambient / hidden state
State is **owned and passed explicitly**, never reached for as a hidden global or
stateful singleton.

- **Evidence:** Wishlist bugs #16 ("agent tools leak across tabs") and #17
  ("agent/model setting changes on tab switch") are *caused by* shared mutable
  singletons / frontend-held state. Explicit per-tab state ownership fixes them
  structurally.
- **Stopping point:** Stateless classes-as-namespaces are fine. Stateful
  god-objects (today's managers) are the thing we're killing. The tool-set for a
  turn must be reproducible from `(agent profile + capabilities + active
  extensions)` — pure input → output.

### P4 — Don't adopt by reputation (meta-principle)
Every pattern, library, or methodology — **including the "minimal kernel +
extensions" architecture itself** — earns its place by solving a specific,
named problem in *this* codebase, and we note where it stops paying off. "It's a
known good practice" is a hypothesis to test, not a justification.

### P5 — The repo is a harness, not just code
Meta-information that guides future agents is a **first-class deliverable**,
maintained like code. Modeled as a *tiered cache* of context: small
always-loaded files + larger on-demand files, so an agent gets the right info at
the right moment without burning context.
(Source: "The AI Harness" — see §7. Bounded to our scale in §7.4.)

### P6 — Document only the non-inferable
Harness docs contain **tribal knowledge and scar tissue only** — never generic
best-practice the model already knows. Test: *"Could a fresh frontier model
figure this out by reading the code? If yes, leave it out."*
(This is P4 applied to documentation — it self-limits harness bloat.)

### P7 — The harness is extension-scoped
Every extension ships **its own** constitution snippet, safety rules, feature
doc, glossary terms, and skills — portable with the code. This is P1
(feature-as-a-library) applied to documentation: import the extension, get its
harness too. Better than a repo-global harness for a modular system.

### P8 — One canonical vocabulary
A `GLOSSARY.md` with an **"aliases to avoid"** column governs naming. New code
reuses existing terms; it never invents a synonym for an existing concept.

- **Evidence:** This codebase overloads **tab / session / conversation** and
  **chunk / message / turn / step** — the chunk-log refactor notes exist
  precisely because those terms got tangled.
- **Live application:** "core" now has a precise meaning (the extension tier in
  §2.6) — it must NOT be reused for the kernel. Kernel ≠ core.

---

## 2. Target architecture — minimal kernel + extensions

### 2.1 Layered picture

```
┌───────────────────────────────────────────────────────────────┐
│  Clients (any frontend — reworked later, out of scope now)     │
└───────────────────────────────────────────────────────────────┘
            ▲ typed events / commands (via a transport extension)
┌───────────────────────────────────────────────────────────────┐
│  STANDARD extensions  (the features people think of as Dispatch)│
│  tools (read_file, run_shell…) · agents · skills · lsp ·       │
│  compaction · notifications · scheduler · attachments · …       │
└───────────────────────────────────────────────────────────────┘
            ▲ depend on kernel + core (never upward)
┌───────────────────────────────────────────────────────────────┐
│  CORE extensions  (minimum glue to run ONE turn end-to-end)    │
│  transport · provider · auth · session-orchestrator           │
└───────────────────────────────────────────────────────────────┘
            ▲ register contributions      ▲ receive Host API
┌───────────────────────────────────────────────────────────────┐
│  KERNEL  (minimal; not an extension)                           │
│                                                                │
│   Extension Host        Agent Runtime        Event/Hook Bus    │
│   (discover/resolve/     (the turn loop,      (typed pub/sub    │
│    activate/registries)  provider+tool        + filters)       │
│                          agnostic)                             │
│                                                                │
│   Kernel Services (exposed through Host API):                  │
│   • Capability/Permission gate   • Config (merge + schema)     │
│   • Storage + migration runner   • Secret/credential vault     │
│   • Conversation/chunk store     • Logger                      │
│                                                                │
│   Contracts (the stable ABI every extension compiles against) │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 The Kernel — the "absolute minimum"

Five things, nothing more:

1. **Contracts (the stable ABI).** The only types extensions depend on, versioned
   independently from implementations. Seeded from today's `types/index.ts`:
   - `ToolContract` (today's `ToolDefinition`: `{ name, description, parameters,
     execute(args, ctx) }`) — see §3.3 for the `ctx` requirements concurrency forces.
   - `ProviderContract` (model factory + streaming + catalog/capability entries)
   - `AuthContract` (credential sources / OAuth flows feeding the vault)
   - `Extension` + `Manifest` (id, version, apiVersion range, deps, activation,
     contributions, capabilities)
   - `HostAPI` (what an extension receives on activate — see §2.3)
   - `Hook`/event taxonomy (the lifecycle surface)
   - Conversation model (`ChatMessage`, `Chunk`, turn/step)

2. **Extension Host.** Discover → validate manifest → resolve dependency DAG →
   check apiVersion compat → run migrations → activate (topological) → register
   contributions → dispose on shutdown/reload. Owns the **registries** (tools,
   providers, hooks, routes/commands, services, settings, migrations, jobs).

3. **Agent Runtime (the turn loop).** The refactored heart of today's `agent.ts`:
   takes *a resolved provider + a tool set + messages + a dispatch policy*,
   streams, dispatches tool calls (see §3.3), dedups, truncates/spills, emits
   events. **Provider-agnostic and tool-agnostic** — knows only the contracts.
   Names no concrete tool or provider.

4. **Event / Hook Bus.** Typed pub/sub plus *filters*:
   - **Observers** react (notifications, persistence, usage accounting).
   - **Filters** transform in a chain (system-prompt assembly, message pre-send,
     tool-result transform, tool-set filtering).

5. **Kernel Services (via Host API).** The kernel exposes *interfaces* and pure
   logic here — **never concrete I/O backends** (those are `core` extensions; see
   §2.8). This keeps "kernel touches no I/O" (§2.7) literally true.
   - **Config loader** — merged loader (global → project) + per-extension
     settings schema/validation. **Must be in the kernel** (not an extension):
     it's needed at boot to *find and resolve* extensions — a chicken-and-egg the
     extension system itself can't solve. Seeded from today's `config/`.
   - **Logger** — always-on, available before any extension activates.
   - **Permission rule *evaluation*** — the pure `evaluate(rules, request) →
     decision` function (today's `permission/evaluate.ts`): rules in, decision
     out, no I/O. The *interactive prompting* (asking a human, today's
     `permission-manager.ts`) is a transport/UI concern owned by a `core`/
     `standard` extension, not the kernel.
   - **Storage interface + migration runner** — the kernel defines the storage
     *contract* (namespaced KV/SQL + per-extension migration registration) and
     exposes `host.storage(ns)`, but the **concrete backend (SQLite) is a `core`
     extension** (`storage-sqlite`), swappable for an in-memory store in tests
     (serves P2 directly). Bootstrap ordering: the storage backend activates
     first (no deps) so later extensions can run their migrations.
   - **Secret/credential vault interface** — `host.secrets` (capability-gated);
     the concrete store and the *auth flows* that fill it are extensions.
   - **Conversation/chunk store** — NOTE: the kernel owns only the **conversation
     model TYPES** (`Chunk`/`ChatMessage` in contracts) and the pure
     explode/group transforms (today's DB-free `chunks/transform.ts`). The
     **persistent store itself is a `core` extension** built on `host.storage` —
     because persistence is I/O. The runtime reads/writes history *through the
     orchestrator*, which calls the store; the kernel's `runTurn` takes
     `messages` as a plain input and returns result messages (it never touches
     the DB).

> **Deliberately NOT in the kernel:** any concrete tool, any provider, any
> concrete persistence/secret backend, the persona/system-prompt text, the HTTP
> server, interactive permission prompting, tab/queue orchestration, sub-agents,
> skills, LSP, notifications, compaction, scheduling.

### 2.3 The extension model

- **What it is:** a directory or npm package with a **manifest** + entry module
  exporting `activate(host)` and optional `deactivate()`.
- **Manifest shape:** `id, name, version, apiVersion (semver range), dependsOn[],
  activation ("eager" | lazy event triggers), contributes {tools, providers,
  routes, commands, hooks, settings, migrations, scheduledJobs, services},
  capabilities {fs, shell, network, secrets, db, spawn…}, settingsSchema`.
- **Each extension's contract is two-sided (provides + expects):** what it
  *exposes* (its contributions/services) and what it *expects exposed to it*
  (its `dependsOn` services + `capabilities`). This two-sided contract is what
  the host uses to resolve load order and what makes an extension portable.
- **Host API (what `activate(host)` receives):**
  - `host.defineTool/defineProvider/defineAuth(...)`
  - `host.defineRoute/defineCommand(...)` — for transports & UI actions
  - `host.on(hook, handler)` / `host.addFilter(hook, fn)`
  - `host.provideService(handle, impl)` / `host.getService(handle)` — typed DI
    via **typed service handles** (an exported symbol, NOT a raw string — so
    `lsp references` can compute a service's consumers; see §5)
  - `host.storage(namespace)` — scoped KV/SQL + migrations (interface; backed
    by the `storage-sqlite` core extension — see §2.8)
  - `host.config` / `host.settings`
  - `host.secrets` (capability-gated)
  - `host.permissions.check(request)`
  - `host.events.emit(...)` / `host.logger`
  - `host.scheduler.register(job)`
- **Contribution points** (replacing today's wiring):
  | Point | Replaces today's | Examples |
  |---|---|---|
  | tools | per-turn assembly in `agent-manager` | read_file, run_shell, web_search |
  | providers | `llm/provider.ts`, `models/registry` | anthropic, opencode, google |
  | auth | `credentials/*` | claude OAuth, api-keys |
  | context filters | `buildSystemPrompt`, skills/agents injection | persona, skills, agent profiles |
  | hooks/observers | scattered wiring | notifications, usage accounting |
  | routes/commands | `api/routes/*` | `/chat`, `/tabs`, `/models` |
  | scheduled jobs | `wake-scheduler.ts` | cache-warm, wake probes |
  | migrations | `db/index.ts` table block | each extension owns its tables |
  | services | implicit singletons | LSP manager, model registry |
- **Loading / lifecycle:** search paths (precedence high→low) =
  project `.dispatch/extensions` → global `~/.config/dispatch/extensions` →
  installed npm packages (naming convention) → bundled first-party. Resolve DAG →
  verify apiVersion → run migrations → activate topologically (lazy ones defer to
  their activation event) → ready. Hot-reload via watchers (config already does
  this); deactivate disposes everything the extension registered.

### 2.4 Extension catalog (current code → extensions, with tier)

- **core tier (the minimum to complete one turn — see §2.8):**
  `storage-sqlite` (concrete backend behind `host.storage`), `conversation-store`
  (append-only turn/chunk persistence on top of `host.storage`; today's
  `db/chunks.ts` + `db/tabs.ts`), `transport` (accept message, stream events —
  HTTP/WS, or even stdio), `provider-×1` (one LLM provider), `auth-×1` (that
  provider's credentials), `session-orchestrator` (the turn-driver carved out of
  `agent-manager.ts`).
- **standard tier — tools:** `tools-fs` (read_file, read_file_slice, write_file,
  list_files), `tool-shell` (run_shell + background store + shell-analyze),
  `tool-search` (search_code), `tool-web`, `tool-youtube`, `tool-todo`,
  `tool-key-usage`.
- **standard tier — providers & auth beyond the minimum:** `provider-anthropic`,
  `provider-opencode`, `provider-google`, `provider-copilot`; `auth-claude`
  (OAuth), `auth-apikeys`, `models-catalog` (registry + capabilities). *(Note:
  the single provider/auth required to boot is "core"; additional ones are
  "standard". Which specific one is the core default is a §8 decision.)*
- **standard tier — subsystems:** `lsp` (manager service + `lsp` tool +
  diagnostics-on-write filter), `agents` (sub/user-agent system + `summon`/
  `retrieve`), `skills` (loader + context-filter), `session-features` (tabs,
  queue, deliverMessage, auto-wake budget, `send_to_tab`/`read_tab` — the parts
  beyond the minimal orchestrator), `compaction`, `notifications-ntfy`,
  `wake-scheduler`, `attachments` (multimodal validation/limits).

> Result: **`agent-manager.ts` dissolves** into the kernel's turn loop + the
> core `session-orchestrator` + standard-tier contributions.

### 2.5 Proposed package layout

```
packages/
  kernel/                    # the kernel ONLY (NOT named "core" — see P8 / §2.6)
    contracts/               # the KERNEL ABI ONLY (turn loop, HostAPI, hook/event
                             #   mechanism, conversation model) — versioned.
                             #   Per-extension contracts are NOT here — they live
                             #   co-located in each extension package (see §5).
    host/                    # discovery/resolve/activate + registries
    runtime/                 # the agent turn loop (incl. tool dispatch, §3.3)
    bus/                     # events + filters
    services/                # config loader, logger, permission eval, storage IFACE + migration runner, secrets IFACE
  extensions/
    core/                    # core-tier: storage-sqlite, conversation-store, transport,
                             #            provider-×1, auth-×1, session-orchestrator
    standard/                # standard-tier: tools, agents, skills, lsp, compaction, …
                             # each extension package owns its OWN contract
                             # (what it exposes/requires + its hook & service
                             #  handles) co-located inside it — see §5
  host-bin/                  # thin bootstrapper: make kernel, point at ext dirs, activate
  sdk/                       # helper toolkit + types for THIRD-PARTY ext authors
  frontend/                  # reworked later
```

### 2.6 Tiers: kernel → core → standard

We classify extensions into tiers. **Tiers are labels over the dependency DAG,
not a second enforcement mechanism** — the host resolves load order from each
extension's declared deps, and the capability gate enforces access. Tiers
describe *what ships in which distribution*.

| Tier | Objective test | Distribution |
|---|---|---|
| **kernel** | the ABI + turn loop; *not* an extension | always |
| **core** | required to complete one turn end-to-end | "minimal Dispatch" |
| **standard** | ships on by default; defines Dispatch-as-known | "default Dispatch" |
| *(external)* | not in this repo | community / custom |

- **No "extras" tier yet.** Empty categories are over-planning. A fourth tier
  (bundled-but-off-by-default) earns existence only when a real feature is
  genuinely opt-in — not by demoting an existing feature to fill a slot.
- **The one invariant that gives tiers teeth — no upward dependencies.** A `core`
  extension may depend on the kernel and other `core` extensions, never on
  `standard`. Checkable straight from manifests (a lint). This is what makes
  "the minimal distribution still boots" *true* rather than aspirational.
- **Naming (P8):** "core" is the extension tier; the runtime primitive is the
  **kernel**. Never reuse "core" for the kernel.

**Placement test in action — `read_file` is `standard`, not `core`.** Apply the
test: remove `read_file` → the agent just replies with text; the turn still
completes. So it fails the core test → it's `standard`. The surprise that
validates the model: **tools are not the minimum.** A turn can happen with zero
tools. `read_file` being *important* is why it ships on-by-default in `standard`
— not why it's `core` (resisting "important ⇒ core" keeps `core` from regrowing
into a god-object; P4).

### 2.7 Kernel vs core boundary + how a tool plugs in

**Boundary rule (one sentence):**
> **Kernel = the pure turn mechanism** (decides nothing, touches no I/O, names no
> feature). **Core = the minimum glue** that wires real inputs into that
> mechanism and handles the results — opinionated and effectful, which is exactly
> why it can't live in the kernel.

**Example — the `session-orchestrator` (core), carved out of `agent-manager.ts`:**
```ts
host.on("message.received", async (msg) => {
  const conversation = await host.conversation.load(msg.tabId);   // effect: read state
  const provider     = host.providers.resolve(msg.model);          // decision: pick LLM
  const tools        = host.tools.resolveFor(msg.tabId);           // decision: gather/filter
  const dispatch     = resolveDispatchPolicy(msg);                 // decision: §3.3 toggle

  const result = await kernel.runTurn({                            // ← call the kernel
    provider, messages: conversation.messages, tools, dispatch,
    emit: host.events.emit,
  });

  await host.conversation.append(msg.tabId, result.messages);     // effect: persist
});
```
Every line is a **decision** (which provider/tools/policy) or an **effect**
(load/persist) — neither belongs in the kernel.

**How a tool builds "on top of" the kernel (inversion of control).** The kernel
never *finds* tools; it *receives* them. The dependency arrow points
tool → contract → kernel, never the reverse:
1. A tool conforms to `ToolContract` (owned by the kernel) — importing only the
   contract, not the kernel internals or other tools.
2. It registers at activation: `host.defineTool(createReadFileTool(workdir))`.
3. The orchestrator gathers them: `host.tools.resolveFor(tabId)`.
4. They're handed into `runTurn`, which calls them blindly by shape
   (`byName.get(call.name).execute(...)`). The kernel never knows `read_file`
   exists. 0, 1, or 50 tools — the loop is identical.

### 2.8 The Minimum Viable Turn (what "core" must contain)

Derived by tracing the **real** end-to-end path of a single message in today's
code — `POST /chat` → `deliverMessage` → `processMessage` → `getOrCreateAgentForTab`
(`new Agent`) → `for await (event of agent.run())` → `emit(event)` → `/ws`
fan-out — and stripping everything not load-bearing.

**Two readings of "send a message, get a response":**
- **(A) Absolute minimum mechanism** — one stateless request→response; needs *no
  DB at all*. (Useful as the testing/embedded floor.)
- **(B) Minimum useful chat** — real multi-turn, so turn 2 sees turn 1. Adds
  conversation persistence.

**DECIDED: `core` targets (B).** "Minimal Dispatch" is a usable multi-turn chat.
The single piece separating (B) from (A) is the **conversation store + storage
backend** — drop those two and you have the stateless (A) floor (which is exactly
the in-memory test configuration).

**Stripped from the real path → all of these are `standard`, NOT core** (each
confirmed removable without breaking a basic turn): key/model **fallback chain**
(`buildFallbackSequence`, rate-limit retry), **tools** entirely (empty tool list
→ turn still completes as text), **interactive permission prompting** (only
exercised *by* tools), **reasoningEffort / attachments / workingDirectory**
overrides, **skills, agents/summon, lsp, notifications, compaction, queue /
auto-wake, usage telemetry, prompt-cache warming**, and the system-prompt
**TOOL_DESCRIPTIONS + task-management** assembly (minimal = a plain/empty system
string). This concretely confirms §2.6's surprise: **tools, persona, and
permissions are all riders — the turn loop needs none of them.**

**KERNEL exposes (for the minimal turn):**
| Thing | Why kernel | From today |
|---|---|---|
| Contracts (ABI): `ProviderContract`, `ToolContract`, `AuthContract`, `Extension`/`Manifest`, `HostAPI`, event taxonomy, conversation model (`Chunk`/`ChatMessage`) | shared types everything compiles against | `types/index.ts` |
| Extension Host + registries | nothing runs without discover/resolve/activate | (new) |
| `runTurn({ provider, messages, tools, dispatch, emit, signal })` | the pure turn loop (§3.3); takes `messages` as input, returns result messages, touches no DB | `agent.ts` |
| Event bus | how the turn talks to the outside | `onEvent`/`emit` |
| Config loader | needed at boot to find extensions (chicken-and-egg) | `config/` |
| Logger | always-on, pre-extension | — |
| Permission rule *evaluation* (pure) | rules in → decision out | `permission/evaluate.ts` |
| `host.storage` / `host.secrets` *interfaces* | exposes the shape; backend injected | — |

**CORE provides (the minimum extensions to complete one turn):**
| Extension | Job on the minimal path |
|---|---|
| `storage-sqlite` | concrete backend behind `host.storage` (the (A)↔(B) piece; swap for in-memory in tests) |
| `conversation-store` | append-only turn/chunk persistence on `host.storage` (so turn 2 sees turn 1) |
| `transport` | accept the message; stream events back (HTTP/WS, or stdio) |
| `provider-×1` | call an LLM and stream tokens |
| `auth-×1` | supply that provider's credentials |
| `session-orchestrator` | wire it together (below) |

**The minimal turn, end to end (target):**
```
transport.receive(msg)
  → orchestrator: history  = conversationStore.load(convId)    // core (skip → (A) stateless)
  → orchestrator: provider = providers.resolve(model)          // core ext + auth
  → kernel.runTurn({ provider, messages: [...history, msg], tools: [], dispatch, emit })
  → emit(events) → transport.stream(events)                    // core ext
  → orchestrator: conversationStore.append(convId, result)     // core ext
```
Note `tools: []` — a turn completes with zero tools (text reply). Every capability
beyond this is a `standard` extension that contributes tools / filters / hooks.

### 2.9 Contract versioning (convention now, machinery deferred)

**Reframe first (P4):** semver's machinery exists to coordinate **independent
release timelines** (a producer ships v2; consumers upgrade whenever). That
*temporal decoupling* is the problem it solves — and we mostly don't have it:
- **Internal extensions** (bundled, in-repo): no decoupling. A contract change is
  found via `lsp references` (§5.3) and fixed atomically in one change set. **The
  type system IS the version check** — a breaking change is a compile error.
- **External/custom extensions** (out-of-repo): decoupling is real — the compiler
  can't see their code. A declared version compatibility gate earns its place
  **only here.** *(And we don't support external extensions yet — see below.)*

So versioning is **asymmetric**, like §3.6 / §3.7: *internal = the type system is
the version; external = a declared version is the contract.*

**Two different "versionings" — keep them separate:**
- **Data/schema migration** (persisted-data evolution) — already decided (§2.2:
  each extension owns its migrations). NOT this section.
- **Contract/API-surface versioning** — this section. Independent: a contract can
  change with no migration, and vice-versa.

**DECISION — convention-only and dormant in 0.x.** Because everything is
**developed in-house today** (no external extensions), we adopt the *vocabulary*
of versioning, not the *bureaucracy*:
- **Every package self-versions.** No enforced lockstep / single repo version:
  the kernel bumps when the ABI changes; an extension bumps when *its* contract
  changes. Independent versioning matches one-agent-per-unit (§5) — each owner
  manages its own.
- **Semver *meaning* as disciplined changelog hygiene** (and the §5.3 fan-out
  signal), using the standard terms:
  - **major** — removing or modifying the contract surface (incl. a hook/service
    payload shape change). *Breaking.* This bump is the orchestrator's cue to fan
    out to **all** consumers (found via `lsp references`).
  - **minor** — adding to the contract surface. Existing consumers unaffected.
  - **patch** — internal change only; no surface/payload change.
- **Right now the version is COMMUNICATION, not ENFORCEMENT.** With no external
  consumers, the type system + `lsp references` are the actual mechanism; the
  number is a changelog/fan-out signal for humans and agents — not load-bearing.
- **Stay in `0.x`** (conventionally: "no stability promised") through the rewrite,
  while the ABI churns. `1.0.0` is reserved for "stable enough to invite external
  extensions" — and **that** decision is the trigger to build the deferred
  machinery below. We worry about it when we get there, not before.

**Deliberately NOT built now (deferred until external extensions exist):**
- A load-time **version-compat gate** (external manifest pins an `apiVersion`
  range; host disables+surfaces on mismatch per §3.7 fault containment).
- A mechanical **`.d.ts`-surface-diff** in CI to flag breaking changes
  automatically (removes semver's human-judgment weakness).

**Harness rule this generates (scoped to contract-defining agents only; written
into agent files when those agents exist, not now):** "Follow semver on your
contract: **major** = removed/renamed/retyped export or changed hook/service
payload (and signals the orchestrator to fan out to all `lsp references`
consumers); **minor** = additive; **patch** = no surface change. Internal
consumers are caught by the compiler — the version is for the fan-out signal (and,
later, external consumers)." *(The term "patch" is training-standard vocabulary,
so it needs no glossary entry — P6.)*

---


### 2.10 Core-default provider/auth (the boot minimum + primary testbench)

**Criterion (not "best provider" — leanest, most-testable core per §2.8/§3.6):**
the one provider+auth that makes "minimal Dispatch" boot with the smallest auth
surface and the lightest test setup.

**DECISION: OpenAI-compatible provider + API-key auth is the core default** —
`provider-openai-compat` + `auth-apikey`. This is *also* the primary testbench:
**OpenCode Go (flash) IS this path.**
- In today's code it is `createProvider`'s **default branch**
  (`createOpenAICompatible`, name `"opencode-zen"`) with the hardcoded defaults
  `model: "deepseek-v4-flash"`, `baseURL: "https://opencode.ai/zen/go/v1"`, and a
  plain **API key** — the simplest possible `AuthContract`.
- **Why it's the right core default (grounded, P4):**
  1. **Simplest auth = leanest core.** `apiKey` + `baseURL`, nothing else. Claude
     OAuth (token refresh, billing/beta headers, session id, account discovery)
     would bloat the *minimum* tier and contradict §2.8.
  2. **Most generic contract shape.** OpenAI-compatible is a near-universal wire
     format (dozens of providers + local Ollama/LM Studio), so the core's one
     provider is really "the protocol most of the world implements."
  3. **Already the literal default** in `createProvider` — core encodes a decision
     the codebase already made.
  4. **Best for §3.6 testability.** API-key auth fakes trivially (a string + a
     base URL at a mock server); OAuth would force token-refresh mocking — the
     exact mock-sprawl we're fighting.
- **Project fit (the deciding constraint):** the two available subscriptions are
  **Claude** and **OpenCode Go**. OpenCode Go has the most generous limits/API
  (especially the **flash** agents) → it is the **primary test bench**. The lean
  core default and the testbench are therefore the *same* path — no tension.

**Tier placement that follows:**
- **core:** `provider-openai-compat` + `auth-apikey` (boots minimal Dispatch; =
  OpenCode Go flash via `/zen/go/v1`).
- **standard:** `provider-anthropic` + `auth-claude` (OAuth — your daily driver,
  rides on top), plus the **Anthropic-format OpenCode Go models** (MiniMax/Qwen
  via `isOpencodeGoAnthropicModel`, a different endpoint than flash),
  `provider-google`, `provider-copilot`, etc.
- Mirrors every prior decision: the rich/preferred providers ride on top as
  standard extensions; core proves the architecture with the simplest path.

**Naming (P8):** `provider-openai-compat`, `auth-apikey` — descriptive,
training-adjacent; no glossary entry needed.

---

## 3. Runtime flow

### 3.1 Boot
1. Host process starts kernel with config + extension search paths.
2. Kernel opens DB, loads merged config, builds the capability gate.
3. Extension host discovers manifests → resolves DAG → checks apiVersion → runs
   migrations.
4. Activates extensions topologically; each registers tools / providers / hooks /
   routes / services / jobs.
5. `transport-http` listens; `session-orchestrator` subscribes to message intake;
   scheduler arms jobs. Ready.

### 3.2 A turn
1. Inbound message hits a `transport` route → emits `message.received`.
2. `session-orchestrator` resolves conversation, working dir, the
   **provider+model+key** (provider registry + auth vault), the agent profile,
   and the **tool-dispatch policy** (§3.3).
3. **Context-assembly filter chain** runs: persona + skills + agent profile
   contribute system prompt and a tool-name filter.
4. Tool set = tool registry filtered by the **capability gate** + agent whitelist.
5. **Agent runtime loop:** `provider.stream(messages, tools)` → dispatch tool
   calls per the policy (§3.3) → gate check → `tool.before` filter → execute
   (exec context: shell-output streaming, cancellation, queued-message
   injection) → `tool.after` filter → feed results back; repeat until done.
6. Events stream on the bus → transport pushes to clients; `notifications`
   reacts; conversation store appends chunks; usage recorded.
7. `turn.sealed` hook → `compaction` may trigger; scheduler may schedule
   cache-warm.

### 3.3 Kernel internals — tool dispatch (togglable: `maxConcurrent` + `eager`)

**Mechanism.** The model streams tool calls *incrementally*: each `tool-call`
event is fully formed (parsed `input`) **before** the step's `finish-step`. So
the kernel can launch a call the moment it arrives. Tool calls batched in one
step are **independent by construction** — the model sees no result until the
next step — so running them concurrently/eagerly is *semantically safe*, not a
reordering risk.

**Today (for contrast):** `agent.ts` collects all `tool-call`s during the stream,
then executes them **after** the loop, **sequentially** (`for … await execute`).
That is `{ maxConcurrent: 1, eager: false }` — the safe baseline we keep available.

**Two orthogonal axes — the toggle.** A single enum conflated two independent
questions; we split them so every combination is coherent (no invalid states):
- `maxConcurrent` (a number) = *how many tools run at once*: `0` → unlimited,
  `1` → sequential (a concurrency limit of 1 is exactly serial), `2+` → that cap.
- `eager` (a boolean) = *when execution starts*: `true` → launch each call the
  instant its `tool-call` streams in (overlaps with the rest of generation);
  `false` → wait until the step's `finish-step`, then dispatch the batch.

| `maxConcurrent` | `eager` | Meaning |
|---|---|---|
| 1 | false | One at a time, after the stream ends → **previous (pre-rework) behavior** |
| 1 | true  | **DEFAULT.** Start the first tool the instant it arrives (overlap with generation), but never run two tools at once — safe for any tool |
| 2+ | false | Up to N in parallel, after the stream ends |
| 2+ | true  | Up to N in parallel, launched as they stream in |
| 0 | false | All in parallel, after the stream ends |
| 0 | true  | All in parallel, launched as they stream in |

**The policy is a KERNEL INPUT, never ambient (P3):**
```ts
interface ToolDispatchPolicy {
  maxConcurrent: number; // 0 = unlimited, 1 = sequential, 2+ = cap
  eager: boolean;        // true = launch on arrival; false = after finish-step
}
runTurn({ provider, messages, tools, dispatch /* : ToolDispatchPolicy */, emit })
```
The kernel receives a *resolved* policy; it never reads config itself.

**`eager` + a limit — exact semantics.** A streaming semaphore: launch on arrival
until `maxConcurrent` is reached, then queue; as each tool finishes, the next
(queued or newly-arrived) call starts. Well-defined for every combination above.

**Resolution (who sets it)** — mirrors the existing `reasoningEffort` precedence:
per-turn/tab override → agent definition → global config (`dispatch.toml`) →
built-in default. The `session-orchestrator` (core) resolves this and hands the
final value to the kernel.

**Default — DECIDED: `{ maxConcurrent: 1, eager: true }`.** Never two tools at
once (safe for any tool, incl. non-concurrency-safe ones), yet still overlaps the
first tool's execution with the rest of generation — zero risk, free latency.
Raising `maxConcurrent` (e.g. 4) is the opt-in throughput win; `0` (unlimited) is
a deliberate, footgun-aware opt-in (see complication #2).

**Contract requirements this forces (must be in `ToolContract`/`ctx` on day one
— retrofitting later is painful):**
- `ctx.onOutput(data, stream)` — streaming output the **kernel attributes by
  `toolCallId`**, so concurrent shell output doesn't interleave ambiguously
  (today's `shell-output` event carries no id — fine only because exec is
  sequential).
- `ctx.signal` — cancellation, so an aborted turn doesn't leak in-flight tool
  work.
- **`execute` must be safe to run concurrently** with other tools (no shared
  ambient state — this is just P3 paying off).

**Optional refinement (note, don't build yet):** a tool may declare
`concurrencySafe: false` in its contract; the kernel serializes *those* even when
`maxConcurrent` allows parallelism — so one mutating tool doesn't force the whole
batch sequential. This overrides the global setting **downward only** (never
widens parallelism).

**Complications checklist (carried from today's sequential code):**
1. **Shell-output attribution** → tag by `toolCallId` (above).
2. **Concurrency cap + dedup** → bound parallelism; populate the byte-identical-
   call dedup map in emission order (the "150 identical calls" incident — do not
   fire 150 effects at once). `maxConcurrent: 0` (unlimited) re-opens this
   footgun for *distinct* calls, so it must stay a deliberate opt-in, never the
   default.
3. **User-interrupt injection** → target the last call by **batch index**, not
   completion time (results return nondeterministically under concurrency).
4. **Abort / error cleanup** → await or cancel in-flight tools via `ctx.signal`;
   synthesize residual results for orphaned tool-call IDs (today's safety nets).
5. **Wasted effects on abort** → eager exec may complete a side-effecting tool
   (`run_shell`) *before* an abort; the effect already happened, result
   discarded. Accepted consciously for non-idempotent tools.

**Scope boundary.** This is **within a step's batch only**. Next-step tools can't
start early — they don't exist until the model sees this step's results. So
"before the turn ends" = "across the multiple tool calls in one step," which is
exactly the multi-tool-call case.

### 3.4 State, durability & crash recovery

**The worry (context):** a chat must survive *any* interruption — random shutdown,
token exhaustion, tool error — and the user just resumes with the same history,
never facing a "wipe it clean and start over" broken state.

**What today's code already gets right (keep this):**
- `appendChunks` wraps a whole turn's rows in **one SQLite transaction** + WAL →
  **atomic**: a hard crash mid-write yields *all* those rows or *none*. No half
  rows, no DB corruption. This is the most important property and it already holds.
- History is an **append-only chunk log** keyed by monotonic per-tab `seq`. Prior
  history is never mutated, so a crash can't corrupt what's already written.

**The real danger window (what to fix):** the whole assistant turn is accumulated
**in memory** (`chunks: Chunk[]`) and written **once at the end** (`flushAssistant`
on seal). A mid-turn crash loses the *entire* assistant turn. Two latent issues
compound it:
1. **Orphaned `running` status** — `status` is persisted to `tabs`; a crash leaves
   it `running` forever (no boot reconciliation resets stale `running → idle`).
2. **Orphaned tool-call IDs** — a crash between an assistant `tool_call` and its
   `tool_result` leaves a dangling call. Anthropic **rejects** such a history
   (`MissingToolResultsError`). Today's `synthesizeResidualToolResults` guards
   this *in memory* only — useless once the process is dead. **This is the exact
   "history the provider refuses to accept → start over" failure.**

```
user message ──► [persisted immediately ✓]
   │
   ├─ assistant streams text/thinking/tool-calls ──► accumulates IN MEMORY ONLY
   │                                                  (50 steps, tool runs, minutes…)
   │   ◄── CRASH HERE ──►  entire assistant turn GONE; maybe a dangling tool_call
   │
   └─ turn seals ──► flushAssistant() ──► [persisted ✓]
```

**The design — make broken state *unreachable*, not just recoverable.** Four
rules, each tied to a real failure above:

- **R1 — Persist incrementally, append-only (kill the in-memory window).** Write
  each step (not each delta) to the log as it completes, in its own transaction.
  A crash then loses at most the *last in-flight step*, not the whole turn.
  Granularity = per **step**, not per **delta** (a handful of writes per turn, not
  hundreds) — keeps IO modest. Make granularity configurable.
- **R2 — Recovery is a pure function of the log (the keystone).** On load, run a
  pure **`reconcile(rows) → cleanHistory`** that deterministically repairs any
  partial turn:
  - `tool_call` with no matching `tool_result` → synthesize an error result
    ("interrupted by shutdown"). This is today's `synthesizeResidualToolResults`
    logic **moved to the READ path** so it runs on *every* load, not just live.
  - a turn with no terminal assistant content → mark interrupted; user simply
    sends the next message to continue.
  - **Functional-core (P2):** rows in → clean history out, no I/O, exhaustively
    unit-testable with crafted "crash-shaped" inputs. **Guarantee: whatever a
    crash leaves, `reconcile` always yields a provider-acceptable history.**
    "Broken state" becomes a state the rest of the system never observes — it's
    repaired at the boundary.
- **R3 — Status is derived, never authoritative.** A persisted `running` flag is a
  lie waiting to happen. On boot, sweep all `running → interrupted`; AND treat
  live status as runtime-only (derive "is this tab live?" from "is there an
  in-process turn driving it?"). A crash can't leave a tab stuck running.
- **R4 — Resume = load → reconcile → continue.** Because history is append-only
  and `reconcile` guarantees validity, resuming after *any* failure is identical
  and invisible to the user — no special "recovery mode". Token-exhaustion and
  tool-errors already end the turn cleanly and persist (the error becomes a
  chunk), so they are *already* resumable once R1 closes the crash window.

**Where it lives (fits the architecture):** almost entirely in the
`conversation-store` **core extension** (R1 incremental write, R2 reconcile-on-load)
+ a tiny **boot sweep** (R3). The **kernel stays pure** — `runTurn` still just
takes `messages` and emits events; it knows nothing about crashes. `reconcile` is
the canonical **functional-core** unit (P2) and the highest-value test target in
the system (feed it every crash shape).

**Cost / boundary (P4):**
- R1 trades IO for safety (more, smaller transactions vs. one-per-turn — the
  current code chose one-fsync-per-turn for "constrained backends"). Per-step
  batching is the mitigation; granularity configurable.
- **Out of scope here:** resuming a half-finished assistant message *mid-sentence*
  (wishlist #1 "resume mid-generation" — needs in-flight streaming state). The
  promise here is narrower and is what's actually wanted: **the history is never
  broken, and the user can always continue the conversation.** Mid-stream
  resumption can build on this foundation later.

### 3.5 The hook system (extensible without prediction)

**The goal:** features react to actions in other features (e.g. *"user sent a
message → reset the cache-warming timer"*). Hooks must be **part of the
contracts** (typed, stable, exposed) *and* **easy to add later** without
predicting features that may never exist. Those only conflict if hooks live in a
central kernel registry — so they don't.

**What today's code already does (the patterns to generalize):**
- **Observer stream.** `NotificationDispatcher` depends not on `AgentManager` but
  on a minimal interface — `interface AgentEventSource { onEvent(listener):
  () => void }` — and wraps every handler so *"a transport bug can never
  propagate into the agent loop."* That's already a primitive hook contract
  (subscribe → react → unsubscribe, errors isolated).
- **Semantic lifecycle calls (a hook in disguise).** Cache-warming exposes
  `onUserMessage(tabId)` (cancel timer) and `onTurnEnded(tabId)` (re-arm),
  *called explicitly* from `tabs.svelte.ts`. Hand-wired coupling we want to
  dissolve into subscriptions.

**The keystone decision — decentralized hook catalog:**
> The **kernel owns the hook *mechanism*** (`emit`, `on`, `applyFilters`). Each
> **extension declares the hooks it emits** as part of its own contract. The hook
> catalog is the *union* of all extensions' declarations — never a central list.

The kernel never enumerates "the hooks that exist." This is what makes "add a
hook as required" a **local, additive** change instead of a kernel edit.

**The typed descriptor (the contract surface).** A hook is an exported, typed
descriptor — not a loose string:
```ts
// owned by the session-orchestrator (it performs message intake)
export const MessageReceived = defineHook<{ tabId: string; text: string }>("session/message.received");
// owned by the KERNEL (it owns the turn loop)
export const TurnSealed = defineHook<{ tabId: string; turnId: string }>("kernel/turn.sealed");
```
Consumers get full type inference, no central enum to edit:
```ts
// cache-warming extension (dependsOn session-orchestrator)
host.on(MessageReceived, ({ tabId }) => cancelTimer(tabId));   // payload inferred
host.on(TurnSealed,      ({ tabId }) => armTimer(tabId));
```
The descriptor **is** the contract: importing it gives the id + payload type.
Adding a hook = exporting one more descriptor from its owner.

**Two hook kinds (and one thing that is NOT a hook):**
| Kind | Shape | Changes outcome? | Errors | Awaited by turn? | Example |
|---|---|---|---|---|---|
| **Event** | fire-and-forget, N listeners | No | **isolated per-handler — never breaks the turn** (today's rule) | No (optional bounded timeout) | `message.received`, `turn.sealed`, `tool.after` |
| **Filter** | chain, value in → value out, ordered | Yes (in-band) | fail-open + log by default; owner may mark a chain fail-closed | Yes (in-band; a slow filter slows the turn, by design) | system-prompt assembly, tool-result transform |

> **NOT a hook: request/response with exactly one responder** (e.g. "ask the
> human for permission"). That's a **service** (`host.provideService` /
> `getService`) — one responder, returns a value. Modeling it as a hook invites
> "which of N handlers wins?" ambiguity. (Permission-prompting is the tempting
> thing to mis-call a hook — it isn't one.)

**The workflow you actually care about — "add a hook later":**
1. Find the **owner** (the extension that performs the action).
2. Export one descriptor from its contract: `defineHook<Payload>("owner/the.action")`.
3. Emit at the action site: `host.emit(TheAction, payload)`.
4. The consumer `dependsOn` the owner and subscribes. **Kernel unchanged.**

The kernel changes *only* when the action is a kernel-intrinsic turn-loop moment
(e.g. a new `tool.before` phase) — and even then it's **+1 exported descriptor +
1 emit line**, never a structural change, because the mechanism is generic.

**Decisions baked in now (all grounded, P4):**
- **Namespacing (P8):** every hook id is `owner/name` (`kernel/turn.sealed`,
  `session/message.received`) — prevents third-party collisions.
- **Event error isolation is a hard contract rule** (lifted from
  `NotificationDispatcher`): a thrown/rejected event handler is caught, logged,
  dropped — it can *never* fail the turn.
- **Filter ordering is deterministic:** dependency-topological registration order,
  with an optional numeric `priority` escape hatch.
- **Async semantics:** events are not awaited (fire-and-forget, optional bounded
  timeout); filters *are* awaited (in-band).

**Deliberately NOT built yet (P4 / P6):**
- No wildcard/pattern subscriptions (`turn.*`) until something needs them.
- No hook-to-hook dependency graph — registration order + `priority` suffices.
- **Don't hook every internal function.** A hook exists only where *cross-
  extension* reaction is a real need (mirrors P6 — expose only what's needed).
  Over-hooking turns the codebase into spaghetti-by-events.

**The cache-warming example, fully mapped:**
| Today (coupled) | Target (hooked) |
|---|---|
| `tabs.svelte.ts` calls `cacheWarming.onUserMessage(tabId)` | cache-warming does `host.on(MessageReceived, …)`; orchestrator emits it |
| `tabs.svelte.ts` calls `cacheWarming.onTurnEnded(tabId)` | cache-warming does `host.on(TurnSealed, …)`; kernel emits it |
| frontend hard-wires the dependency | cache-warming `dependsOn` session-orchestrator; zero call-site coupling |

Both hooks it needs (`message.received`, `turn.sealed`) already have natural
owners — **no prediction required**, which is the test that the model holds up.

### 3.6 Testability enforcement (design for tests, don't just write them)

**The principle:** don't merely write tests for code — write code *specifically so
it is testable*. Crucially, this is **not directly machine-enforceable**: a tool
can catch the *symptoms* of untestable code, never the intent. So the strategy is
two-pronged — **make the testable path the path of least resistance, then
mechanically catch the worst regressions.**

**Testability is an OUTPUT of principles we already adopted** — enforce the
*causes*, not the slogan:
- **P2 (inject effects)** → code becomes input→output → testable without mocks.
- **P3 (no ambient state)** → nothing hidden to stub → testable in isolation.
- **P1 (feature-as-a-library)** → small importable surface → testable standalone.

**Evidence in today's code (the disease we enforce against):**
`packages/api/tests/agent-manager.test.ts` is **2,142 lines** with a large
`vi.mock("@dispatch/core")` block — which exists *solely because* `agent-manager.ts`
reaches for its dependencies instead of receiving them. That is not a testing
failure; it's a P2/P3 failure that *manifested* in the tests. **Mock count is a
proxy metric for design quality** — that's the lever. (Today: ~14 test files use
`vi.mock`; the kernel + each pure-core must reach **zero internal mocks**.)

**The enforcement ladder (cheapest/strongest first):**

- **Tier 1 — Structural (free, mechanical, highest leverage).** The package
  boundaries we're already building *are* testability enforcement. A feature's
  decision logic lives in a package with **zero effectful imports** (no
  `bun:sqlite`, `node:fs`, `node:child_process`) → it is *structurally
  impossible* to write untestable effectful code there; the imports don't exist.
  Proven by today's deliberately DB-free `chunks/transform.ts`. **Enforce via a
  dependency-direction lint** (Biome `noRestrictedImports` forbidding effect
  modules in pure files). The untestable version *doesn't typecheck* — this is
  the real answer to "how do we enforce it."
- **Tier 2 — The no-mock smell test (the proxy metric).** Stated, reviewable rule:
  *a unit test that needs to mock OUR OWN modules is a design bug, not a test to
  write.* Allowed: mocking the **outermost edge** (real network, real clock).
  Banned: mocking `@dispatch/*` internals. Mechanical proxy: a CI grep hard-fails
  if a **kernel/core** test introduces an internal mock; the global count must
  trend toward zero.
- **Tier 3 — Coverage as a FLOOR, not a target (with a caveat).** No coverage
  tooling exists today — add `@vitest/coverage-v8`. But (P4): coverage is a bad
  *target* (gameable — 100% of mock-heavy untestable code proves nothing) and a
  useful *floor* **only on pure-core/kernel packages**, where high coverage is
  cheap *because* the code is pure. **No global coverage gate** — it would
  incentivize mock-heavy shell tests, the exact thing we're fighting.
- **Tier 4 — The harness layer (P5/P6 — teach the agents).** Encode the rule so
  future agents inherit it: a `rules/` safety reflex (below) + a **testable-by-
  default extension scaffold** in `sdk/` shipping the split pre-made: `logic.ts`
  (pure, no deps) + `adapter.ts` (effects) + `logic.test.ts` (mock-free). When
  the *template* is testable, the default output is testable.

**THE KEY CAVEAT — asymmetric enforcement (strict core, lenient shell).** This is
itself an application of the AI-harness thesis (P5/P6): **scoped rules beat
general rules** — models already know "write testable code"; what they need is
*"this kind of code, in this layer, gets tested this way."*
- **Pure core / kernel:** strict — zero internal mocks, dependency-direction lint,
  coverage floor. High coverage is *cheap* here, so demand it.
- **Imperative shell (orchestrator, transport, real SQLite adapter):** lenient —
  it will *never* hit high pure-unit coverage, and **forcing it to is the
  anti-pattern** (you'd do it by mocking everything, recreating today's mess).
  The shell gets a *thin layer of integration tests* against real / in-memory
  backends. A blanket rule would backfire — enforcement is asymmetric **by
  design**.

**`rules/` safety reflexes to ship (Tier 4, scoped per the asymmetry):**
- *Pure-core/kernel rule:* "Writing a unit test that mocks an internal module?
  The code is wrong, not the test. Move the decision logic to a pure function and
  inject the effect."
- *Pure-core/kernel rule:* "This package must have zero effectful imports
  (`node:fs`, `bun:sqlite`, `node:child_process`, network). Need an effect?
  It belongs in the adapter/shell, injected."
- *Shell rule:* "Don't chase pure-unit coverage here. Write a few integration
  tests against a real or in-memory backend; do NOT mock sibling extensions."
- *General (all):* "Mocking the outermost edge (real network/clock) is fine;
  mocking `@dispatch/*` is a smell — fix the boundary."

**The enforced standard (commit to this):**
1. Every extension has a **pure core with zero effect-imports**, lint-enforced
   (Tier 1) — *the load-bearing one.*
2. **No internal mocks in kernel/core tests** — CI grep; proxy metric → zero (T2).
3. **Coverage floor on pure packages only**, never global (Tier 3).
4. **Scoped `rules/` reflexes + a testable-by-default scaffold** (Tier 4).

**Tooling actions (when we start):** add `@vitest/coverage-v8`; add the
dependency-direction lint (Biome `noRestrictedImports`) scoped to pure packages;
add the CI internal-mock grep for kernel/core; ship the `sdk/` scaffold.

### 3.7 Trust & isolation model (fault containment, not adversary sandboxing)

**Threat model first (P4 — defend a real threat, not an imported one).** Dispatch
is **personal, self-hosted, single-operator** today. So:
- **Malicious extension** (data theft, host attack) — **NOT the current threat.**
  You run the host and choose the extensions; an installed extension is already
  as trusted as code you write. The "untrusted plugin marketplace" justification
  for sandboxing does not apply *yet* (revisit if Dispatch goes multi-tenant or
  ships a public registry).
- **Buggy extension** (infinite loop, unhandled rejection, leak, bad migration)
  taking down every other tab/agent — **REAL and present**, especially since we
  want external/custom extensions. This directly threatens the §3.4 "never leave
  the system broken" guarantee.

**So we defend against FAULTS, not ADVERSARIES** — until the project's nature
changes. That distinction collapses the decision.

**Options considered:**
- **A — In-process, trusted (no isolation):** simplest/fastest, rich live-object
  API. But one throw / `process.exit` / leak hits everyone; capabilities are only
  advisory. *Too little — contradicts §3.4.*
- **C — Hard isolation (worker/subprocess/VM per extension):** real fault *and*
  adversary isolation, enforceable capabilities. But **forces the entire Host API
  to be serializable** — no live `provider` handed to `runTurn`, no closure
  handlers, no streaming `ctx.onOutput` without marshalling — fighting *every*
  contract we designed, at real per-call IPC cost. *Too much, too early; defends
  a threat we don't have, and deforms the contracts (the P4 anti-pattern).*
- **B — Soft isolation (in-process, defensively wrapped):** keep the rich
  in-process API, but the host wraps every extension boundary. **CHOSEN.**

**DECISION: adopt B now; design contracts so C remains *possible* later without a
rewrite.** Concretely:
- **Host API stays rich/in-process** — live handlers, streams, objects. All prior
  design holds unchanged.
- **Every extension boundary is defensively wrapped:** handler try/catch (already
  §3.5), **mandatory timeouts on awaited filters** (§3.5 makes filters in-band, so
  a runaway filter must be time-bounded), and **per-extension fault tracking →
  auto-disable a repeatedly-faulting extension** (contains the fault instead of
  letting it recur; ties to §3.4).
- **Tier-aware auto-disable (mirrors the §3.6 asymmetry — strict core, graceful
  edge):** `standard`/`external` extensions *may* be auto-disabled on repeated
  faults; **`core`/`kernel` faults are fatal-and-surfaced, never silently
  degraded** — you want to know storage/transport is broken, not limp on. (Tools
  also get a deterministic residual result per §3.4 R2, so a tool fault never
  orphans a turn.)
- **Capabilities are declared + gate-enforced at the Host-API surface**
  (advisory-but-checked), NOT OS-sandboxed. Honest scope: this catches accidental
  overreach and documents intent; it does not stop determined native code.
- **Cheap future-proofing for optional C later:** keep contract payloads
  **structured and in-principle serializable** (the typed hook/service handles of
  §5.4 already push this way) — don't pass arbitrary live object *graphs* between
  extensions via services. Then moving one untrusted extension into a worker is a
  localized change, not an architecture rewrite.
- **Manifest `trust` field** (`bundled` | `local` | `external`) recorded now even
  though all three behave identically under B — so the *policy hook* exists when
  we later want to treat `external` differently (e.g. worker isolation) without
  inventing the concept then.

**Harness rules this decision generates (scoped per §5.1 layered knowledge; write
into the agent files when those agents are built — NOT now, per §7.4):**
- *All extension-author agents (shared knowledge):* "Your hook/filter handlers
  must never throw uncaught — the host wraps them, but a throw burns your fault
  budget and can auto-disable your extension." / "Filters are awaited and
  time-bounded — no unbounded work in a filter." / "Assume your extension can be
  disabled/reloaded independently; don't rely on ambient process state surviving
  (§3.4)."
- *Service/contract-defining agents only:* "Keep service/contract payloads
  structured and serializable-friendly — no passing live object graphs across the
  extension boundary (preserves the option to isolate later)."
- *Kernel/core agents only (strict):* "Core/kernel faults are fatal-and-surfaced,
  NOT auto-disabled — never write graceful-degradation code that hides a
  storage/transport failure."
- *Tooling-enforced → deliberately NOT in agent files (P6):* the typed-handle
  rule (§5.4) is a compile error, and capability over-declaration is caught at
  manifest load — neither is written down as prose.

---

## 4. Cross-cutting decisions to lock down (when we start)

- **Contract versioning:** convention-only & dormant in `0.x` (§2.9). Each package
  self-versions; semver *meaning* is changelog hygiene + the §5.3 fan-out signal.
  Internal safety = the type system; the compat gate / `.d.ts`-diff are deferred
  until external extensions exist.
- **Trust & isolation:** **soft isolation (B)** — rich in-process Host API +
  defensively-wrapped extension boundaries (handler try/catch, filter timeouts,
  tier-aware auto-disable). Defends FAULTS not adversaries; contracts kept
  serializable-friendly so hard isolation (C) stays possible later (§3.7).
- **System prompt / persona:** becomes a context-filter contribution, not a
  hard-coded string — so the assistant's "feel" is swappable.
- **Migrations ownership:** each extension owns its tables; the kernel only runs
  the migration runner. Defines a clean uninstall story.
- **Deterministic tool-set per turn:** reproducible from `(agent profile +
  capabilities + active extensions)` — this is P3 made concrete and kills
  wishlist bugs #16/#17.
- **Tool-dispatch policy:** togglable per §3.3; default value is an open question
  (see §8).
- **Durability / crash recovery:** incremental append + pure `reconcile()` on load
  + derived status (§3.4). Design rule: no persisted state a crash can leave may
  be unrepairable — recovery is deterministic and invisible to the user.
- **Hooks:** decentralized catalog — kernel owns the mechanism, each extension
  declares the hooks it emits via typed descriptors (§3.5). Events are
  error-isolated; filters are in-band; single-responder request/response is a
  service, not a hook.
- **Testability enforcement:** asymmetric — strict on pure core (zero
  effect-imports lint, no internal mocks, coverage floor), lenient on the shell
  (thin integration tests) (§3.6). Mock-of-internals count is the proxy metric.
- **Agent workflow:** one owner-agent per extension/kernel; agents see only
  others' contracts, never implementation; contract changes fan out mechanically
  via `lsp references`; non-static cross-extension coupling is forbidden;
  glossary terms are human-gated (§5).

---

## 5. Repo & agent workflow conventions (one agent per unit)

The repo's **agent-team structure is isomorphic to its module structure**: agents
communicate through exactly the same contracts the code communicates through. This
is Conway's Law made intentional, and it yields a diagnostic property:

> **Friction between agents is a signal of bad architecture.** Constant
> agent-to-agent messaging ⇒ the contract boundary is wrong. An agent needing to
> read another's implementation ⇒ that contract is underspecified. The workflow
> *surfaces* design smells instead of hiding them.

It is not a bolt-on — every row below already exists in this plan:

| This model needs… | …already provided by |
|---|---|
| Contracts as the only cross-agent surface | ABI (kernel) + two-sided per-extension contracts (§2.3) |
| One agent per unit | P1 feature-as-a-library — one library, one owner |
| Per-agent scoped knowledge | **P7 extension-scoped harness** — an extension's AGENTS.md/rules/glossary *is* its owner-agent's knowledge |
| Layered knowledge (group → file) | P5 tiered-cache layering (§7.1) |
| Persistent, messageable agents | Dispatch's own tabs + `send_to_tab` + `summon`/`retrieve` |
| Bounded cross-agent chatter | the existing `MAX_AGENT_AUTO_WAKES` budget |
| Orchestrator confirms without reading code | **§3.6 testability** — tests-at-boundaries are the trust mechanism |

The last row is the deepest synthesis: **§3.6 is the orchestrator's verification
protocol.** It can't read code, so it confirms "everything works" from
*contracts + test results + build/diagnostics output* — which only works because
we made the boundaries testable. The keystone equivalence: **P7 harness docs ARE
the agents' scoped knowledge** — the same artifact, two views; you don't design
knowledge-scoping separately.

### 5.1 The ownership model
- **One owner-agent per unit** (each extension, and the kernel). Its file(s) are
  edited by no one else → single-writer, so a (future) sleeping agent wakes
  knowing its own code is current.
- **Knowledge is scoped & layered** (P5/P7): shared group knowledge (e.g. all
  "frontend" agents) → per-extension knowledge → per-file specifics. An owner
  loads only its layer, so it is a narrow-domain expert with lean context.
- **Visibility rule:** an agent sees **only what other extensions
  expose/require** (their contracts) — never their implementation. Implementation
  is **not provided by default** (P6/§3.6 caveat #3); *needing* it is a signal
  the contract is incomplete — fix the contract (or ask the owner), don't grant
  code access. Corollary: **a contract documents behavior & guarantees a consumer
  can rely on, not just types** (P6 applied to contracts).
- **Phase note (P4):** start by **summoning fresh agents per task** — files
  aren't complex enough to justify warm/persistent agents yet. Persistent
  *waking* agents (and the wake-time "contract-delta since last active" sync they
  require) are deferred to **after the rewrite**.

### 5.2 The workflow (build a feature)
1. User asks the **orchestrator** for feature X. (Orchestrator sees all
   *contracts*, no implementation.)
2. **Overlap check first (anti-webhook-reimplementation, §7):** orchestrator
   consults the GLOSSARY + feature-docs to see whether the capability already
   exists under a canonical term.
3. **Boundary decision is the USER's, never silent (resolves §3.6 #5):** if X
   maps to a new capability, the orchestrator **surfaces "new extension vs.
   extend an existing one?" to the user** and waits — it never decides
   granularity itself (this is the exact failure the article warns about; the
   glossary/feature-docs are the defense, the user is the authority).
4. Orchestrator **summons the owner-agent(s)** to do the work and **messages any
   extensions needing changes** (via their owner-agents).
5. Owners report back; orchestrator confirms via contracts + tests + build.
6. Clarification questions agent↔agent are *allowed but rare* — everything an
   agent needs (contracts) is already exposed; a needed question usually means a
   contract gap.

### 5.3 Contract changes — mechanical blast radius (resolves §3.6 #2)
A contract change is the one event that legitimately fans out. It is handled
**mechanically, not by guessing**, via the existing `lsp` tool:
1. The contract's owner edits it, then runs **`lsp references`** on the changed
   symbol(s) → the complete set of consuming files.
2. The owner **reports that file list up to the orchestrator** (it can't see
   other extensions itself); the **orchestrator dispatches** the affected
   owner-agents to update to the new contract.
- **Ownership:** kernel-intrinsic ABI → kernel agent (most conservative, changes
  rarely). Per-extension contracts → that extension's agent, **co-located in its
  package** (not a central dir — see §2.5).
- **Prerequisite:** a **TypeScript language server** wired into `dispatch.toml`
  (today's LSP config only has the Luau example).

### 5.4 Static-reference rule — non-static cross-extension coupling is forbidden
For §5.3 to be *sound*, `lsp references` must see every coupling. So:

> **Every cross-extension coupling is anchored to an exported typed symbol.**
> Dynamic/string-keyed cross-feature references are forbidden.

- **Enforced by the type system, not a lint:** the Host API *accepts only typed
  handles* — `host.on(HookDescriptor<T>, …)`, `host.getService(ServiceHandle<T>)`
  — so a raw string at a consumer site is a **compile error** (surfaced via `lsp
  diagnostics`). The raw string exists in exactly one place: the owner's
  `defineHook`/`defineService` declaration. `lsp references` on that exported
  symbol therefore returns the true, complete blast radius. This is *why* typed
  descriptors (§3.5) + typed service handles (§2.3) beat string lookups — not
  aesthetics, but making the agent workflow mechanically sound.
- **Scope (P4 — don't overclaim):** this bans cross-extension **code** coupling.
  Two dynamic lookups are *legitimate and stay*, because they are **data flow /
  discovery inside the kernel-host, not feature-to-feature references**:
  (a) the kernel routing a model's tool-call by name (`byName.get(name)`) — the
  name is the LLM's runtime choice, i.e. data; (b) the host loading extensions by
  scanning manifests (traced by the manifest DAG, not symbol refs).
- **The one escape hatch (named, restricted):** generic observability (e.g. a
  logger wanting *every* hook) may use a single `host.onAny(listener)` firehose,
  explicitly marked "observability only, never feature code."

### 5.5 Integration bugs — the temporary multi-knowledge agent
A bug where X and Y each honor the contract yet don't work together belongs to no
single file. Resolution (resolves §3.6 #4):
- The orchestrator dispatches a **temporary multi-knowledge agent** loaded with
  the **scoped knowledge AND read/write access to the 2–3 relevant files** —
  unlike normal agents it *does* see implementation, because fixing integration
  requires it.
- It becomes the **temporary exclusive owner** of those files for its lifetime
  (the orchestrator must not let the normal owners edit them concurrently →
  preserves single-writer).
- **Both trigger paths:** the orchestrator dispatches it proactively, OR a
  file-owner who spots the bug **requests one from the orchestrator** (reuses the
  §3.5 agent→orchestrator message path; no new mechanism).
- It leverages the existing knowledge-scoping so the agent gets *exactly* the
  context to fix the seam and no more.

### 5.6 The glossary is a human-gated checkpoint (strengthens P8)

This is the article's central anti-synonym-drift mechanism: the GLOSSARY's
**"aliases to avoid" column** exists so the agent never reinvents a concept under
a new name (the article's `WebhookEvent` / `WebhookHook` / `HookedWebhook`
problem), and the §5.2 step-2 overlap check is *when* it runs ("mandatory feature
overlap detection before any new feature"). The orchestrator may **never silently
coin a term.** Two cases:

**Case A — concept already exists (synonym-drift defense — the priority).** When a
request *describes* an existing concept — even by behavior, under a different name
— the orchestrator must **recognize the match and steer to the existing canonical
term, creating NO new entry.**
- *Example (the user's):* request = "implement a **web-notifier**: accept a
  request from an HTTP endpoint requiring no password, then log it." The
  orchestrator recognizes this *is* a **webhook** (already in the glossary) and
  responds "that's a `webhook` — I'll use that name," rather than adding
  "web-notifier".
- Recognition is powered by the glossary's aliases + overlap check, and works on
  **behavioral descriptions**, not just name matches.
- **Still suggest-then-confirm (P4):** recognition can misfire (the user may mean
  something subtly different). The orchestrator *proposes* the match ("this looks
  like a `webhook` — shall I call it that?"); the user has final say. It never
  silently collapses a possibly-distinct concept into an existing term. If the
  user confirms it's a new alias for an existing term, add it to that term's
  "aliases to avoid" column (don't make a new entry).

**Case B — genuinely new concept (name it well).** When the concept is actually
new, before adding the entry the orchestrator must:
1. State the new term and its understanding of what it means.
2. **Propose a name, defaulting to the standardized / training-baked term**
   (e.g. "patch" not "Bugfix"; "debounce" not "cooldown-wait"). Rationale (P6): a
   name models already know costs **zero agent-file/glossary space**, so the
   glossary only grows entries for genuinely project-specific concepts — it
   actively fights its own bloat.
3. **Ask the user** to approve or rename. The user is the final authority: if they
   prefer a different name, **always go with the user's choice** (record the
   standard term, if any, under "aliases to avoid"). The "suggest the standard
   name" rule applies only to a *not-yet-decided* term — never to override a name
   the user already set.

This keeps the user the authority on the project's vocabulary and makes synonym
drift impossible at the source — P8 with a mandatory human in the loop, biased
toward (A) reusing existing terms and (B) names the model already knows.

---

## 6. Current-state map (as of this plan)

Dependency direction is one-way: **`frontend → api → core`**. `core` is already
framework-agnostic (no Hono/HTTP) — the cleanest existing seam. *(Note: "core"
here is the **current** package name; under the new model the runtime primitive
is the kernel and "core" becomes the extension tier — see §2.6.)*

```
packages/
│
├── core/   → @dispatch/core — shared domain logic (the "brain"), framework-agnostic
│   │        (exported via src/index.ts barrel)
│   ├── agent/agent.ts        agentic LLM loop (streamText + manual tool-call dispatch,
│   │                         dedup, per-line/spill truncation, user-interrupt injection,
│   │                         reasoning-effort, multimodal user content)
│   ├── llm/
│   │   ├── provider.ts       createProvider() — Anthropic + OpenAI-compatible factories,
│   │   │                     mcp_ tool-name prefix/unprefix
│   │   ├── anthropic-oauth-transform.ts   Claude OAuth request-body transform
│   │   └── debug-logger.ts   DISPATCH_DEBUG_LLM stream/loop/fetch logging
│   ├── tools/                tool implementations (each createXTool → ToolDefinition)
│   │   ├── registry.ts       createToolRegistry; Zod→JSONSchema + Anthropic normalize
│   │   ├── read-file.ts, read-file-slice.ts, write-file.ts, list-files.ts
│   │   ├── run-shell.ts (+ BackgroundShellStore), shell-analyze.ts, bash-arity.ts
│   │   ├── search-code.ts, web-search.ts, youtube-transcribe.ts (+ BackgroundTranscriptStore)
│   │   ├── summon.ts, retrieve.ts          sub-agent spawn / result collection
│   │   ├── send-to-tab.ts, read-tab.ts     tab-to-tab comms
│   │   ├── task-list.ts (todo), key-usage.ts, lsp.ts
│   │   ├── truncate.ts       universal tool-output truncator + /tmp spill
│   │   └── path-utils.ts     canonicalize / workdir-containment guard
│   ├── db/                   SQLite (bun:sqlite, XDG data dir)
│   │   ├── index.ts          singleton DB + table DDL/migrations (credentials, api_keys,
│   │   │                     usage_cache, wake_schedule, tabs, chunks, settings)
│   │   ├── tabs.ts           tabs CRUD, short-prefix resolution, positions/status/title
│   │   ├── chunks.ts         append-only chunk log: explode/group rows ↔ messages, usage
│   │   └── settings.ts       key/value settings
│   ├── chunks/               pure conversation-model transforms (no DB import — shared w/ frontend)
│   │   ├── append.ts         appendEventToChunks / applySystemEvent (stream → Chunk[])
│   │   └── transform.ts      explode/group between Chunk[] and flat ChunkRow log
│   ├── compaction/index.ts   head/tail selection, summary prompt + transcript render
│   ├── config/               dispatch.toml (global ~/.config + project merge)
│   │   ├── loader.ts, schema.ts, watcher.ts, index.ts   load/validate/hot-reload; configToRuleset
│   ├── credentials/          claude.ts (OAuth identity/billing), api-keys.ts, opencode.ts,
│   │                         copilot.ts, google.ts, anthropic-betas.ts, store.ts, index.ts
│   ├── models/               registry.ts (ModelRegistry, key states), catalog.ts,
│   │                         attachments.ts (image/pdf validation + limits), index.ts
│   ├── skills/               parser.ts, loader.ts, index.ts   (skill files → agent injection)
│   ├── agents/               loader.ts, index.ts   (global + .dispatch/agents defs, tool-group expand)
│   ├── permission/           rules engine: evaluate.ts, service.ts, wildcard.ts, index.ts
│   ├── lsp/                  manager.ts, client.ts, server.ts, language.ts, diagnostic.ts, index.ts
│   ├── notifications/        ntfy.sh: dispatcher.ts, ntfy.ts, config.ts, types.ts, index.ts
│   ├── types/index.ts        ALL shared contracts: Chunk/ChatMessage, AgentEvent, AgentConfig,
│   │                         ToolDefinition, ToolExecuteContext, DispatchConfig, ReasoningEffort…
│   └── index.ts              public barrel (entire core API surface)
│
├── api/    → @dispatch/api — backend HTTP + WebSocket server (Hono on Bun)
│   ├── index.ts              Bun.serve (+ EADDRINUSE port-fallback) + /ws WebSocket
│   │                         (statuses snapshot, event fan-out, permission replies)
│   ├── app.ts                Hono app + CORS; /health, /status, /chat (main entry),
│   │                         /chat/cancel, /chat/stop, /chat/warm; mounts routes;
│   │                         constructs agentManager + permissionManager + notificationDispatcher
│   ├── agent-manager.ts      THE orchestrator (~2.4k lines): per-tab turns, message queue,
│   │                         key/model fallback chain, system-prompt assembly (buildSystemPrompt
│   │                         + TOOL_DESCRIPTIONS), per-turn tool assembly (perm/whitelist gated),
│   │                         sub-agent spawning, LSP-on-write hook, auto-wake budget, compaction
│   ├── permission-manager.ts tool-permission prompts/replies over WS
│   ├── wake-scheduler.ts     pure Claude wake-probe scheduling helpers (4 slots/hour, recovery)
│   ├── types.ts              thin re-export of AgentEvent/AgentStatus from core
│   ├── routes/               /config, /tabs, /models (+ startWakeScheduler), /skills,
│   │                         /agents, /notifications  (each uses a setXGetter injection seam)
│   └── tests/                agent-manager, routes, permission-manager, wake-scheduler
│
└── frontend/  → Svelte 5 SPA (Vite); morphable, reworked later
    ├── main.ts, App.svelte, app.css
    └── lib/
        ├── tabs.svelte.ts          central store: sendMessage + WS event handling
        ├── ws.svelte.ts            WebSocket client (auto-reconnect)
        ├── router.svelte.ts, config.ts, types.ts, theme.ts, settings.svelte.ts
        ├── context-window.ts, attachment-tokens.ts, snapshot-sequencer.ts
        ├── cache-warming.svelte.ts, cache-warm-storage.ts, sidebar-storage.ts
        └── components/             ChatInput, ChatPanel, ChatMessage, ToolCallDisplay,
                                    TabBar, ModelSelector, ConfigPanel, AgentBuilder,
                                    SystemPromptPanel, SkillsBrowser, ToolPermissions,
                                    PermissionPrompt, TaskListPanel, KeyUsage, CacheRatePanel,
                                    ContextWindowPanel, SettingsPanel, MarkdownRenderer, … (23 total)
```

### 6.1 Key facts that matter for the rework
- **`agent-manager.ts` is the center of gravity** (~2,453 lines): per-turn tool
  assembly, system-prompt building, provider/key resolution, sub-agents,
  queueing all fused. This is what dissolves into kernel + core orchestrator +
  standard contributions.
- **`types/index.ts` is the de-facto contract layer today** — `ToolDefinition`,
  `AgentConfig`, `AgentEvent`, `DispatchConfig` all live here. Natural seed for a
  real `contracts` package (kernel).
- **Routes already use a `setXGetter` injection pattern** (`setSkillsGetter`,
  `setModelsGetter`, …) — a primitive form of the DI seam the extension host
  would formalize.
- **Per-turn tool assembly is a giant duplicated if/else** in `agent-manager`
  (parent-perms path + child-whitelist path) — prime candidate for a registry
  populated by extensions.
- **Tool execution today is post-stream + sequential** (`agent.ts` ~line 1426) —
  see §3.3 for the eager/concurrent redesign.

---

## 7. The AI Harness (meta-information layer)

From "The AI Harness: why your AI coding agent is only as smart as the repo you
put it in" (Louai Boumediene, Activepieces). Thesis: the model is rarely the
bottleneck — the structured meta-information around the code is. Agent context is
a **tiered cache**: tiny files always loaded, big files on demand.

### 7.1 The layering (governing test: P6 — only the non-inferable)
| Layer | Size / load | Purpose |
|---|---|---|
| Root `AGENTS.md` — "constitution" | ~55 lines, **every session** | Non-obvious architecture rules only |
| Per-package/extension `AGENTS.md` | ~30–55 lines, when working there | Package-specific patterns |
| `rules/` — "safety reflexes" | 3–5 lines each, every session | Crystallized scar tissue (bugs you've reverted) |
| `features/*` — "module encyclopedia" | ~60 lines each, on demand | Entity schemas, data flow, gotchas per module |
| `skills/*` — codified workflows | slash commands, progressive disclosure | Fixed procedures for repeated tasks |
| `GLOSSARY.md` | term table + "aliases to avoid" | Fights synonym drift |

### 7.2 Why it applies strongly to us (evidence, not fashion)
- **The layering maps 1:1 onto minimal-kernel + extensions.** "One ~60-line doc
  per module" *is* "one doc per extension" — the extension boundary is the doc
  boundary. The architecture gives us the harness structure for free.
- **We already have the scar tissue that becomes `rules/`:** Anthropic schema
  normalization in `registry.ts` ("Claude never sees the tool and thinks
  forever"), workdir-containment in `path-utils.ts`, tool-call dedup ("150+
  identical calls"), `[USER INTERRUPT]` stripping, the no-`execute` tool pattern.
  These are postmortems-as-comments — promote them to 3–5 line rules.
- **Real synonym-drift problem** (P8): tab/session/conversation,
  chunk/message/turn/step. A glossary with "aliases to avoid" is warranted.

### 7.3 The special angle for this project (synthesis)
Dispatch is **recursive** — an AI-agent platform that itself *has* skills, agents,
and permissions. Two consequences:
- **The harness is extension-scoped (P7):** each extension carries its own
  constitution snippet, rules, feature doc, glossary terms, and skills, portable
  with the code. Feature-as-a-library applied to documentation.
- **"Tiered context as a cache" is already Dispatch's product behavior**
  (prompt-caching, on-demand skills, compaction). The article describes from the
  outside the thing we build from the inside — a strong signal the layering is
  sound.

### 7.4 What we bound or reject (P4 applied)
- **Volume (40+ docs, 9 skills) and the 5-features/week cadence** — scale
  artifacts of a 12-engineer, 1.6M-LOC monorepo. Our version: write a doc the
  moment we touch an extension that lacks one (doc-first as the plan brief), grow
  organically.
- **Worktrees / parallel sessions / weekly rhythm / MCPs** — that's *workflow*,
  not *architecture*; out of scope for the structure we're designing.
  (Amusingly, Dispatch's parallel tabs are its own take on parallel sessions.)

---

## 8. Open questions / where we start (TBD)

- **Starting point (proposed):** lock the **Contracts** + **Extension Host**,
  then prove the whole stack with one vertical slice — e.g. extract `read_file`
  into a standalone, independently-importable `standard` extension with
  pure-core / injected-shell tests. That single slice validates the architecture
  (P1, the contracts, the host, the tier model) and the engineering constraints
  (P2, P3) before scaling out.
- **Open decisions before we begin:** none remaining — all resolved (see below).
- **Deferred to after the rewrite (P4):**
  - Persistent *waking* agents + their wake-time "contract-delta since last
    active" sync (§5.1) — start with fresh-summoned agents.
  - TypeScript language server wired into `dispatch.toml` is a **prerequisite**
    for §5.3's `lsp references` workflow (today only Luau is configured).
- **Decided so far:**
  - ~~Tool-dispatch default policy~~ — **DECIDED** (§3.3): default
    `{ maxConcurrent: 1, eager: true }`.
  - ~~Who drives the multi-step loop~~ — **DECIDED**: the **kernel** drives it
    (the loop is the kernel's reason to exist); tools stay dumb objects it calls.
  - ~~Conversation-store boundary~~ — **DECIDED** (§2.2, §2.8): the kernel keeps
    only the conversation **model types** + pure transforms; the persistent store
    and SQLite backend are **`core` extensions** (fixes the §2.2/§2.7 I/O
    inconsistency).
  - ~~"Minimum viable turn" target~~ — **DECIDED** (§2.8): `core` targets **(B)**
    a usable multi-turn chat; the storage backend is the single swappable piece
    that drops it to the **(A)** stateless floor (= the in-memory test config).
  - ~~Crash-recovery strategy~~ — **DECIDED** (§3.4): incremental append-only
    persistence (R1), pure `reconcile(rows)` repair on load (R2), derived/boot-
    swept status (R3), resume = load→reconcile→continue (R4). Mid-stream
    resumption (wishlist #1) explicitly deferred.
  - ~~Hook system shape~~ — **DECIDED** (§3.5): decentralized typed-descriptor
    catalog (kernel owns mechanism, owners declare hooks); events vs filters;
    single-responder = service, not hook. Wildcards/pattern-subs deferred.
  - ~~Testability enforcement~~ — **DECIDED** (§3.6): structural (zero
    effect-imports in pure packages, lint-enforced) + no-internal-mocks proxy
    metric + coverage floor on pure packages only + scoped `rules/` reflexes;
    enforcement is **asymmetric** (strict core / lenient shell).
  - ~~Agent workflow / repo conventions~~ — **DECIDED** (§5): one owner-agent per
    unit; contracts are the only cross-agent surface (implementation hidden by
    default; needing it = contract gap); contract changes fan out via `lsp
    references` (orchestrator dispatches); **non-static cross-extension coupling
    forbidden** (typed handles, type-system-enforced, `onAny` escape hatch);
    temporary multi-knowledge agent for integration bugs; **glossary is
    human-gated** (orchestrator must ask before coining a term).
  - ~~Per-extension contract location~~ — **DECIDED** (§2.5, §5): co-located in
    each extension package; only the kernel ABI is centralized in
    `kernel/contracts/`.
  - ~~Boundary granularity (new ext vs extend)~~ — **DECIDED** (§5.2): the
    **user** decides; the orchestrator surfaces it after a glossary/feature-doc
    overlap check, never silently.
  - ~~Trust & isolation model~~ — **DECIDED** (§3.7): **soft isolation (B)** —
    rich in-process API + defensively-wrapped boundaries; defends faults not
    adversaries (single-operator threat model); tier-aware auto-disable (strict
    core / graceful edge); contracts kept serializable-friendly + manifest
    `trust` field so hard isolation (C) stays possible without a rewrite.
  - ~~Contract-versioning policy~~ — **DECIDED** (§2.9): convention-only & dormant
    in `0.x`; each package self-versions; semver meaning (major=break/fan-out,
    minor=additive, patch=internal) as changelog hygiene + §5.3 signal; type
    system is the internal mechanism; compat gate + `.d.ts`-diff deferred until
    external extensions exist.
  - ~~Core-default provider/auth~~ — **DECIDED** (§2.10): **OpenAI-compatible +
    API-key** (`provider-openai-compat` + `auth-apikey`) — leanest auth surface,
    most-testable, and = the **OpenCode Go flash** testbench. Claude/OAuth and the
    Anthropic-format OpenCode models are `standard` extensions.

---

## Appendix — Principle quick-reference
- **P1** Feature-as-a-library (importable, minimal API; don't over-split)
- **P2** Functional core / imperative shell (testability not purity; inject effects)
- **P3** No ambient state (own and pass explicitly; reproducible tool-sets)
- **P4** Don't adopt by reputation (earn each pattern against real evidence)
- **P5** The repo is a harness (meta-info is a first-class, tiered deliverable)
- **P6** Document only the non-inferable (tribal knowledge / scar tissue only)
- **P7** The harness is extension-scoped (docs portable with the code)
- **P8** One canonical vocabulary (glossary + aliases-to-avoid; no synonym drift)
