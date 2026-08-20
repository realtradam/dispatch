# Named Agents — Feature Plan

> **Status:** PLANNING ONLY. No feature code is written. This document lives in
> the backend worktree on branch `feature/named-agents` and is the single source
> of truth for the design until implementation waves begin.
>
> **Scope of this doc:** research the current model-discovery + agent-summoning
> path across BOTH repos, brainstorm product semantics, and produce a concrete
> cross-repo implementation plan. It distinguishes current behavior, proposed
> behavior, backend work, frontend work, migration/compat, tests, and the open
> product questions that need a human decision before any code is written.

---

## 0. The problem (in the user's words)

> "Selecting models for an agent when it is summoning a new agent is too
> difficult. It is too slow (the response takes a long time) and finding the
> right model is too complex (too many options, selecting strange models that I
> didn't desire). So what I am proposing is a feature where we can define
> 'agents' which I select a name, and select a model. Then when the agent asks
> for a list of models, they will simply instantly get the list of the named
> agents they can summon, and use those to summon. This would replace the way we
> list available models now for agents summoning agents."

Two concrete pain points, both confirmed by reading the code:

1. **Too slow** — every `list_agent_models` call fans out to a **live network
   fetch** against every configured provider's upstream `/models` endpoint (see
   §1.2). There is no cache and no persisted shortlist, so discovery latency =
   sum of all provider `/models` round-trips.
2. **Too complex / wrong picks** — the tool returns **every** model from every
   provider (often dozens/hundreds), so the model either picks something
   unsuitable or wastes tokens scanning a huge list.

The proposal: let the user predefine a small, named shortlist (name → model) and
have `list_agent_models` return *that* instead of the raw catalog. Because the
shortlist is persisted config, listing it is **instant** (zero network) and
**small** (only what the user curated).

---

## 1. Current behavior (as found in the code)

### 1.1 The agent-management tool family (`packages/agent-management/`)

The `agent-management` standard extension already exists and contributes seven
AI-callable tools. The two this feature changes:

- **`list_agent_models`** (`src/tools/list_agent_models.ts`) — described to the
  model as "List the models available for summon_agent … Do NOT use run_shell +
  'dispatch models'." Parameters: `query?`, `vision?`, `limit?`. It calls
  `AgentManagementService.listModels`.
- **`summon_agent`** (`src/tools/summon_agent.ts`) — starts a subagent
  conversation. `model` is **required** and documented as "Exact model name
  (`<credential>/<model>`) from `list_agent_models`."

Both tools are thin shells over the typed `AgentManagementService`
(`src/service.ts`), whose handle is `agentManagementHandle`
(`defineService<AgentManagementService>("agent-management/service")`). The
service is wired in `src/extension.ts` by resolving `conversationStoreHandle`,
`credentialStoreHandle`, and lazily `sessionOrchestratorHandle` from the host.

### 1.2 Why it is slow — the catalog fan-out

`AgentManagementService.listModels` (`service.ts` ~L343) does:

1. `await deps.credentialStore.listCatalog()` — which, in
   `packages/credential-store/src/registry.ts` (`listCatalogDetailedInternal`),
   **loops over every credential** and calls `provider.listModels()` — a **live
   network GET** to each upstream (`/models` or `/v1/models/info`; see
   `packages/openai-stream/src/listModels.ts`).
2. Then, for **each** returned model name, calls
   `credentialStore.getModelInfo(name)` — which **re-invokes** the provider's
   `listModels()` again (per model!) to look up `ModelInfo`.

So a single `list_agent_models` call triggers `(N credentials) + (M models)`
upstream `/models` round-trips. That is the latency the user feels. There is no
caching layer between the tool and the provider endpoints.

`summon_agent` **also** validates the model against the full catalog
(`service.ts` ~L411: `catalog = await deps.credentialStore.listCatalog()` then
`catalog.includes(input.model)`), so **every summon pays the same network
fan-out** just to validate the model name. An invalid model yields
`unknown-model`.

### 1.3 The credential-store contract (`packages/credential-store/`)

`CredentialStore` (`src/registry.ts`) exposes:
- `resolve(modelName)` → `{ providerId, model }` (split on first `/`).
- `listCatalog()` → `readonly string[]` (network-backed, see above).
- `listCatalogDetailed()` → `readonly CatalogEntry[]` (name + `ModelInfo`).
- `getModelInfo(modelName)` → `ModelInfo | undefined`.

Credentials are **assembled in the composition root** (`packages/host-bin/src/main.ts`
~L213–L291) from environment variables (`OPENCODE_API_KEY_<n>`, `UMANS_API_KEY`,
etc.) and external-provider detection, then passed into
`createCredentialStoreExtension({ credentials })`. The credential list is
**hardcoded from env at boot**, not user-editable at runtime. The glossary notes
credentials are "Defined in config (a TOML, later); the MVP hardcodes one."

### 1.4 The HTTP model catalog (`GET /models`)

`transport-contract` (`src/index.ts` ~L143) defines `ModelsResponse`
(`{ models: readonly string[]; modelInfo?: Record<string, ModelMetadata> }`).
`transport-http` (`src/app.ts` ~L341) implements `GET /models` by calling
`credentialStore.listCatalogDetailed()`. This is the **user-facing** catalog
(the frontend's own model picker), distinct from the agent-facing
`list_agent_models` tool — but both currently read the same network-backed
catalog.

### 1.5 Persistence model (`packages/conversation-store/` + `storage-sqlite`)

`ConversationStore` (`src/store.ts`) is backed by a namespaced key-value
`StorageNamespace` obtained via `host.storage("conversation-store")`
(`src/extension.ts`). Keys follow a `conv:<id>:<field>` scheme
(`src/keys.ts`): `conv:<id>:model`, `conv:<id>:meta`, `conv:<id>:parent`,
`conv:<id>:toolpolicy`, etc., plus a `conv-index` index key and
`workspace:<id>` keys. **Global** settings use a bare key, e.g.
`VISION_SETTINGS_KEY = "vision-settings"`.

The storage backend is `storage-sqlite` (`src/extension.ts`) — a kernel
bootstrap dep injected via `HostDeps.storageFactory`; it is a no-op extension
whose `StorageNamespace` is the real KV store. Settings CRUD follows the
`GET/PUT /settings/vision` pattern (`transport-http/src/app.ts` ~L1883): GET
reads the store, PUT validates + writes + returns the new state.

### 1.6 Programmatic consumer — `vision-handoff`

`vision-handoff` resolves a vision-capable model **from the raw catalog**
(`credentialStore.listCatalog` / `resolve`) and summons it via
`agentManagementHandle.summon` with `toolAccess: "none"` and `images`. It is a
**programmatic** caller, not an AI tool call. **It must keep access to the raw
catalog** regardless of what `list_agent_models` returns to models.

### 1.7 Frontend model selection (`../frontend`)

The FE fetches `GET /models` on boot (`src/app/store.svelte.ts` ~L1233) and
feeds `models` + `modelInfo` to `ModelSelector.svelte` — a two-step picker
(credential key → model suffix) built on pure helpers in
`src/features/chat/model-select.ts`. The FE has **no** preset/profile/named-
agent concept and **no** subagent-lineage UI (no `parentConversationId`
handling). Settings UI lives in `src/features/settings/` (currently only the
chat-limit field). The FE consumes backend contracts as pinned `file:` deps and
mirrors them into `.dispatch/*.reference.md`; cross-repo contract changes are
**couriered via the user** (`backend-handoff.md`, per FE `AGENTS.md` §"Backend
seam").

---

## 2. Proposed behavior

### 2.1 The core idea — a curated, persisted, named shortlist

Introduce a user-defined registry of **named agents**: each entry binds a
human-friendly **name** to a **model name** (`<credential>/<model>`) and,
optionally, summon defaults. The agent-facing `list_agent_models` tool returns
**this shortlist** (instant, persisted, small) instead of the raw network-
backed catalog. `summon_agent` is summoned **by named-agent name**, validating
against the persisted registry (instant) rather than the live catalog.

### 2.2 What changes for the model (agent summoning an agent)

- **`list_agent_models`** returns the **named agents** the caller can summon:
  `{ name, model, …defaults }`. No network calls; reads persisted config. The
  `query`/`vision`/`limit` filters still apply over the shortlist. `vision`
  can still be resolved (from cached `ModelInfo` captured at definition time,
  or by deferring to the catalog on a best-effort, non-blocking basis — see
  open question Q5).
- **`summon_agent`** accepts a **named-agent name** (the `model` field is
  repurposed, or a new `agent` field is added — see Q2). The service resolves
  the name → underlying model name from the persisted registry, then starts
  the turn. Validation is against the persisted registry (instant), not the
  live catalog. Defaults recorded on the named agent (e.g. `reasoningEffort`,
  `toolAccess`) apply unless the call overrides them.

### 2.3 What does NOT change

- The **`credential-store` raw catalog** (`listCatalog`/`listCatalogDetailed`/
  `resolve`/`getModelInfo`) stays exactly as-is. It remains the source of truth
  for: the **user's own** model picker (`GET /models`), `vision-handoff`'s
  vision-model resolution, auto-compaction's `contextWindow` lookup, and the
  `/chat` `model` field. The named-agents feature is **only** about the
  agent→agent summoning surface.
- The other five agent-management tools (`list_agents`, `read_agent`,
  `send_agent_message`, `cancel_agent_message`, `open_agent`) are unchanged —
  they operate on conversations, not on model selection.
- The kernel stays provider-agnostic, I/O-free, and unaware of named agents.

### 2.4 Defining named agents is a USER action, not an agent action

Creating/editing/deleting named agents is admin/user configuration (like
credentials and vision settings), **not** an AI-callable tool. The
agent-management tool family is for *summoning and managing conversations*;
defining the shortlist is a separate, user-owned config surface. (See Q7 for
whether a CLI command is also wanted.)

---

## 3. Product semantics & unresolved decisions (brainstorm)

These are the decisions that shape the design. Each is flagged for human
confirmation; where I have a recommendation, it is marked **(recommendation)**.

### Q1 — Canonical term & glossary entry  *(needs user confirmation)*

"Named agent" risks colliding with the existing vocabulary where **agent** /
**subagent** = a running *conversation*, and **agent management** = the feature
that summons/controls them. A "named agent" here is **not** a running agent —
it is a *reusable, named model preset for summoning*. Existing analogues:
**credential** (name → provider) and **model name** (`<credential>/<model>`).

Candidate canonical terms:
- **named agent** (the user's wording) — intuitive but blurs "agent = conversation."
- **agent preset** / **summon preset** — precise; describes what it is (a preset).
- **agent profile** — common in tooling; slightly heavier connotation.

**(recommendation):** adopt **named agent** as the user-facing term (honoring the
user's language) but add a glossary entry that sharply distinguishes it from
**subagent**: a *named agent* is a persisted **summon preset** (name → model +
defaults) that agents summon *by*; a *subagent* is the resulting *conversation*.
Confirm before adding to `GLOSSARY.md` (both repos).

### Q2 — Does `summon_agent` take a named-agent name, a model name, or both?  *(needs user decision)*

Three options:
- **(A) Replace** — `summon_agent` takes a named-agent **name** only; the raw
  `model` field is removed/renamed. Cleanest API, but breaks programmatic
  callers (`vision-handoff`) that summon by raw model name.
- **(B) Augment** — add an `agent` (named-agent name) field; `model` stays as
  the raw-model escape hatch. `agent` wins if present; else fall back to
  `model` (validated against the catalog as today). Backward compatible.
- **(recommendation): (B) Augment.** It keeps `vision-handoff` and any future
  programmatic caller working unchanged, lets the AI use the friendly shortlist
  by default, and retains the raw-model path as an explicit escape hatch. The
  tool description steers the model toward `agent` (the curated list) and
  documents `model` as the advanced/raw override.

### Q3 — Empty registry: fallback to catalog, or empty + guidance?  *(needs user decision)*

If the user has defined **zero** named agents, what does `list_agent_models`
return?
- **(A) Fall back** to the full catalog (today's behavior). No regression, but
  re-introduces the slowness/complexity until the user curates a list.
- **(B) Return empty** with a message like "No named agents defined; ask the
  user to define some (or use `model` with a raw `<credential>/<model>` name)."
- **(recommendation): (B) with a raw-model escape hatch.** Returning empty
  forces curation (the whole point) and avoids the silent slow path; the
  `model` field (Q2-B) keeps summoning functional for power users. A one-time
  "seed from catalog" helper (Q8) eases onboarding.

### Q4 — Persistence: SQLite KV vs config file?  *(needs user decision)*

- **(A) SQLite `StorageNamespace`** (a new `host.storage("named-agents")`
  namespace with a `named-agents` index key + `named-agent:<name>` entries).
  Matches the vision-settings precedent; CRUD via HTTP; instant reads.
- **(B) Config file** (TOML/JSON), mirroring where credentials are *headed*
  ("a TOML, later"). No network, human-editable, but needs a file watcher /
  reload and a parse layer.
- **(recommendation): (A) SQLite KV now**, with the type shape designed to map
  cleanly onto a future TOML. It reuses the proven `StorageNamespace` + HTTP
  CRUD pattern, needs no new file-watching edge, and the persisted shape can be
  serialized to TOML later without an API change. (If the user prefers
  file-based config for parity with the credentials roadmap, that is a valid
  alternative — flag it.)

### Q5 — Staleness: what if a named agent's underlying model vanishes?  *(needs user decision)*

A named agent binds to a `<credential>/<model>`. If that credential is removed
or the model is deprecated upstream, the binding goes stale (like the FE
ModelSelector's "unavailable" state). Options:
- **(A) Capture `ModelInfo` (contextWindow, vision) at definition time** and
  keep serving the named agent from the persisted snapshot; flag staleness only
  on a best-effort, non-blocking catalog refresh. Listing stays instant.
- **(B) Validate against the live catalog at summon time** — re-introduces the
  network latency the feature is meant to kill.
- **(recommendation): (A).** The snapshot makes listing/summon instant and
  decoupled from upstream churn. Staleness is surfaced (a `stale`/`available`
  flag on the entry) via an **async, cached, best-effort** catalog check that
  never blocks `list_agent_models` — e.g. a periodic background refresh or a
  lazy cache with TTL, populated off the existing `listCatalogDetailed`. The
  summon itself trusts the persisted binding (instant) and only fails at the
  provider stream if the model is truly gone (a clear provider error, not a
  silent wrong model).

### Q6 — Does this also affect the user's OWN model picker (FE)?  *(needs user decision)*

The user's proposal is scoped to *agents summoning agents*. But named agents
could double as a curated picker for the user's own conversations too.
- **(recommendation): MVP = agent-summoning surface only.** Leave `GET /models`
  and the FE ModelSelector untouched. Exposing named agents in the user's own
  picker is a natural follow-up (Q9) but expands scope and risks confusing
  "pick a model for me" with "pick a preset for a subagent." Decide later.

### Q7 — CRUD surface: HTTP + FE only, or also a CLI command?  *(needs user decision)*

- **(recommendation): HTTP CRUD (`GET/POST/PUT/DELETE` on named agents) + FE
  settings UI** as the primary surface. Optionally add a `dispatch agents`
  CLI subcommand (add/list/remove) for parity with `dispatch models` and
  scripted setup — but only if the user wants CLI manageability. Flag as a
  scope add, not MVP-blocker.

### Q8 — Onboarding: seed from catalog?  *(needs user decision)*

A "seed" action that snapshots the current catalog into a few starter named
agents (or imports selected models) would smooth the empty-registry cold start
(Q3). **(recommendation):** offer it as a FE/HTTP convenience, not a required
step.

### Q9 — Future hooks (explicitly out of MVP)

- Named agents carrying fuller summon defaults (`systemPrompt`, `title`,
  `cwd`, `computerId`, `workspaceId`, a tool allow/deny list). MVP = name +
  model + (optionally) `reasoningEffort`/`toolAccess`; richer defaults are a
  follow-up once a concrete consumer justifies them (P4 — earn each mechanism).
- Surfacing named agents in the user's own model picker (Q6).
- Per-workspace named-agent sets (today: global, like vision settings).
- Subagent lineage/parent UI in the FE (no such UI exists today).

---

## 4. Backend implementation plan

> Architecture rules honored: kernel stays pure (no I/O, no feature names);
> cross-extension coupling via **typed `defineService` handles** (no string-
> keyed lookups); effects injected; pure decision logic separated from the
> imperative shell; contracts are the only cross-unit surface. One owner per
> unit; the orchestrator authors shared contracts first, then summons owners in
> dependency-topological waves (`ORCHESTRATOR.md` §1–§2a).

### 4.1 Unit & boundary decision  *(needs user confirmation per ORCHESTRATOR §1.3)*

**(recommendation):** a **new `named-agents` standard extension**
(`packages/named-agents/`) that owns the registry + persistence + service, plus
**edits to the existing `agent-management` extension** (the two tools/service
methods that switch to consuming it). Rationale: the registry is a distinct
capability from conversation management; co-locating it would bloat
`agent-management` and couple two concerns. `named-agents` contributes a
`NamedAgentRegistry` **service** (typed handle) that `agent-management`
resolves lazily — exactly the existing `credentialStoreHandle` /
`sessionOrchestratorHandle` resolution pattern. When `named-agents` is absent,
`agent-management` degrades gracefully (see §6).

**Alternative (if the user prefers a smaller boundary):** add the registry
*inside* `agent-management` (one owner, no new package). Less isolation, fewer
contracts, but a smaller diff. Flag for the user.

### 4.2 New contract surface (kernel contracts — orchestrator-authored)

`named-agents` owns its own typed types (in its package, like
`agent-management/src/types.ts`), so **no kernel contract change is strictly
required** — the kernel must not name the feature. The only cross-unit surface
is the new `NamedAgentRegistry` **service handle** declared inside
`packages/named-agents/src/types.ts`:

```ts
// packages/named-agents/src/types.ts (sketch — NOT implemented here)
export interface NamedAgent {
  readonly name: string;                 // unique, user-chosen
  readonly model: string;                // "<credential>/<model>"
  readonly reasoningEffort?: ReasoningEffort;
  readonly toolAccess?: "all" | "none";
  // snapshot captured at definition time (Q5-A):
  readonly contextWindow?: number;
  readonly vision?: boolean;
  readonly displayName?: string;         // optional human label for the model
}
export interface NamedAgentRegistry {
  list(): Promise<readonly NamedAgent[]>;
  get(name: string): Promise<NamedAgent | undefined>;
  create(input: NewNamedAgent): Promise<Result<NamedAgent>>;
  update(name: string, input: Partial<NewNamedAgent>): Promise<Result<NamedAgent>>;
  remove(name: string): Promise<Result<void>>;
}
export const namedAgentRegistryHandle: ServiceHandle<NamedAgentRegistry> =
  defineService<NamedAgentRegistry>("named-agents/registry");
```

`agent-management` imports `namedAgentRegistryHandle` (typed symbol →
`lsp references` finds the consumer set) and resolves it **lazily** at call
time, mirroring its existing `resolveOrchestrator` pattern.

### 4.3 Backend work by unit (dependency-topological waves)

**Wave 0 — orchestrator-authored seam.** Author the `NamedAgent` /
`NamedAgentRegistry` types + `namedAgentRegistryHandle` inside the new
`packages/named-agents/src/types.ts` (the contract), so the producer
(`named-agents`) and consumer (`agent-management`) can be built against the
fixed type in the same wave.

**Wave 1 — `named-agents` extension (producer).**
- `src/pure.ts` — pure logic: name validation (uniqueness, charset/length
  bounds, no `/` collision with model-name syntax), default resolution,
  staleness-snapshot merging, result/error formatting, filtering (query/vision/
  limit over the shortlist). Zero I/O; unit-tested directly (no internal mocks).
- `src/store.ts` — persistence over `host.storage("named-agents")`: a
  `named-agents` index key (JSON array of names) + `named-agent:<name>` entry
  keys (JSON `NamedAgent`). CRUD with atomic index updates. Follows the
  conversation-store KV idioms (keys.ts, parse/serialize helpers).
- `src/service.ts` — the imperative shell: inject the `StorageNamespace` +
  `credentialStoreHandle` (for snapshotting `ModelInfo` at create/update time —
  the one place a network call is acceptable: on a user CRUD action, not on
  listing) + `logger`. Implements `NamedAgentRegistry`. Pure decisions live in
  `pure.ts`.
- `src/extension.ts` — manifest (`id: "named-agents"`, `contributes.services:
  ["named-agents/registry"]`, `dependsOn: ["credential-store"]`), `activate`
  wires `host.storage` + the credential-store service and calls
  `host.provideService(namedAgentRegistryHandle, service)`.
- Tests: `pure.test.ts` (strict, no mocks) + a thin store integration test
  against an in-memory `StorageNamespace` fake (the outermost edge).

**Wave 1 (parallel) — `agent-management` edits (consumer).**
- `src/service.ts` `listModels`: resolve `namedAgentRegistryHandle` lazily; if
  present, **read the persisted shortlist** (instant) and build `ModelEntry[]`
  from it (using the snapshot's `vision`/`contextWindow`/`displayName`). Apply
  `filterModelEntries` as today. If the registry is absent OR empty, apply the
  Q3 policy (recommended: empty + guidance, NOT the slow catalog fan-out).
- `src/service.ts` `summon`: if the call supplies a named-agent name (Q2-B
  `agent` field), resolve it from the registry (instant), expand to the
  underlying `model` + apply recorded defaults, and **skip the live-catalog
  validation**. If a raw `model` is supplied instead, keep today's catalog
  validation (the escape hatch).
- `src/types.ts`: widen `SummonAgentInput` with `agent?: string` (named-agent
  name). Add `unknown-agent` to the error taxonomy (named-agent name not found)
  — distinct from `unknown-model`.
- `src/tools/summon_agent.ts`: add the `agent` parameter to the schema
  (description steers toward it; `model` becomes the raw override). Keep
  `model`/`task` handling; relax `model` from **required** to optional **when
  `agent` is supplied** (one-of validation).
- `src/tools/list_agent_models.ts`: update the description to "List the named
  agents available for summon_agent" (no longer "models").
- `src/extension.ts`: add `named-agents` to `dependsOn` (optional/degrading —
  resolve lazily so absence is survivable).
- `src/pure.ts`/`pure.test.ts`: pure helpers for the named-agent-name path
  (one-of validation, default-merging, `unknown-agent` formatting) + tests.

**Wave 2 — transport contract + HTTP CRUD.**
- `transport-contract/src/index.ts`: add the named-agent CRUD request/response
  types (`GET /named-agents` → `NamedAgentsResponse`; `POST /named-agents`;
  `PUT /named-agents/:name`; `DELETE /named-agents/:name`). Additive — no
  existing type changes.
- `transport-http/src/app.ts` + `extension.ts`: resolve
  `namedAgentRegistryHandle` (optional, degrades to 503/empty when absent, like
  `computerService`/`concurrencyService`) and implement the four CRUD routes
  with validation (name charset/length, model non-empty, `reasoningEffort`
  enum). `GET /named-agents` is the new agent-facing listing source (the FE
  settings UI consumes it; `list_agent_models` reads the registry directly, not
  HTTP).

**Wave 3 — composition root.**
- `host-bin/src/main.ts`: add `namedAgentsExt` to the extensions array (after
  `credential-store`, before/alongside `agent-management` so the service is
  available when `agent-management` activates; activation is lazy-resolved so
  order is not strict). No env-var wiring needed (the registry is user-managed
  via HTTP/FE, not env).

**Wave 3 (parallel) — test fan-out.** Any `agent-management` test whose
assertions encode the old "listModels returns the full catalog" behavior must
be updated by its owner to the new "returns the named-agent shortlist"
behavior (`ORCHESTRATOR.md` §5a — test fan-out belongs to the test owner).
`vision-handoff` tests are unaffected (it uses the raw catalog + `summon`
unchanged).

### 4.4 Latency guarantee

After this work, `list_agent_models` does **zero** upstream network calls
(reads persisted KV), and `summon_agent` by named-agent name does **zero**
upstream calls for validation (the only network is the actual provider
`stream`). The single network touchpoint is the user's CRUD action
(create/update), which snapshots `ModelInfo` from the catalog once — acceptable
because it is a human-initiated, non-hot-path action.

---

## 5. Frontend implementation plan (`../frontend` — DO NOT modify from backend)

> Per the task constraints and FE `AGENTS.md`: the frontend is a separate repo;
> cross-repo contract changes are **couriered via the user**
> (`backend-handoff.md`). This section documents the FE work that the FE's own
> agent will perform once the backend contract is pinned and mirrored; it is
> **not** executed from here.

### 5.1 Contract consumption

- Re-pin `@dispatch/transport-contract` (`file:` dep) to the version that adds
  the named-agent CRUD types; regenerate the relevant `.dispatch/*.reference.md`
  mirror. Read the mirror, never `node_modules/@dispatch/*`.
- `GET /named-agents` returns the curated list for the settings UI.

### 5.2 FE work by unit

- **New `src/features/named-agents/` feature module** (logic/ui/adapter split):
  - `logic/view-model.ts` — pure: list formatting, create/edit form validation
    (name uniqueness + charset, model selection against the existing
    `GET /models` catalog), default-merging. Zero DOM/Svelte/fetch.
  - `adapter/` — injected `fetch` effects for the four CRUD endpoints.
  - `ui/` — a settings panel (list + add/edit/remove) wired into the existing
    `src/features/settings/` surface, and a model picker that reuses the
    existing two-step `ModelSelector` helpers (`splitModelName`/`joinModelName`)
    so the user picks a real `<credential>/<model>` when defining a named agent.
- **No change to `ModelSelector.svelte` or `GET /models` consumption** (MVP —
  Q6). The FE's own model picker keeps reading the raw catalog.
- **No subagent-lineage UI** (out of MVP — Q9).

### 5.3 FE verification

`bun run typecheck` (svelte-check) / `test` (vitest) / `check` (biome) / `build`
(vite), per FE `AGENTS.md`. Pure logic tests use no internal `vi.mock`; UI tests
fake only the outermost fetch edge. A live probe against a running backend
confirms the CRUD round-trip (FE `AGENTS.md` §"Live integration probe").

---

## 6. Migration / compatibility

- **Backward compatibility of `summon_agent`.** With Q2-B (augment), the raw
  `model` field remains valid; existing programmatic callers
  (`vision-handoff`) and any external automation that summons by raw model name
  keep working unchanged. The `agent` field is additive.
- **`list_agent_models` is a breaking change for model behavior** (returns a
  different, smaller list). This is the *intended* product change. Mitigation:
  updated tool description + the Q3 empty-registry policy + the `model` escape
  hatch keep summoning functional during the transition.
- **No persisted-data migration required** for existing conversations: their
  `conv:<id>:model` values (raw `<credential>/<model>`) are unrelated to the
  new named-agent registry (a separate KV namespace). No rewrite of existing
  rows. (Contrast with the prior `opencode/` → `opencode-1/` model migration,
  which is already done.)
- **Graceful degradation:** if `named-agents` is not loaded, `agent-management`
  resolves the registry to `undefined` and applies the Q3 policy. If the
  decision is "fall back to catalog when absent," that fallback lives behind
  the same `undefined` check — keep it isolated so the slow path is opt-in, not
  the default.
- **Transport contract is additive** (new endpoints/types only); existing
  `ModelsResponse` / `GET /models` are untouched, so the FE's current model
  picker keeps working until the FE ships the settings panel.
- **Cross-repo sequencing:** backend ships + pins the contract first; the FE
  re-pins + mirrors + consumes. `lsp references` does not span repos, so the FE
  side is verified independently after the courier handoff.

---

## 7. Tests

**Backend (asymmetric — strict pure, lenient shell):**
- `named-agents/src/pure.test.ts` — name validation (unique, charset/length,
  no `/`), default resolution, snapshot merging, query/vision/limit filtering,
  error formatting. No internal mocks; pure input→output.
- `named-agents` store integration test — CRUD over an in-memory
  `StorageNamespace` fake (outermost edge): create/read/update/delete,
  uniqueness enforcement, index consistency, idempotent delete.
- `agent-management` updated tests — `listModels` returns the persisted
  shortlist (instant, no catalog fan-out) when the registry is present; applies
  the Q3 policy when absent/empty; `summon` by `agent` name resolves + applies
  defaults + skips catalog validation; `summon` by raw `model` still validates
  against the catalog; `unknown-agent` error path. (These update the existing
  assertions that encoded the old full-catalog behavior.)
- `transport-http` route tests — `GET/POST/PUT/DELETE /named-agents` happy
  paths + 400 validation + 503/empty when the registry service is absent.
- `vision-handoff` tests — **unchanged** (regression guard: it still resolves
  vision models from the raw catalog and summons by raw model name).

**Frontend:**
- `named-agents/logic/view-model.test.ts` — pure form validation + list
  formatting, no mocks.
- `named-agents/ui` component tests — fake only the fetch edge; assert the
  CRUD round-trip and the model-picker reuse.
- Live probe against a running backend for the CRUD endpoints.

---

## 8. Open product questions (human decision required before code)

1. **Q1 — Canonical term.** Adopt "named agent" (with a glossary distinction
   from *subagent*), or "agent preset"/"agent profile"? *(recommendation: named
   agent + glossary entry.)*
2. **Q2 — Summon API shape.** Replace `model` with a named-agent name (A), or
   augment with an `agent` field + keep `model` as an escape hatch (B)?
   *(recommendation: B.)*
3. **Q3 — Empty registry.** Fall back to the full catalog (A), or return empty
   + guidance (B)? *(recommendation: B + raw-model escape hatch.)*
4. **Q4 — Persistence.** SQLite KV now (A), or config file/TOML (B)?
   *(recommendation: A, shape TOML-ready.)*
5. **Q5 — Staleness.** Snapshot `ModelInfo` at definition + best-effort async
   refresh (A), or live-validate at summon (B)? *(recommendation: A.)*
6. **Q6 — User's own picker.** Also surface named agents in the FE
   `ModelSelector`/`GET /models`, or MVP = agent-summoning only?
   *(recommendation: MVP = agent-summoning only.)*
7. **Q7 — CLI.** Add a `dispatch agents` CLI subcommand, or HTTP+FE only?
   *(recommendation: HTTP+FE; CLI optional add.)*
8. **Q8 — Onboarding seed.** Provide a "seed from catalog" helper?
   *(recommendation: yes, as convenience.)*
9. **Q9 — Richer defaults.** Should named agents carry `systemPrompt`/`title`/
   `cwd`/`computerId`/tool allow-deny now, or MVP = name+model (+optional
   `reasoningEffort`/`toolAccess`)? *(recommendation: MVP minimal; earn the
   rest per P4.)*
10. **Boundary.** New `named-agents` extension (recommendation) vs. inlining
    into `agent-management`? *(ORCHESTRATOR §1.3: boundary is the user's call.)*

---

## 9. Suggested implementation order (once Q1–Q10 are answered)

1. Confirm decisions Q1–Q10 with the user; update `GLOSSARY.md` (both repos)
   with the confirmed term.
2. **Wave 0:** orchestrator authors `packages/named-agents/src/types.ts`
   (contract + `namedAgentRegistryHandle`).
3. **Wave 1 (parallel):** `named-agents` extension (producer) +
   `agent-management` edits (consumer), against the fixed contract.
4. **Wave 2:** `transport-contract` CRUD types + `transport-http` routes.
5. **Wave 3:** `host-bin` composition; test fan-out; commit milestone.
6. **Cross-repo courier:** hand the pinned contract to the FE owner; FE re-pins,
   mirrors, and ships the settings panel + `named-agents` feature module.
7. Verify end-to-end: `list_agent_models` is instant + curated; `summon_agent`
   by named-agent name resolves + defaults + skips catalog validation; raw
   `model` escape hatch + `vision-handoff` unaffected; FE CRUD round-trips.

---

## 10. Pointers into the existing code (for the implementing owners)

| Concern | Location |
|---|---|
| `list_agent_models` tool | `packages/agent-management/src/tools/list_agent_models.ts` |
| `summon_agent` tool + schema | `packages/agent-management/src/tools/summon_agent.ts` |
| `listModels` / `summon` shell (catalog fan-out + validation) | `packages/agent-management/src/service.ts` (~L343, ~L411) |
| Service contract + handle + error taxonomy | `packages/agent-management/src/types.ts` |
| Pure helpers (filtering, formatting, access) | `packages/agent-management/src/pure.ts` |
| Extension wiring (service resolution, tool registration) | `packages/agent-management/src/extension.ts` |
| Credential store (catalog/resolve/getModelInfo) | `packages/credential-store/src/registry.ts` |
| Live model-list fetch (the latency source) | `packages/openai-stream/src/listModels.ts` |
| `GET /models` HTTP + `ModelsResponse` | `packages/transport-http/src/app.ts` (~L341); `packages/transport-contract/src/index.ts` (~L143) |
| Settings CRUD precedent (`GET/PUT /settings/vision`) | `packages/transport-http/src/app.ts` (~L1883) |
| KV persistence idioms (keys, index, parse/serialize) | `packages/conversation-store/src/keys.ts`, `src/store.ts` |
| `StorageNamespace` + `host.storage` | `packages/kernel/src/contracts/extension.ts`; `packages/conversation-store/src/extension.ts` |
| `defineService` / typed handles | `packages/kernel/src/contracts/hooks.ts` |
| Composition root (credential assembly, extension order) | `packages/host-bin/src/main.ts` (~L213–L305) |
| Programmatic summon consumer (must keep raw catalog) | `packages/vision-handoff/src/extension.ts`, `src/service.ts` |
| FE model picker (unchanged in MVP) | `../frontend/src/features/chat/model-select.ts`, `ui/ModelSelector.svelte` |
| FE boot catalog fetch (unchanged in MVP) | `../frontend/src/app/store.svelte.ts` (~L1233) |
| FE settings feature (where the CRUD UI lands) | `../frontend/src/features/settings/` |
| Prior agent-management design + decisions | `notes/agent-management-tools-plan.md` (§6.1, §6.2, §21) |
| Glossary (subagent/agent-management/tool names) | `GLOSSARY.md` |
