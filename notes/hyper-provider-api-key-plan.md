# Plan — Hyper (charm.land) Provider / API Key Support

> **Status: PLANNING ONLY.** This document is an implementation plan. No code is
> changed by this plan. It is committed to `feature/hyper-provider-api-key` and
> must NOT be merged or pushed.
>
> **Secret handling:** This plan never references, requests, or stores any real
> API key. The runtime reads the key from the `HYPER_API_KEY` environment
> variable only; the plan documents the variable name and the `sk-hyper-` prefix
> convention (public, from Hyper's docs) — never a key value.

## 1. Goal

Add **Hyper** (Charm’s inference platform, https://hyper.charm.land) as a new
**provider** + **credential** in Dispatch, so that:

- When `HYPER_API_KEY` is set, a `hyper` **provider** registers and a `hyper`
  **credential** is listed.
- `GET /models` enumerates Hyper’s catalog as `hyper/<model>` entries with
  per-model `contextWindow` and `vision` metadata.
- `POST /chat` with `model: "hyper/<model>"` streams a turn (text + reasoning +
  tool calls) against Hyper’s OpenAI-compatible Chat Completions endpoint.
- The web frontend and CLI pick Hyper up automatically (they are
  provider-agnostic).

Vocabulary follows `GLOSSARY.md`: **provider** (the extension wrapping the LLM
backend), **credential** (the named `hyper` profile binding the name to the
provider and holding its key/baseURL, owned by `credential-store`), **key** (the
`HYPER_API_KEY` secret string), **model name** (`hyper/<model>`), **model
catalog** (`GET /models`), **reasoning effort** (the `low|medium|high|xhigh|max`
ladder, `ReasoningEffort` in `@dispatch/wire`).

## 2. Provider research findings (Hyper)

Sources: Hyper docs (scraped 2026-08-20) —
- Overview: https://hyper.charm.land/docs/
- Authentication: https://hyper.charm.land/docs/api/authentication.html
- List Models: https://hyper.charm.land/docs/api/list-models.html
- OpenAI Chat Completions: https://hyper.charm.land/docs/api/openai-chat-completions.html
- Anthropic Messages: https://hyper.charm.land/docs/api/anthropic-messages.html
- Catalog (third-party): https://models.dev/providers/hyper/

**Facts:**

| Item | Value |
|---|---|
| Base URL | `https://hyper.charm.land/v1` |
| API key | starts with `sk-hyper-`, env var `HYPER_API_KEY` |
| Auth header | `Authorization: Bearer sk-hyper-…` (also `X-Api-Key` on `/v1/messages`) |
| Models endpoint | `GET /v1/models` — **OpenAI format, no auth required** |
| Chat completions | `POST /v1/chat/completions` — OpenAI-compatible (standard params: `temperature`, `max_tokens`, `tools`, `top_p`, `stop`, `stream`) |
| Streaming | SSE `data:` lines, ends with `data: [DONE]`; `stream_options.include_usage` supported (usage in final chunk) |
| Anthropic messages | `POST /v1/messages` — Anthropic-compatible (uses `x-api-key` + `anthropic-version`) |
| Responses API | `POST /v1/responses` — OpenAI Responses API (used by Codex) |
| Error format | OpenAI error shape `{ error: { message, type, code } }` |

**`GET /v1/models` response shape (OpenAI `list` + Hyper extensions):**

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "created": 1784045313,
      "owned_by": "hyper",
      "display_name": "DeepSeek-V4-Pro",
      "context_window": 1000000,
      "max_output_tokens": 384000,
      "capabilities": { "vision": false },
      "reasoning": {
        "effort_levels": [ { "value": "high", "display": "High" }, { "value": "xhigh", "display": "X-High" } ],
        "default_effort_level": "high"
      },
      "pricing": { "input": 2.4, "output": 4.8, "cache_create": 0, "cache_hit": 0.2 }
    }
  ]
}
```

Fields relevant to Dispatch: `id` → `ModelInfo.id`; `display_name` →
`ModelInfo.displayName`; `context_window` → `ModelInfo.contextWindow`;
`capabilities.vision` → `ModelInfo.vision`. Fields **not consumable today**:
`max_output_tokens`, `reasoning.effort_levels`, `reasoning.default_effort_level`,
`pricing` — `ModelInfo` (`packages/kernel/src/contracts/provider.ts`) has no
slots for these. Surfacing them is out of scope (a future `ModelInfo` extension).

**Custom usage fields** in chat completion responses: `usage.cost.usd`,
`usage.cost.hypercredits`, `usage.remaining.hypercredits`. The existing
`@dispatch/openai-stream` SSE usage parser
(`packages/openai-stream/src/stream.ts`) reads only `prompt_tokens` /
`completion_tokens` / `cache_read_tokens` / `cache_write_tokens`, so Hyper’s
extra fields are ignored — no change needed.

**Catalog (models.dev, 26 models):** includes `deepseek-v4-flash`,
`deepseek-v4-pro`, `glm-5`, `glm-5.1`, `glm-5.2`, `kimi-k2.5/k2.6/k2.7-code/k3`,
`qwen3.6-flash/plus/max`, `qwen3.7-flash/plus/max`, `qwen3.8-max`,
`gpt-oss-120b`, `gemma-4-26b-a4b-it`, `llama-4-maverick-17b`, `llama-3.3-70b`,
`minimax-m2.7/m3`, etc. Many report reasoning + tool calls. The default model
proposed below (`deepseek-v4-flash`) is Hyper’s own quickstart example and the
cheapest reasoning model.

**Error status mapping (Hyper):** 400 invalid request; 401 auth; **402 billing
( insufficient Hypercredits )**; 403 permission; 404 model not found; 429 rate
limit; 5xx upstream. The stream error handler in `stream.ts` sets
`retryable: response.status >= 500 || response.status === 429` — so 402 is
non-retryable (correct: a billing exhaustion is not transient).

## 3. Architecture fit & approach

Hyper’s Chat Completions endpoint is **OpenAI-compatible**, exactly the shape
`@dispatch/openai-stream`’s `createOpenAICompatProvider` targets. The cleanest
fit is a **new self-contained provider extension**, `packages/provider-hyper`,
mirroring `packages/provider-umans` and `packages/provider-longcat` (the two
existing self-contained OpenAI-compatible providers that read their own env
keys). This requires **no kernel-contract changes** and **no
`credential-store`/`transport-http`/`transport-contract` changes** — the
extension registers a `ProviderContract` via `host.defineProvider`, and the
existing catalog aggregation + `GET /models` serialization pick it up
automatically.

### 3.1 Why no contract changes

- `ProviderContract` (`packages/kernel/src/contracts/provider.ts`) is the only
  cross-unit surface a provider exposes; `createOpenAICompatProvider` already
  returns one. No new contract.
- `credential-store` (`packages/credential-store/src/registry.ts`) is built from
  a `credentials: { name, providerId }[]` list assembled in `host-bin`
  (`packages/host-bin/src/main.ts`). Adding `{ name: "hyper", providerId: "hyper" }`
  is a composition-root edit, not a `credential-store` code change.
- `GET /models` serialization (`packages/transport-http/src/app.ts`, lines ~343–357)
  maps `credentialStore.listCatalogDetailed()` → `{ models: [...names], modelInfo: { [name]: { contextWindow?, vision? } } }`.
  It already forwards `vision` (when `=== true`) and `contextWindow` from each
  provider’s `ModelInfo`. So a correct `listModels` from `provider-hyper` flows
  end-to-end with zero transport changes.
- The web frontend is **provider-agnostic** (see §6): no FE code changes
  required.

### 3.2 Model-list parsing decision (recommended vs. alternatives)

Hyper’s `/v1/models` is **standard OpenAI `{ object: "list", data: [...] }`** with
**additive** Hyper fields (`capabilities.vision`, `display_name`, `reasoning`,
`pricing`, `max_output_tokens`). The generic `listModels` in
`packages/openai-stream/src/listModels.ts` already hits `/models` and parses
`data[]` via `parseModelList`, which reads `context_window` (one of its fallback
field names — so `contextWindow` already populates correctly for Hyper) and
guesses `vision` via the **Umans-specific** name heuristic `isVisionModelId`
(checks for `"umans-kimi"`/`"umans-qwen"`) — which matches **no** Hyper model, so
every Hyper model would be reported non-vision. `display_name` is not read at
all.

**Recommended approach — enhance the generic `parseModelList` (additive):**
extend `OpenAIModelEntry` with optional `capabilities?: { vision?: boolean }` and
`display_name?: string`, and in `parseModelList` set
`vision = entry.capabilities?.vision ?? isVisionModelId(entry.id)` and
`displayName = entry.display_name`. This is **backward-compatible** (fields are
optional; the vision fallback to the name heuristic preserves existing behavior
for `provider-openai-compat`/`provider-longcat`, whose `/models` endpoints don’t
carry `capabilities.vision`). It benefits Hyper and any future provider that
includes these now-common extensions, with **no provider-specific code**. With
this, `provider-hyper` uses `createOpenAICompatProvider` with the **default**
`listModels` (like `provider-longcat`) and gets correct vision + display names +
context window for free.

**Alternative A — a Hyper-local custom `listModels`** in `packages/provider-hyper`
(e.g. `listHyperModels`/`parseHyperModelList`) passed via
`createOpenAICompatProvider({ listModels })`. Keeps the shared library untouched
and the package self-contained (no cross-package compile dep), at the cost of
duplicating the standard `/models` fetch + parse. Choose this if we want **zero**
shared-library changes.

**Alternative B — put `listHyperModels` in `@dispatch/openai-stream`** (mirroring
how `listUmansModels`/`parseUmansModelInfo` live there today). Follows the
existing precedent but further pollutes the generic library with another
provider’s specifics (the `listUmansModels` precedent is arguably itself a smell,
since it reads an Umans-only `/models/info` endpoint). Not recommended unless
matching that precedent is explicitly preferred.

**Recommendation:** the generic `parseModelList` enhancement. It is the smallest,
cleanest change and avoids provider-specific library code.

### 3.3 Reasoning-effort decision

Many Hyper models support reasoning; `/v1/models` reports per-model
`reasoning.effort_levels` (the example shows `high` and `xhigh`). Dispatch’s
`ReasoningEffort` ladder is `low|medium|high|xhigh|max`. The established pattern
(`packages/provider-umans/src/reasoning.ts`) is a pure `mapReasoningEffort` +
`transformBody` that adds `reasoning_effort` to the Chat Completions body when a
resolved effort is present.

**Open question (Unknown #1, §8):** the exact wire param name and accepted
values for Hyper’s `/v1/chat/completions` are not confirmed by the scraped docs
(the docs say “all standard parameters accepted” and the model metadata exposes
effort levels, strongly implying a `reasoning_effort` body field, but the precise
value set and whether `max` is supported or capped to `xhigh` must be confirmed
live). The plan assumes a `reasoning_effort` body field with values
`low|medium|high|xhigh`, mapping Dispatch’s `max` → `xhigh` (Hyper appears to
support `xhigh` natively, unlike Umans which caps to `high`). This mapping is the
single most likely thing to need adjustment after live confirmation.

**Open question (Unknown #2, §8):** whether sending `reasoning_effort` to a
**non-reasoning** Hyper model (e.g. `llama-3.3-70b`) is a no-op or a 400. The
provider does not know per-model reasoning capability at `stream` time
(`ModelInfo` isn’t passed to `stream`), so `transformBody` would emit
`reasoning_effort` whenever a resolved effort is present — same as the existing
Umans behavior. If Hyper 400s on non-reasoning models, a mitigation is needed
(see §8). Must be confirmed live.

### 3.4 Out of scope for this plan

- **Anthropic Messages endpoint (`/v1/messages`)** and **Responses API
  (`/v1/responses`)**: the kernel `ProviderContract.stream` is an OpenAI-style
  streaming interface; every existing provider uses Chat Completions. Wiring a
  second, Anthropic-format channel for the same provider is a larger design
  change and is **not** required to use Hyper for coding. Noted as a future
  option only.
- Surfacing `max_output_tokens` / `reasoning.effort_levels` / `pricing` in
  `ModelInfo` (would require a `ModelInfo` contract change + transport-contract
  `ModelMetadata` change + FE consumption — a separate effort).

## 4. Affected areas — backend

### 4.1 NEW package: `packages/provider-hyper/`

Mirror `packages/provider-umans` (with reasoning) / `packages/provider-longcat`
(without). Files:

| File | Purpose | Template |
|---|---|---|
| `package.json` | `@dispatch/provider-hyper`, deps `@dispatch/kernel` + `@dispatch/openai-stream` (workspace) | `packages/provider-umans/package.json` |
| `tsconfig.json` | extends `../../tsconfig.base.json`, `composite`, references `../kernel` + `../openai-stream` | `packages/provider-umans/tsconfig.json` |
| `src/extension.ts` | `manifest` (`id: "provider-hyper"`, `name: "Hyper"`, `apiVersion: "^0.1.0"`, `trust: "bundled"`, `activation: "eager"`, `capabilities: { network: true }`, `contributes: { providers: ["hyper"] }`) + `activate(host, env = process.env)` reading `host.config.get<string>("provider.hyper.model")`, resolving via `resolveHyperConfig`, building `ApiKeyCredentials`, `createOpenAICompatProvider({ credentials, model, id: "hyper", transformBody })`, `host.defineProvider(provider)`. No key → `host.logger.warn("provider-hyper: no HYPER_API_KEY. Provider not registered.")` + return. | `packages/provider-umans/src/extension.ts` |
| `src/resolver.ts` | Pure `resolveHyperConfig(env, configModel): HyperConfig \| null` with precedence `apiKey: HYPER_API_KEY` (unset/empty → null), `baseURL: HYPER_BASE_URL ?? "https://hyper.charm.land/v1"`, `model: configModel ?? HYPER_MODEL ?? "deepseek-v4-flash"`; `toHyperCredentials(cfg)`; `HyperConfig`, `EnvSource` types. | `packages/provider-umans/src/resolver.ts` |
| `src/reasoning.ts` | Pure `mapReasoningEffort(effort)` (Dispatch → Hyper values; `max`→`xhigh` pending confirmation) + `transformBody(body, opts)` adding `reasoning_effort` when present, `{}` otherwise (byte-stable). | `packages/provider-umans/src/reasoning.ts` |
| `src/index.ts` | Re-exports `activate`, `extension`, `manifest`, `mapReasoningEffort`, `transformBody`, `resolveHyperConfig`, `toHyperCredentials`, `HyperConfig`, `EnvSource`. | `packages/provider-umans/src/index.ts` |
| `src/resolver.test.ts` | Pure tests: base-URL override/default; model precedence config→env→default; null on unset/empty key. | `packages/provider-umans/src/resolver.test.ts` |
| `src/extension.test.ts` | Fake `HostAPI` (mock only the outermost edge: `defineProvider`/`config`/`logger` via `vi.fn`); asserts registers `id:"hyper"` when key set; warns + does not register when unset; `dependsOn` undefined; contributes `["hyper"]` + `network` capability. | `packages/provider-umans/src/extension.test.ts` |
| `src/reasoning.test.ts` | Pure tests for `mapReasoningEffort` (all ladder values) + `transformBody` (adds field / byte-stable empty). | `packages/provider-umans/src/reasoning.test.ts` |

**Testing convention (AGENTS.md asymmetric testing):** the resolver and reasoning
tests are pure (zero mocks); the extension test mocks only the outermost edge
(the `HostAPI`), never `@dispatch/*` internals — exactly the established pattern.

**Note on `listModels`:** with the recommended §3.2 approach, `provider-hyper`
uses the **default** `listModels` from `createOpenAICompatProvider` (no custom
callback). If Alternative A is chosen instead, add `src/listModels.ts` +
`src/listModels.test.ts` and pass `listModels: listHyperModels` into
`createOpenAICompatProvider`.

### 4.2 MODIFY: `packages/openai-stream/src/listModels.ts` (recommended §3.2)

- Extend `OpenAIModelEntry` with `capabilities?: { vision?: boolean }` and
  `display_name?: string` (additive, optional).
- In `parseModelList`: `vision = entry.capabilities?.vision ?? isVisionModelId(entry.id)`;
  carry `displayName = entry.display_name` when present.
- No change to the `listModels()` fetch (still `GET ${baseURL}/models` with
  `Authorization: Bearer …`). Hyper’s `/v1/models` is public (no auth required),
  but sending a bearer header to a public endpoint is harmless.

**MODIFY: `packages/openai-stream/src/listModels.test.ts`** — add cases asserting
`capabilities.vision` is surfaced (and overrides the name heuristic when present),
`display_name` → `displayName`, and that absent fields preserve prior behavior
(regression guard for `provider-openai-compat`/`provider-longcat`).

### 4.3 MODIFY: `packages/host-bin/src/main.ts` (implementation — host-bin owner)

- Import: `import { extension as providerHyperExt } from "@dispatch/provider-hyper";`
- Add `providerHyperExt` to `CORE_EXTENSIONS` (alongside `providerUmansExt` /
  `providerLongcatExt`).
- In the credential-assembly block (after the `LONGCAT_API_KEY` block, ~line 258),
  add:
  ```ts
  if (process.env.HYPER_API_KEY) {
    credentials.push({ name: "hyper", providerId: "hyper" });
    logger.info(`Registered credential "hyper" → hyper provider`);
  }
  ```
  This mirrors the umans/longcat blocks exactly. The credential is only listed
  when the key is set; the provider itself self-degrades (registers nothing) when
  the key is absent, and `listCatalog` gracefully skips a credential whose
  provider is missing.

### 4.4 `packages/host-bin/src/config.ts` — NO change required

Matches the umans/longcat pattern: `activate` reads
`host.config.get<string>("provider.hyper.model")` as an override hook, and
`resolveHyperConfig` falls back to the `HYPER_MODEL` env var then the default.
`config.ts` does not map any env var to `provider.hyper.model` for umans/longcat
either, so no change is needed for parity. (Optional, not recommended for MVP:
add a `DISPATCH_HYPER_MODEL → provider.hyper.model` mapping like the
`DISPATCH_ANTHROPIC_MODEL` one — only if a shared-base-URL/default-model style
like OpenCode’s is ever wanted, which it isn’t here.)

## 5. Affected areas — build / config / docs / ops (orchestrator’s lane)

These are build wiring, config, harness/docs, and operational shell scripts — the
orchestrator edits these directly (per ORCHESTRATOR.md §6). `bun.lock` is
regenerated by `bun install` after the workspace dep is added.

| File | Change |
|---|---|
| `tsconfig.json` (root) | Add `{ "path": "./packages/provider-hyper" }` to `references` (e.g. after `provider-umans`). |
| `packages/host-bin/tsconfig.json` | Add `{ "path": "../provider-hyper" }` to `references`. |
| `packages/host-bin/package.json` | Add `"@dispatch/provider-hyper": "workspace:*"` to `dependencies`. |
| `bun.lock` | Regenerate via `bun install` (auto; do not hand-edit). |
| `package.json` (root) | **No change** — `workspaces: ["packages/*"]` auto-discovers the new package. |
| `.env.example` | Add a Hyper section: `HYPER_API_KEY=sk-hyper-...`, optional `HYPER_BASE_URL=https://hyper.charm.land/v1`, optional `HYPER_MODEL=deepseek-v4-flash`. |
| `README.md` | Add Hyper to the `.env` example block and to the Packages table (`provider-hyper` row: “Hyper OpenAI-compatible provider (`hyper.charm.land/v1`); self-contained (reads `HYPER_API_KEY` from env)”). |
| `systemd/dispatch.env` | Add a commented Hyper section (`# HYPER_API_KEY=sk-hyper-...`) and update the `bin/sync-env`/`bin/setup-env` hint comment. |
| `bin/setup-env` | Add `HYPER_KEY` var; `--hyper-key` / `--hyper-key=` arg parsing; interactive prompt `Enter HYPER_API_KEY (or press Enter to skip):`; heredoc section `${HYPER_KEY:+HYPER_API_KEY=$HYPER_KEY}`; summary echo `${HYPER_KEY:+echo "  HYPER_API_KEY configured (value not echoed)"}`; update usage strings. Mirror the `--longcat-key` handling exactly. |
| `bin/sync-env` | Add `HYPER_KEY` var; `--hyper-key` / `--hyper-key=` arg parsing; interactive prompt; `# --- Update HYPER_API_KEY ---` sed-replace/append block (empty value → write empty line to disable, matching the umans/longcat block); summary echo; update usage strings. Mirror the `LONGCAT_API_KEY` block exactly. |

**bin scripts note:** `bin/setup-env` and `bin/sync-env` currently hardcode
per-provider key handling for OpenCode/Umans/LongCat (they are the lifecycle
scripts that write `/etc/dispatch/env` without ever echoing secret values). To
make Hyper a first-class production citizen it must be added to both. These are
shell scripts in the orchestrator’s ops lane. (Reference: the
`bin-script-conventions` skill — every operational command is a `bin/` script.)

## 6. Affected areas — frontend (`../frontend`, separate repo)

**No required frontend changes.** The frontend is provider-agnostic:
- `GET /models` returns `{ models: ["<key>/<model>", …], modelInfo: { [name]: { contextWindow?, vision? } } }`
  (`@dispatch/transport-contract` `ModelsResponse`/`ModelMetadata`).
- `src/features/chat/model-select.ts` builds the key/model dropdowns dynamically
  from whatever the catalog returns (`modelKeys`, `modelsForKey`,
  `splitModelName`/`joinModelName`). The only provider-specific logic is
  **cosmetic**: numbered OpenCode keys are sorted numerically and labeled
  `OpenCode #<n>` (`openCodeNumber`/`isNumberedOpenCode`/`modelKeyLabel`); every
  other key is rendered as its raw id in first-seen order. A `hyper` credential
  therefore appears as key `hyper`, sorted after the numbered OpenCode keys, with
  label `hyper`.
- `vision` metadata flows through `modelInfo` to `isVisionModel` and the vision
  handoff (`src/features/vision`), so Hyper vision models are handled correctly
  with no FE change.

**Optional cosmetic (nice-to-have, NOT required, separate repo/harness):** add a
friendly label for the `hyper` key in `../frontend/src/features/chat/model-select.ts`
`modelKeyLabel` (e.g. `hyper` → `Hyper`), analogous to the `OpenCode #<n>` label.
This is a frontend-repo change done with the **frontend’s own** harness
(`../frontend/AGENTS.md` / `ORCHESTRATOR.md` / `.dispatch/`), not the backend
harness, and is explicitly out of scope for the backend work on this branch.

## 7. Verification plan

**Automated (orchestrator re-runs after implementation):**
```sh
bun run typecheck   # tsc -b --pretty — must be EXIT 0 (new package + refs resolve)
bun run test        # vitest — new provider-hyper + openai-stream tests pass; no regressions; note the pass-count delta
bun run check       # biome — must be clean
git status --short  # confirm changes stay within the expected lanes
```

**Unit/contract expectations:**
- `provider-hyper` resolver/reasoning tests: pure, zero mocks.
- `provider-hyper` extension test: mocks only the `HostAPI` edge; asserts
  `defineProvider` called with `id: "hyper"` when `HYPER_API_KEY` set, and not
  called + warn when unset.
- `openai-stream` `parseModelList` tests: `capabilities.vision` and
  `display_name` surfaced; absent fields preserve prior behavior (regression
  guard for the other two providers).
- No `@dispatch/kernel` contract change → no `lsp references` fan-out, no
  cross-unit contract breakage.

**Live boot probe (private instance — isolated data paths, per ORCHESTRATOR §8):**
```sh
mkdir -p /tmp/opencode/probe
BACKEND_PORT=4567 SURFACE_WS_PORT=4569 \
  DISPATCH_DB=/tmp/opencode/probe/dispatch.db \
  DISPATCH_TRACE_DB=/tmp/opencode/probe/traces.db \
  DISPATCH_JOURNAL=/tmp/opencode/probe/app.ndjson \
  HYPER_API_KEY=sk-hyper-... \
  bun packages/host-bin/src/main.ts &

# catalog: expect hyper/<model> entries with contextWindow + vision in modelInfo
curl -s localhost:4567/models | jq '.models | map(select(startswith("hyper/")))'
curl -s localhost:4567/models | jq '.modelInfo | to_entries | map(select(.key|startswith("hyper/")))'

# one turn (NDJSON stream); confirm text + reasoning + tool-call events
curl -s -X POST localhost:4567/chat -H 'content-type: application/json' \
  -d '{"conversationId":"c1","model":"hyper/deepseek-v4-flash","message":"Say hello in 3 words."}'
```
Confirm:
- `GET /models` lists `hyper/<model>` entries; `modelInfo` carries `contextWindow`
  and `vision: true` for any vision-capable Hyper model.
- `POST /chat` streams `text-delta` (and `reasoning-delta` for reasoning models
  when reasoning effort is set); tool calls work for tool-capable models.
- `getUsage` returns `undefined` gracefully (Hyper likely has no
  `/v1/usage` with `concurrent_sessions`) — the concurrency limiter falls back to
  cooldown-only slot recycling; no crash, no surprising shape. (Unknown #4.)
- A 402 (exhausted Hypercredits) surfaces as a non-retryable provider error
  (correct).

**Process cleanup (ORCHESTRATOR §8 bracket trick):**
```sh
pkill -9 -f '[h]ost-bin/src/main.ts'
pkill -9 -f '[o]bservability-collector/src/main'
ps -eo pid,args | grep '[h]ost-bin/src/main.ts'
```

## 8. Unknowns to confirm (before/during implementation)

1. **`reasoning_effort` wire param + accepted values.** Confirm the exact body
   field name and value set for `/v1/chat/completions` (assumed `reasoning_effort`
   with `low|medium|high|xhigh`). Confirm whether `max` is supported or must be
   capped (assumed `max`→`xhigh`, since Hyper exposes `xhigh` natively). Verify
   via a live request or Hyper’s `/docs/llms-full.txt`. This directly shapes
   `src/reasoning.ts` `mapReasoningEffort`.
2. **`reasoning_effort` on non-reasoning models.** Some Hyper models lack
   reasoning (e.g. `llama-3.3-70b`, `qwen3-coder-480b`). The provider emits
   `reasoning_effort` whenever a resolved effort is present (it cannot tell
   per-model at `stream` time). Confirm whether Hyper no-ops or returns 400. If
   400, mitigation options: (a) omit `reasoning_effort` by default and only send
   it when the user explicitly sets a non-default effort; (b) document the
   constraint; (c) a future `ModelInfo`-driven per-model gate (out of scope).
   Confirm live.
3. **Vision capability across the live catalog.** Confirm which Hyper models
   report `capabilities.vision: true` (the scraped example shows `false` for
   `deepseek-v4-pro`; models.dev doesn’t surface a clean vision column). Verify
   via `GET /v1/models`. This validates the §3.2 vision parsing.
4. **`getUsage` endpoint.** Confirm Hyper has no `/v1/usage` returning
   `concurrent_sessions` (the generic `getUsage` will then return `undefined`,
   which is the designed fallback). If Hyper does expose a compatible usage
   endpoint, no change is needed (it works automatically); if it exposes an
   incompatible shape, still `undefined` (safe).
5. **`stream_options.include_usage` + usage parsing.** Confirm the streaming
   final-chunk usage uses `prompt_tokens`/`completion_tokens` (Hyper docs say
   usage appears in the final chunk when `include_usage` is enabled). Hyper’s
   custom `usage.cost`/`usage.remaining` fields are ignored by the existing
   parser — confirm no parse error.
6. **`max_output_tokens` not surfaced.** Hyper reports it; `ModelInfo` has no
   slot. Known limitation, out of scope. (A future `ModelInfo.maxOutputTokens` +
   `ModelMetadata` + FE change could surface it.)
7. **Key prefix validation.** Recommend **not** validating the `sk-hyper-` prefix
   in `resolveHyperConfig` — match umans/longcat, which only check non-empty.
   Confirm this is acceptable (a wrong-prefix key will simply fail upstream with
   a 401, which is clear enough).

## 9. Orchestration / wave plan (for eventual implementation — not executed now)

Per ORCHESTRATOR.md: one owner-agent per unit; disjoint units run in parallel;
the orchestrator edits contracts/build-config/harness, and **summons** owning
agents for implementation `.ts` (including `host-bin/src/main.ts`). No kernel
contract change is needed, so there is no contract-seam to pre-author.

- **Wave 1 (parallel, disjoint files):**
  - **Unit A — `packages/openai-stream/`**: enhance `parseModelList` +
    `OpenAIModelEntry` (capabilities.vision, display_name) + `index.ts` (no new
    export needed — `parseModelList` is already exported) + `listModels.test.ts`.
    Scoped rules: `pure-core.md`, `no-internal-mocks.md` (this is a pure-core
    library), `one-owner.md`, `isolation-over-dry.md`, `biome-clean.md`.
  - **Unit B — `packages/provider-hyper/`** (new): full self-contained package
    per §4.1. It uses `createOpenAICompatProvider` (existing surface) with the
    **default** `listModels`, so it has **no compile-time dependency** on Unit A’s
    additive change (the enhanced parsing is runtime behavior of the shared
    default `listModels`). Truly parallel/disjoint. Scoped rules: base
    `package-agent.md` + `extension-agent.md` + `one-owner.md` +
    `isolation-over-dry.md` + `biome-clean.md` + `extension-logging.md`
    (self-redact the `HYPER_API_KEY` in its own logging code) +
    `typed-handles.md` only if it couples via hooks/services (it does not — it
    only calls `host.defineProvider`).
- **Wave 2 (after Wave 1 is green):**
  - **Orchestrator (direct lane):** root `tsconfig.json` + `packages/host-bin/tsconfig.json`
    + `packages/host-bin/package.json` + `bun.lock` (regen) + `.env.example` +
    `README.md` + `systemd/dispatch.env` + `bin/setup-env` + `bin/sync-env`.
  - **Summon host-bin owner-agent:** edit `packages/host-bin/src/main.ts`
    (import + `CORE_EXTENSIONS` + `hyper` credential registration per §4.3).
- **Wave 3 (optional, separate repo):** frontend `modelKeyLabel` cosmetic in
  `../frontend` using the frontend harness (only if desired).

After each wave: read reports, run §7 checks once for the wave, commit the
milestone with a test count, update `tasks.md`.

## 10. File reference index

Backend (existing, cited):
- `packages/kernel/src/contracts/provider.ts` — `ProviderContract`, `ModelInfo`, `ProviderStreamOptions`, `ProviderUsage`.
- `packages/kernel/src/contracts/auth.ts` — `ApiKeyCredentials`.
- `packages/kernel/src/contracts/extension.ts` — `Manifest`, `HostAPI.defineProvider`.
- `packages/openai-stream/src/provider.ts` — `createOpenAICompatProvider` (the factory to reuse).
- `packages/openai-stream/src/listModels.ts` — `listModels`, `parseModelList`, `OpenAIModelEntry`, `isVisionModelId` (the file to enhance per §3.2/§4.2).
- `packages/openai-stream/src/stream.ts` — `streamChat` (handles `delta.reasoning_content`, `reasoning_effort` via `transformBody`, usage parsing; no change needed).
- `packages/openai-stream/src/getUsage.ts` — generic `/v1/usage` fetch (returns `undefined` fallback; Unknown #4).
- `packages/provider-umans/src/{extension,resolver,reasoning,index}.ts` + tests — primary template.
- `packages/provider-longcat/src/{extension,resolver}.ts` + tests — simpler template (no reasoning).
- `packages/credential-store/src/registry.ts` — `Credential`, `CatalogEntry`, `listCatalogDetailed` (no change).
- `packages/credential-store/src/extension.ts` — `createCredentialStoreExtension({ credentials })` (no change).
- `packages/host-bin/src/main.ts` — composition root; `CORE_EXTENSIONS` + credential assembly (the implementation edit, §4.3).
- `packages/host-bin/src/config.ts` — `envToConfigMap` (no change needed, §4.4).
- `packages/transport-http/src/app.ts` — `GET /models` serialization (no change).
- `packages/transport-contract/src/index.ts` — `ModelsResponse`, `ModelMetadata` (no change).
- `tsconfig.json`, `tsconfig.base.json`, `packages/provider-umans/tsconfig.json`, `packages/host-bin/tsconfig.json` — build graph.
- `.env.example`, `README.md`, `systemd/dispatch.env`, `bin/setup-env`, `bin/sync-env` — env/docs/ops.

Frontend (existing, cited — separate repo):
- `../frontend/src/features/chat/model-select.ts` — provider-agnostic model picker helpers (`modelKeys`, `modelKeyLabel`, `isVisionModel`).
- `../frontend/src/features/chat/ui/ModelSelector.svelte` — consumes `models` + `modelInfo` props.
- `../frontend/src/app/store.svelte.ts` — fetches `GET /models`.

Provider documentation (scraped 2026-08-20):
- https://hyper.charm.land/docs/ — overview, key format `sk-hyper-`, `export HYPER_API_KEY=…`.
- https://hyper.charm.land/docs/api/authentication.html — `Authorization: Bearer`, `/v1/models` is public.
- https://hyper.charm.land/docs/api/list-models.html — `/v1/models` shape (capabilities.vision, context_window, display_name, reasoning, pricing).
- https://hyper.charm.land/docs/api/openai-chat-completions.html — `/v1/chat/completions`, standard params, SSE streaming, custom usage fields, error table (incl. 402 billing).
- https://hyper.charm.land/docs/api/anthropic-messages.html — `/v1/messages` (out of scope).
- https://hyper.charm.land/docs/coding-agents/opencode.html — confirms OpenAI-compatible endpoint usage.
- https://models.dev/providers/hyper/ — third-party catalog (26 models, `@ai-sdk/openai-compatible`, base `https://hyper.charm.land/v1`).
