# search-backend-selection — Backend Plan (research + planning, NOT implemented)

Goal: make the `web_search` tool's backing search backend selectable — the current
self-hosted Firecrawl backend plus one new "umans" backend (Exa engine) — a GLOBAL
setting persisted to backend storage and exposed over HTTP so the Settings pane can
render a dropdown. The whole thing must stay modular: search is optional, "no
backend selected" must be a first-class state.

## 1. Current state (verified in this worktree)

- `web_search` is contributed by the `tool-web-search` extension
  (`packages/tool-web-search/src/extension.ts`): manifest `tier: "standard"`,
  `trust: "bundled"`, `activation: "eager"`, `capabilities: { network: true }`.
- The backing client is hard-wired at activation: `createFirecrawlClient({ baseUrl })`
  with `FIRECRAWL_BASE_URL` env → Tailscale default (`http://PII_REDACTED_SERVICE_IPV4_01:31329/v1`).
  No selection mechanism of any kind exists today.
- `createWebSearchTool({ client })` takes the client as an injected dep (`tool.ts`) —
  the tool's `runMode` dispatch (search/scrape/crawl/map) only speaks the
  `FirecrawlClient` interface. This is the seam to plug alternate backends into.
- The extension is imported eagerly in `packages/host-bin/src/bundled.ts` (line ~52)
  alongside ~40 other bundled extensions.
- **Modularity already exists one level up**: `workspace-plugin-config`
  (`isPluginUsable`: non-core plugins are opt-in per workspace) +
  `session-orchestrator/src/tools-filter.ts` workspace tool-gate drops tools whose
  owning plugin is not usable in the turn's workspace. So "search not wanted in this
  workspace" is already achievable by disabling the `tool-web-search` plugin — what's
  missing is *which backend* the tool uses, and a "none" choice that lives in config
  rather than plugin state.
- **Settings persistence pattern to copy**: `heartbeat`. Its `config-store.ts` uses a
  `StorageNamespace` with key `config:<workspaceId>`, a pure `applyConfigUpdate`, a
  service exposed via a registry slot, and `GET`/`PUT /workspaces/:id/heartbeat`
  routes in `transport-http/src/app.ts` (~line 2278) that degrade gracefully when the
  extension isn't loaded (GET → defaults, PUT → 503).

## 2. Proposed architecture

### 2.1 New contract: `SearchBackend`

New package `packages/search-backend-contract` (mirrors `provider-contract` /
`transport-contract` naming) exporting:

```ts
export interface SearchBackend {
  readonly id: string;                         // "firecrawl" | "umans" | future
  readonly label: string;                     // "Firecrawl (self-hosted)"
  search(params: SearchParams, signal: AbortSignal): Promise<readonly SearchHit[]>;
}
```

Types (`SearchParams`, `SearchHit`) move from `tool-web-search/src/client.ts` +
`format.ts` into the contract package so backends and the tool share them.

- **Scrape/crawl are NOT part of the selection.** The dropdown picks the *search
  engine* only; `scrape` and `crawl` always route to the self-hosted Firecrawl
  client regardless of which backend is active (keyless, already works — verified
  2026-09-24). This means the umans backend only ever implements `search`.
- **Dropdown entries (decided)**: exactly two backends — `firecrawl`
  ("Firecrawl (self-hosted)") and `umans` ("Umans (Exa)"). No `native` variant,
  no other backends. Plus a `"none"` entry as the off state (modularity: search
  is not always wanted). The umans relay hardcodes
  `X-Umans-Websearch-Provider: exa` — no sub-provider config surface.
- **`map` mode is removed entirely.** Verified underperforming (sitemap-dependent:
  on a plain-HTML site with no `sitemap.xml` it returns only the entry URL, while
  crawl discovers the real link graph). `crawl` with a limit covers the same need.
  Removal touches: the tool's parameters/`runMode` switch, `validate.ts`,
  `format.ts` (`formatMapResults`), the client's `map` method, and any
  downstream consumers of the mode enum (wire types, tests, FE types).
- `firecrawl` search backend: thin adapter wrapping the existing
  `createFirecrawlClient`'s `search` (baseUrl resolution unchanged).
- `umans` search backend: **search-only relay** — see §2.2.1.

### 2.2 Selection state: `search-config` store + service — GLOBAL (decided)

Follow the heartbeat pattern, but **global** (not per-workspace) per the user's
decision — persisted to the backend storage:

- Pure `applyConfigUpdate`-style module (partial update, validation of the backend
  id against the *available* backend list, default = `"firecrawl"` so today's
  behavior is the zero-migration default).
- `StorageNamespace` persistence, single fixed key (e.g. `config:global`) →
  `{ backend: string }`. `"none"` is the explicit opt-out value.
- A small service (created by the `tool-web-search` extension, exposed via registry
  slot) with `getConfig()` / `updateConfig(patch)` / `availableBackends()` —
  availability = registered ∧ configured (firecrawl: always, self-hosted,
  keyless; umans: only when `UMANS_API_KEY` resolves).
- The existing per-workspace *plugin* gate still removes the whole tool per
  workspace; that stays orthogonal.

### 2.2.1 The `umans` backend — server-side search via `/v1/messages` (user-provided research)

Umans has **no standalone search endpoint**. Web search is built into the normal
Anthropic-style `/v1/messages` chat API:

- The request includes a server-side tool: `tools: [{ type: "web_search_20250305",
  max_uses: <cap> }]` — umans executes the search itself during generation.
- The search engine is chosen per-request via the
  `X-Umans-Websearch-Provider`
  header: `native` (Kimi-backed) or `exa` (neural-ranked, richer results — the
  path the user tested successfully with umans-flash), `none` to pass your own
  tool through. **Decided: always `exa`** — hardcoded in the umans backend
  (dropdown exposes exactly firecrawl + umans-exa, nothing else).
- Auth: existing `UMANS_API_KEY` + `UMANS_BASE_URL` (already in `/etc/dispatch/env`,
  already resolved by `provider-umans/src/resolver.ts`).
- Verified behavior (user's test): the model issues its own query and returns
  results with URLs, titles, snippets, and page ages. Billing: both test requests
  posted $0.00 / 0 tokens — free for now, but counts against the wallet's
  rate-limit window (re-check the ledger after heavier use).

**Relay design**: the backend's `search(query)` cannot just hit an endpoint and
parse a JSON hit list — it must run a tiny LLM turn. Proposed shape:

```
POST {UMANS_BASE_URL}/v1/messages
headers: x-api-key / Authorization: UMANS_API_KEY
         X-Umans-Websearch-Provider: exa        (fixed)
body:    { model: <relay model, default umans-flash (tested)>,
           max_tokens: <small>,
           messages: [{ role: "user", content: `<the raw query, verbatim>` }],
           tools: [{ type: "web_search_20250305", max_uses: <cap, default ~3-5> }] }
```

The response's content blocks contain the server-side search results
(URLs/titles/snippets/ages); map those to `SearchHit[]` so the tool's output
formatting (`formatSearchResults`) stays unchanged for agents. The model's
prose answer is discarded (decided: hits-only — keeps the tool contract
byte-identical with the Firecrawl path and avoids double-synthesis).

Config surface this adds (all with defaults, all optional):
- `search.umans.model`: relay model (default the tested `umans-flash`; NOT the
  chat default `umans-coder`)
- `search.umans.max_uses`: search cap

Constraints to respect: a per-request timeout (the relay is a full LLM turn —
slower than Firecrawl's direct search); the turn's abort signal must cancel it;
failure modes (no key → backend `configured: false`; HTTP error → tool-level
`isError` result, never a thrown crash).

### 2.3 Tool wiring (backend resolution — global)

- `createWebSearchTool` gains a search-backend *resolver* dep
  (`() => Promise<SearchBackend | null>`) for search mode, while scrape/crawl
  keep the always-on Firecrawl client directly.
- `execute` in **search mode** resolves the active backend (global config);
  `null`/`"none"` → `{ isError: true }` with a clear "search disabled" message.
  Scrape/crawl are unaffected by the selection (and by `"none"`).
- **No tools-filter drop for `"none"`** — since scrape/crawl remain functional,
  hiding the whole `web_search` tool when search is off would remove working
  functionality. The tool description should be reworded to say search may be
  disabled. The existing per-workspace *plugin* gate remains the coarse
  off-switch that removes the entire tool.

### 2.4 HTTP contract (what the Settings dropdown calls) — GLOBAL routes

```
GET  /search/config
  → { backend: "firecrawl" | "umans" | "none",
      available: [{ id, label, configured }] }   // + default flag
PUT  /search/config   body { backend: string }
  → 200 { backend } | 400 unknown/unconfigured backend | 503 service not loaded
```
Global (not workspace-scoped), matching other global routes (`/plugins`,
`/models`). Degrade like heartbeat when the extension is absent. Wire types in
`transport-contract` + `wire`.

## 3. Modularity guarantees

- Selection is additive: `"none"` / extension disabled → search mode refuses
  cleanly (or the whole tool disappears via the existing plugin gate); scrape/
  crawl keep working; no error noise.
- The `SearchBackend` contract is the only coupling point; new backends are a new
  implementation + registry entry, nothing else changes (tool, routes, UI untouched).
- Plugin-level enable/disable (workspace-plugin-config) continues to work
  orthogonally as the coarse on/off for the entire tool; backend selection is the
  fine-grained choice for search only.

## 4. Decisions (all settled — ready for implementation)

1. **Relay output: hits only** — parse the structured search-result blocks into
   `SearchHit[]`; the relay model's prose answer is discarded.
2. Billing: umans search is currently free and the wallet's rate limit is large
   (user: "today we don't care"). Passive watch-item only.

All other decisions, recorded for the implementer:
- Dropdown = exactly `firecrawl` + `umans` ("Umans (Exa)"), plus `"none"` as the
  off state; umans always sends `X-Umans-Websearch-Provider: exa`.
- Setting is GLOBAL, persisted to backend storage (not per-workspace).
- Dropdown saves on change (no Set button).
- Scrape/crawl always route to Firecrawl; `map` removed.

## 5. Testing / rollout notes

- Pure units: config update validation, backend registry resolution, umans relay
  request/response mapping (parse content blocks → `SearchHit[]`), map-removal
  changes to `validate.ts`/`format.ts` — plain unit tests, deps injected.
- Contract-level: fake `SearchBackend` implementations assert tool behavior per
  mode + `"none"` path + scrape/crawl routing to Firecrawl; transport tests for
  the two routes mirror `workspace-plugins.test.ts` / heartbeat route tests.
- Rollout: default `"firecrawl"` = byte-for-byte today's behavior; no migration.
  The map-mode removal is the one behavior change for agents that relied on it
  (crawl-with-limit is the replacement).
