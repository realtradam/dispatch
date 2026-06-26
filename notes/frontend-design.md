# Frontend — Design (decisions LOCKED)

> **Status:** DECISIONS LOCKED (2026-06-06). **Building slice 1 = the surface system + WS
> transport (front-loaded)** — the user chose to prove the novel architecture first, not a quick
> chat MVP. This is the design HOME for the web frontend; promote settled vocab/parts into the FE
> repo's `GLOSSARY.md`/harness (and "surface" into the backend `GLOSSARY.md`) when slice 1 starts.
>
> **Read order (fresh agent):** `ORCHESTRATOR.md` → `AGENTS.md` (the backend methodology we
> MIRROR) → `GLOSSARY.md` → `notes/restructure-plan.md` (P1–P8, §-refs) → this file.
> **The user owns boundary (§5.2) + vocabulary (§5.6) calls.**
> **Driver:** a minimal chat frontend, **Svelte 5 + DaisyUI**, in a **SEPARATE repo** (`../`),
> built with the SAME discipline as the backend. Old FE at
> `/home/tradam/projects/dispatch/dispatch-source` is REFERENCE-ONLY (UX/tech, NOT structure).
> Port reserved: `FRONTEND_PORT=24204` (.env).

---

## 0. Goal
A minimal browser chat client — the FE analogue of the curl/CLI MVP: send a message, render the
streamed multi-turn response (`conversationId` threads history). The architecture is a **thin
shell + pure feature libraries** with the discipline that makes the backend testable and
agent-buildable, PLUS a **backend-declared, frontend-agnostic UI surface system** so backend
extensions expose UI without any per-extension frontend code.

---

## 1. The methodology call: port the PRINCIPLES, not the STRUCTURE (P4)

The biggest risk is cargo-culting our own backend. The kernel/extension-host/manifest/DAG/
capability-gate machinery exists to solve backend problems a browser app does **not** have:

| Backend machinery | Why it exists | FE has that problem? |
|---|---|---|
| Extension host + manifests + DAG | dynamic, runtime-loaded, third-party features | No — Vite bundles at build time |
| Capability gate (fs/shell/net/secrets) | untrusted code touching real I/O | No — the browser sandbox gates |
| `runTurn` / turn loop | the product *is* the loop | No — the FE renders a stream |
| On-disk durability / `reconcile` | crash-safe persisted history | Smaller (a client cache; §6) |

**What ports (the load-bearing parts):** P1 (feature-as-a-library), P2 (functional core / inject
effects), P3 (no ambient state), one-owner-per-unit, asymmetric testing, typed coupling (§5.4),
and the harness (P5–P8). These solve *real* FE problems — the old FE's "tools leak across tabs" /
"model resets on tab switch" were textbook **P3 ambient-state bugs**.

**What replaces the host:** an ordinary **composition root** (the FE's `host-bin`) — one place
that imports feature modules and wires them with typed calls. No registry-of-code, no manifest.

**The one place a discovery seam DOES earn its place (P4 cuts both ways):** because backend
extensions must expose UI that the FE surfaces, we DO need a lightweight **surface discovery**
seam (§4). This is the backend's own split — *contracts are static TYPES; loading is dynamic*
(§5.4) — applied at the FE↔BE boundary, NOT the heavy host machinery.

**No mandatory spine — composition over privilege.** The FE is a **composition of feature
modules + a surface host**, assembled per-frontend (or per-route) at the composition root. NO
feature is globally privileged: chat is the central *product* feature but not the structural
root — legitimate frontends compose without it (an agent editor, a read-only history explorer, a
project viewer that mounts chat only after a project is picked). "Core" is whatever a given app
composes; the teeth — dependency-direction + "works without optional surfaces" — apply to that
chosen set. Skip the backend's 3-tier ceremony.
- **Feature modules** = bespoke, contract-backed UI (chat, agent-editor-if-bespoke, history
  explorer); each is feature-as-a-library, includable or not.
- **Surfaces** (§4) = generic, backend-declared declarative UI for the long tail (and for tools
  that fit the semantic catalog).
- **Chat is a feature, NOT a surface** — different data lifecycle (append-only/cached/`seq` vs.
  live/ephemeral, §6.2) + no genericity payoff (a transcript always needs bespoke rendering). It
  **decomposes** into a read-side (transcript/history) + write-side (composer/live) so a history
  explorer reuses just the read-side.
- Dependency-direction rule: features depend on `core`/`wire`, never on each other; the shell
  composes features, never the reverse.

---

## 2. Principle translation (P1–P8 → FE)

| Principle | FE translation |
|---|---|
| **P1 feature-as-a-library** | each feature is a self-contained module with a clean typed surface, importable alone |
| **P2 functional core / inject effects** | pure reducers/view-models/formatters; Svelte + WS/`fetch` + storage are the injected shell. The conversation state machine is `reduce(state, AgentEvent) → state` — unit-tested with zero component mounting |
| **P3 no ambient state** | per-conversation state owned explicitly; runes/stores are a thin reactive wrapper over the pure reducer, not the home of logic |
| **P4 don't adopt by reputation** | the surface system, tiers, transport — each earns its place against a named need; grow the catalog from real demand |
| **§5.4 typed coupling** | cross-feature links are typed imports/callbacks; no stringly-typed event bus. Discovery-by-id (catalog, subscribe) is sanctioned *data flow*, not a code reference |
| **one owner + asymmetric testing** | one owner-agent per feature module; strict zero-mock on `logic/`, thin component/e2e on `ui/` |
| **P5–P8 harness** | repo-scoped harness travels with the FE (§8); vocabulary shared with the backend verbatim |

---

## 3. Repo structure (Vite + Svelte 5 SPA — SETTLED; not SvelteKit)

```
dispatch-web/                  (../frontend — NEW repo, own git)
  AGENTS.md  ORCHESTRATOR.md  GLOSSARY.md
  .dispatch/{package-agent.md, rules/frontend-*.md}
  src/
    app/            SHELL + composition root (the ONLY place that names features)
    core/           PURE, framework-free, zero I/O:
      transcript/     events → Chunk[] reducer (the single render model, §6)
      cache/          reconcileCache / selectEvictions (pure; injected IndexedDB)
      surfaces/       the surface interpreter core (pure: spec → view-model)
      protocol/       the transport-agnostic op-protocol core (pure state machine, §5)
      wire/           imported wire + ui contracts (types only)
    features/       feature-as-a-library modules (logic/ pure · ui/ svelte · adapter/ effects)
    adapters/       injected browser effects: WS client, fetch, IndexedDB, history, clipboard
  vite + tsconfig + biome + vitest (+ @testing-library/svelte; Playwright later)
```

---

## 4. The surface model — backend-declared, frontend-agnostic UI (the centerpiece)

### 4.1 What a surface is
A **surface** is a backend-declared **"data transportation surface"**: a typed data structure
describing *what data exists, its semantics, and what actions can act on it* — NOT UI. The
backend transports **structure + semantics + actions**; the client owns **100% of presentation**.
Field kinds are *semantic*, not visual: `toggle` = "a boolean + an action" (not "draw a switch");
`progress` = "a bounded ratio + a label" (not "draw a bar").

This is the disciplined variant of Server-Driven UI: the server says *what the data means*, it
**never dictates how it looks**. It is the same principle that already lets the CLI and web share
one wire contract (`transport-contract`), generalized from the chat wire to *all* UI intent: one
surface renders as a DaisyUI switch on web, a `[y/n]` prompt in the CLI, a tap-switch on mobile —
same data, three renderers, zero backend awareness of any of them.

### 4.2 The shape (semantic; names are hints, the contract is the data shape)
```ts
SurfaceSpec = { id; region; title; fields: SurfaceField[] }   // ordered
SurfaceField =
  | { kind: "toggle";   label; value: boolean; action: ActionRef }
  | { kind: "progress"; label; value: number /* 0..1 */ }
  | { kind: "selector"; label; value; options: Option[]; action: ActionRef }
  | { kind: "stat";     label; value: string }
  | { kind: "button";   label; action: ActionRef }
  | { kind: "custom";   rendererId; payload }   // the escape hatch — see guardrail 2
ActionRef = a typed reference the client passes back to invoke a backend action
```
`region` = where the surface mounts (placement). `kind` = the field's semantic type. Names are
training-baked (P8 — no need to invent "BoundedRatioQuantity").

### 4.3 The frontend-agnostic invariant (load-bearing)
**The backend depends only on the semantic surface contract and on ZERO rendering technology —
so swapping Svelte→React, or adding a TUI/mobile client, is a zero-backend-change event.** The
contract carries coarse placement (which region, title, field order) + semantics + actions —
**never styling, never pixels, never a CSS/DaisyUI token.** DaisyUI is purely the Svelte
renderer's private business; the backend has never heard of it.

### 4.4 Discovery + opt-in subscription (no firehose)
The FE is in control of what it observes — the backend never pushes everything continuously.
The system has three interaction kinds; **only the live part is transport-coupled:**

| Interaction | Shape |
|---|---|
| Discovery — the **surface catalog** | `GET /surfaces` → `[{ id, title, region, kind }]` (metadata only, no data) |
| One-shot read — current spec | `GET /surfaces/:id` → full `SurfaceSpec` + values |
| Fire an action | `POST /surfaces/:id/actions/:actionId` |
| **subscribe / unsubscribe + live updates** | the WS op-protocol (§5) — pushes patches for subscribed surfaces ONLY |

```
connect → GET /surfaces (catalog) → user selects X → GET /surfaces/X (+ subscribe X) →
  patches for X stream until unsubscribe(X) → close X → unsubscribe → traffic for X stops
```
Catalog changes (extension toggled) are low-frequency → a lightweight "catalog-invalidated"
ping or re-pull, not a stream. The backend builds a spec **lazily** — only for queried/
subscribed surfaces.

### 4.5 Isolation guardrails (why this is isolation-aligned — the audit rationale)
The surface-as-data approach is the **isolation-maximal** design: extension↔view coupling
collapses to ONE typed contract (the sanctioned shared surface), the extension imports zero
frontend, the FE imports zero extension code. These invariants keep it that way:

1. **The interpreter stays generic — forbid any `if (surface.id === "...")`.** The shared
   interpreter + widget catalog is sanctioned *platform* (justified like the kernel ABI). The
   instant it special-cases a known surface, it has imported a feature's identity and isolation
   breaks. Rule: the interpreter knows field *kinds*, never surface *identities*.
2. **`custom` is the one isolation compromise — minimize and type it.** A client-local renderer
   for a `custom` payload recouples a FE unit to one extension. Keep it rare (P4/P6). The
   `custom` payload type must be **exported from the owning extension's contract** so the
   bespoke renderer imports a typed symbol (lsp-traceable), not a blind `unknown`.
3. **A surface owns only its OWN data + actions.** It must never reference another extension's
   action/state — cross-extension needs go through the normal typed service/hook path, never
   surface data. (Actions are intra-extension: the surface and its handler share one owner.)
4. **Action/live-update state is owned per-surface and reconciled purely** (P3). Read-only
   surfaces are trivially clean; the moment toggles fire, route through `reconcile(state, update)`
   with explicit ownership.
5. **The agnostic invariant is enforced** (§4.3): no styling/framework token may appear in the
   ui-contract. Lint/review rule.
6. **Subscriptions are explicitly owned + disposed; specs built lazily.** The backend never
   eagerly materializes all surfaces; the FE owns its subscription set as explicit state and
   tears it down on unmount. No ambient subscription registry.

### 4.6 Declarative-first, bespoke as escape hatch
- **Tier 1 (the path):** declarative semantic surfaces over the fixed catalog — settings,
  toggles, progress, info, the future "views" (§9). Zero FE code per extension.
- **Tier 2 (escape hatch):** (a) *prettier rendering than the generic one* = purely client-local
  (no contract impact, agnostic intact); (b) *data fits no primitive* = the `custom` kind, opt-in
  per client, graceful-skip when a client has no renderer for that `rendererId`.

### 4.7 Catalog growth (P4)
Slice 1 builds the surface *contract + interpreter + WS* and proves it against **one real first
surface** (TBD — §10 "To start"). Grow the catalog (`toggle, progress, selector, stat, button` +
`custom`) from real demand, never speculatively.

---

## 5. Transport — agnostic op-protocol + WebSocket, carrying BOTH (SETTLED)

Define the protocol as **logical ops with a pure core**, then the carrier is an injected adapter
(swappable/testable):
```
ops (the contract):  getCatalog · getSurface(id) · subscribe(id) · unsubscribe(id)
                     · onUpdate(id, patch) · invokeAction(id, actionId, payload)
                     · sendMessage(...) · onDelta(AgentEvent)
pure core (P2):      reduce(intent, incoming) → { viewModel, outgoingCommands }
injected shell:      the WS client (web)  OR  REST+stream (one-shot clients)
```
- **Carrier = WebSocket, up front, for BOTH** live turn-deltas AND surface updates over ONE
  persistent connection (+ a small reconnect/router). The connection IS the subscription session
  → subscriptions die with the socket (clean lifecycle, guardrail 6). Bun's WS is first-class; the
  old app proved a reconnecting WS client here.
- **REST `POST /chat` (NDJSON) is retained for one-shot clients (the CLI)** — no WS needed; plus
  discovery, actions, and incremental history sync (§6). **Same `AgentEvent`s, different
  carriers** — exactly "inject the transport."
- Chosen over SSE+POST: the subscription model wants a session whose lifetime = the connection
  (SSE needs a server-side per-stream registry + GC); Bun ergonomics + precedent; bidirectional
  sub/unsub without a correlation id. (SSE+POST remains a documented alternative behind the same
  ops if proxy/CDN/curl-debuggability ever dominate.)

---

## 6. Chats — caching + delta streaming

### 6.1 The enabler
The backend §3.4 durability gives us the hard part: history is an **append-only chunk log** (past
turns never mutate) with a **monotonic per-conversation cursor**, and `reconcile(rows)` yields a
valid history on load. Therefore:
> **The client cache is a pure performance optimization over an authoritative, incrementally-
> syncable backend log. Wiping it is correctness-neutral — worst case is a re-fetch.**
That is what makes reliable caching + aggressive purging *safe*.

### 6.2 Two data lifecycles — they cache OPPOSITELY
| | Chats (history) | Surfaces |
|---|---|---|
| Nature | append-only, immutable below the seal | live current-state |
| Client caching | **yes** — durable, incrementally synced, purgeable | **no durable cache** (stale = wrong; "show stale, update" at most) |
| Sync | "give me chunks after seq N" | subscribe → push, current-only |

### 6.3 Delta streaming fits via the seal boundary + one reducer
Live `AgentEvent` deltas are the **in-flight turn** — ephemeral. They fold into the canonical
`Chunk[]` via the one pure reducer (`appendEventToChunks` pattern). **`turn-sealed` = the
cache-commit signal:** below the last seal is immutable + cacheable; the in-flight turn is
provisional (in-memory) until it seals. **Sync granularity (per-chunk `seq`) ≠ commit granularity
(per-turn seal)** — finer sync, turn-atomic caching.
```
 IndexedDB cache (committed chunks) ─┐
 REST sync: chunks since seq N      ─┼─►  reduce → Chunk[] ─► render
 WS: live deltas (active turn)      ─┘       ▲ turn-sealed ⇒ commit provisional turn to cache
```
Three sources, ONE reducer, ONE shape — the one-render-model decision paying off.

### 6.4 Cache design (mapped to principles)
- **P2/P3:** pure `reconcileCache(cached, incoming, seq) → { nextCache, whatToFetch }` and
  `selectEvictions(index, budget) → toEvict`; storage (**IndexedDB**) is the injected shell.
  The mirror of the backend's `reconcile`.
- **Isolation/P1:** a self-contained `conversation-cache` feature; depends only on the wire
  contract (chunks + `seq` + `turn-sealed`).
- **Symmetry:** the FE cache = the backend's durability discipline applied client-side
  (append-only, seq-keyed, reconcile-on-load, derived status).
- **"Don't pass all data constantly" — satisfied:** the wire only ever carries (a) live deltas
  for the active turn and (b) the incremental tail since the client's `seq`. Cached chunks are
  served locally, never re-fetched.

### 6.5 Purging (safe, simple-first — P4)
Eviction is re-syncable, so start simple: byte/turn budget; LRU by conversation + evict oldest
sealed turns when over budget; **never evict the active conversation**. Defer per-chunk windowing
/ scroll-back rehydration until a conversation is big enough to need it.

### 6.6 Honest subtleties
- **Interrupted-turn tail vs `reconcile`:** commit to cache only on `turn-sealed`; a provisional
  tail is always replaceable by the next sync. No stale-tail risk.
- **Multi-tab / CLI+web convergence:** append-only + `seq` ⇒ a monotonic merge (each client
  pulls chunks after its own `seq`). Only breaks if we ever allow editing/deleting history — we
  don't (append-only).
- **Storage medium is an injected detail** — IndexedDB is the likely choice; the pure core
  doesn't care.

---

## 7. Backend contract changes for FE-friendliness

**Shapes are right — don't churn them** (`ChatRequest`/`ModelsResponse`/`AgentEvent` proved live
via the CLI). The changes are about **packaging**, **read-side coverage**, and the **surface +
WS** seam, because a FE is long-lived, reloadable, multi-conversation, and surfaces extensions.

- **`transport-contract` self-containment — DECIDED: split a types-only kernel sub-package.** The
  pure wire/event types move to a types-only package that both `@dispatch/kernel` and
  `transport-contract` re-export → `AgentEvent` stays single-source and the FE repo depends on no
  runtime.
- **New shared `@dispatch/ui-contract`** (types-only): the semantic field-kind catalog + `region`
  vocabulary + action protocol + surface-catalog types (§4). Consumed by the backend (to declare),
  web, and CLI — **not** anything Svelte.
- **Surface + WS seam:** the surface-contribution mechanism (kernel/host carries it generically;
  extensions declare surfaces), `GET /surfaces` (catalog) + `GET /surfaces/:id` + `POST
  /surfaces/:id/actions/:actionId`, and the **WS channel** multiplexing turn-deltas + surface
  ops (§5).
- **Read-side endpoints:**
  | FE need | Today | Proposed |
  |---|---|---|
  | Reload a transcript | history only as the turn's own stream | `GET /conversations/:id?sinceSeq=<seq>` → reconciled `ChatMessage[]`/`Chunk[]` (incremental) |
  | Conversation list / sidebar | none | `GET /conversations` → `[{ conversationId, title?, updatedAt, status }]` (later slice) |
  | "Stop generating" | old `/chat/cancel` never rebuilt | `POST /conversations/:id/cancel` (later slice) |
- **Monotonic cursor on the wire — DECIDED: per-chunk `seq`.** `Chunk` carries no cursor today;
  add a per-chunk `seq` (finer than turn-granular; allows mid-turn sync). Cache still commits at
  the turn seal (§6.3).
- **Render-model alignment:** history returns the same `Chunk[]`/`ChatMessage[]` the live stream
  folds into → ONE FE reducer. (Proven: old `chunks/append.ts` + DB-free `transform.ts`.)
- **Separate-repo consequence:** `lsp references` no longer spans the FE↔BE seam → the dormant
  **§2.9 semver discipline wakes up** (the FE pins a contract version; a `major` bump is the
  fan-out signal). A thin "contract conformance" type-test in the FE catches shape drift the
  cross-repo compiler can't.

---

## 8. The harness to set up (repo-scoped — P7)

Because it's a separate repo, the harness travels with it. The new repo needs its own:
- **`AGENTS.md`** — FE constitution: pure view-models, inject browser effects, no ambient
  cross-component state, Svelte-thin, one-owner, asymmetric testing.
- **`.dispatch/rules/frontend-*.md`** — 3–5 line reflexes in the existing format, e.g. *"Logic
  modules import no Svelte and no `fetch`/DOM — effects are injected"*; *"State is owned
  per-conversation and passed in; no module-global mutable store"*; *"The NDJSON/WS parser is
  pure (bytes→events); inject the socket"*; *"The surface interpreter knows field kinds, never
  surface ids."*
- **`.dispatch/package-agent.md`** — owner-agent brief adapted so "unit" = feature module; verify
  = `vitest` (pure) + component tests.
- **`ORCHESTRATOR.md`** — FE summon manual. **DECIDED: per-repo harness** — FE summons run with
  cwd = FE repo root + its own TS language server. **Cross-repo bridge:** an owner-agent or the
  orchestrator may **ask the USER to look at the other (back/front) repo** when a change spans the
  seam — the user is the cross-repo courier (since `lsp` can't span repos).
- **`GLOSSARY.md`** — adopt the backend's canonical terms **verbatim** (no drift):
  `conversation`/`conversationId`, `turn`, `step`, `chunk`, `tool call`, `model name`,
  `model catalog`, `AgentEvent`. Duplicating these is the intended trade (isolation-over-DRY:
  share knowledge, not runtime code).

**In THIS repo, when slice 1 starts** (per `tasks.md` ROADMAP §2): retire the AGENTS.md
"Backend only for now (no frontend)" line; update `ORCHESTRATOR.md` §7 (geography) + §3
(rule-scoping map). `FRONTEND_PORT=24204` reserved.

---

## 9. Vocabulary (§5.6 — human-gated; SETTLED 2026-06-06)

- **surface** — a backend-declared, **frontend-agnostic** semantic data contribution (a "data
  transportation surface"): fields + values + bound actions; structure + semantics + actions,
  **never styling**. The backend *exposes* surfaces; any client renders them in its own idiom.
- **view** — an **old-Dispatch FE term, DEFERRED/RESERVED.** A sidebar element the user could
  open; it took a spot in the sidebar and displayed a **settings view** or a **feature-specific
  view** (e.g. cache reheating). A FE rendering affordance — conceptually the place a surface (or
  settings) gets shown. The user liked the old interface and will **revisit "views" later**; the
  term must not be reused meanwhile. (NB: avoid a `side-view` region name — it overlaps; leave
  region names open until views are revisited.)
- **region** — *where* a surface mounts (the coarse placement). Chosen over "slot" to avoid
  clashing with Svelte's `<slot>`.
- **field kind** — the semantic type of a field (`toggle`/`progress`/`selector`/`stat`/`button`/
  `custom`); the discriminant the interpreter switches on.
- **action / action ref** — the FE term for a backend-invokable action; a field carries an
  **action ref** the client posts back. **Backend keeps `command` for now** (its existing
  contribution point); a future review to unify `command` → `action` is logged in
  `notes/restructure-plan.md` §8 (deferred). Do NOT rename `command` in the backend yet.
- **surface catalog** — the list of available surfaces (metadata) the FE fetches to discover them
  (`GET /surfaces`). Parallels the existing **model catalog**. ("capability manifest" was
  considered and **dropped** — it overloaded "manifest" and was redundant with this.)

Relationship: a *surface* is backend data; a *view* (future) is a FE rendering slot that displays
a surface. (Promote "surface" + this vocab to the backend GLOSSARY + the FE GLOSSARY when slice 1
starts.)

---

## 10. Decisions

### Settled
- **Slice order: surface system + WS FIRST** (front-load the architecture), then cache/reload,
  then chat polish / conversation list / theming.
- Methodology = port principles, not the heavy host machinery; thin shell + pure feature
  libraries + a lightweight surface-discovery seam (§1).
- No mandatory spine: a composition of feature modules + a surface host; "core" is per-frontend;
  chat is a (decomposable) feature, not a surface (§1).
- Surface model = backend-declared, frontend-agnostic "data transportation surfaces"; semantic
  field kinds; client owns 100% of presentation; isolation guardrails 1–6 (§4).
- Discovery (surface catalog) + opt-in per-surface subscription; no firehose; lazy spec build (§4.4).
- Transport = agnostic op-protocol with **WebSocket carrying BOTH** turn-deltas + surfaces; REST
  `/chat` retained for one-shot/CLI (§5).
- Caching/streaming = append-only + **per-chunk `seq`** source of truth; `turn-sealed` =
  cache-commit; three-source → one-reducer → one `Chunk[]`; pure `reconcileCache`/
  `selectEvictions` + injected IndexedDB; safe aggressive purging (§6).
- Stack = **Vite + Svelte 5 SPA** (not SvelteKit); testing = vitest + `@testing-library/svelte`
  (Playwright later) (§3).
- `transport-contract` self-containment = **split a types-only kernel sub-package** (§7).
- Orchestration = **per-repo harness** + user-as-cross-repo-courier bridge (§8).
- Surface internals = recommended defaults, finalized as slice 1 details land: catalog =
  `toggle/progress/selector/stat/button` (+`custom`); on/off = config+restart for now (runtime
  enable/disable endpoint = a future backend pass); v1 interactivity = read-only + simple
  toggles/buttons (defer rich forms/validation).
- Vocabulary (§9): `surface`, `view` (reserved), `region`, `field kind`, `action`/`action ref`
  (backend stays `command`, future review), `surface catalog`.

### Slice 1 — BUILT + verified live (2026-06-06) ✅
The surface system, end-to-end: `ui-contract` (surface ABI + WS protocol), `surface-registry`
(typed service), `transport-ws` (Bun WS server on :24205, path-agnostic upgrade),
`surface-loaded-extensions` (first real surface), kernel `getExtensions`; FE `core/protocol` +
`features/surface-host` (interpreter + field components) + `adapters/ws` + `app` composition root.
**Live WS probe: catalog → subscribe → surface rendered the 10 loaded extensions** as stat fields.
Backend 460 vitest + 77 bun, FE 76 tests; both repos typecheck + biome clean. Deferred: F-app CR-1
(vitest `browser` resolve condition, for component-render tests); B2 kernel wire-types split (chat
slice); DaisyUI styling (F4 follow-up). The slice-1 input decisions were:
1. **The first real surface** to build + prove the system against (the §4.7 demo). Needs a
   concrete feature — e.g. a read-only server/model **stat** surface first (proves discovery →
   subscribe → render with no action round-trip), then add a **toggle** to prove the action path.
   Or pick a different first surface.
2. **WS-transport boundary:** a NEW `transport-ws` extension vs. augment the existing
   `transport-http`. (Boundary call.)
3. **Repo scaffold go-ahead:** create `../frontend` (git init + Vite/Svelte/biome/vitest +
   the §8 harness). Orchestrator can scaffold config + harness; feature code = summoned agents.

### Slice-1 findings + open items (for the next, clean-context agent)
- **Bug found + FIXED — transport-ws WebSocket upgrade.** The pure router unit-tested green, but
  the live `Bun.serve` shell gated `server.upgrade()` behind a path (`/ws/surfaces`), so a client
  hitting `ws://host:24205/` got "Expected 101" instead of an upgrade. **Only the live WS probe
  caught it** — pure unit tests can't. Fixed (path-agnostic upgrade; `426` for non-WS) + a
  `bun:test` server test (`packages/transport-ws/src/server.bun.test.ts`). **LESSON (reinforces
  `restructure-plan.md` §3.6): a transport/server SHELL needs a thin LIVE integration test — the
  effectful shell is exactly where integration bugs hide.** Apply to every future transport unit.
- **"10 vs 11 extensions" was a PROBE ARTIFACT, not a bug.** A boot-probe that exported an EMPTY
  `DISPATCH_API_KEY` (it grepped a var absent from `.env`) made `provider-openai-compat` skip
  activation → the surface showed 10. Booted normally (`bin/up` / `.env`'s real key) all **11**
  activate (incl. "OpenAI-Compatible Provider") — verified live. Scar tissue: run live probes with
  the real env, never an overridden empty key.
- **§8 reinforced (it cost me twice this session).** Boot-probes LEAK servers → the next boot hits
  `EADDRINUSE`; ALWAYS sweep with the bracket-trick `pkill` afterward. And a single
  boot+probe+cleanup bash command HANGS the tool — boot it, read the probe's `RESULT` + the
  surface from the LOG FILE, then run a SEPARATE cleanup command. (See `ORCHESTRATOR.md` §8.)
- **OPEN — FE component-render tests (CR-1).** `dispatch-web/vite.config.ts` needs Svelte's
  `browser` resolve condition (or the `@testing-library/svelte/vite` `svelteTesting()` plugin) for
  `@testing-library/svelte` `render()` under vitest/jsdom. The 84 logic/store/resolver tests pass
  without it; it only gates DOM component-render tests. Apply when those get written.

---

## 11. References (do NOT copy blindly — keep our methodology)
- Old Dispatch FE: `/home/tradam/projects/dispatch/dispatch-source` (Svelte + DaisyUI) — UX/tech
  reference only, NOT structure (esp. the "views" sidebar UX the user wants to revisit, §9).
- Backend seam: `packages/transport-contract/src/index.ts` (`ChatRequest`/`ModelsResponse` +
  re-exported `AgentEvent`), `packages/kernel/src/contracts/events.ts` (`AgentEvent`),
  `packages/kernel/src/contracts/conversation.ts` (`Chunk`/`ChatMessage`).
- Durability/cache basis: `notes/restructure-plan.md` §3.4 (append-only + `reconcile`).
- Methodology: `notes/restructure-plan.md` §1 (P1–P8), §2.9 (versioning), §5.4 (typed coupling),
  §5.6 (glossary), `AGENTS.md`, `.dispatch/rules/`.
```
