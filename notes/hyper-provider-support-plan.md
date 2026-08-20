# Plan: Hyper provider support

**Status:** proposed; planning only (no provider code or secret has been added)
**Prepared:** 2026-08-20
**Feature branch:** `feature/hyper-provider-support`
**Primary scope:** backend; no frontend implementation is required for the baseline

## 1. Goal

Add Hyper (`https://hyper.charm.land`) as a bundled, optional Dispatch provider so that:

- a non-empty `HYPER_API_KEY` registers one provider and one credential named `hyper`;
- `GET /models` exposes Hyper's live catalog as `hyper/<model-id>` model names;
- Hyper model context-window and native-vision metadata flow into Dispatch's existing model catalog;
- turns selected with a `hyper/<model-id>` model use Hyper's OpenAI-compatible streaming Chat Completions endpoint, including tools, reasoning deltas when returned, token usage, and existing retry handling;
- development and systemd secret-management scripts can add, replace, and remove the key without committing it;
- the provider remains absent, with a clear secret-free warning, when no key is configured.

## 2. Confirmed external API contract

Hyper's official documentation and live public model endpoint establish the integration contract:

| Concern | Confirmed behavior | Dispatch implication |
|---|---|---|
| Base URL | `https://hyper.charm.land/v1` | Use this as `HYPER_BASE_URL`'s default. |
| Authentication | `Authorization: Bearer sk-hyper-...` | Existing `ApiKeyCredentials` and OpenAI stream adapter already send the correct header. Do not enforce the documented prefix in code; require only a non-empty value so future key formats and test keys remain valid. |
| Inference | `POST /v1/chat/completions` | Reuse `@dispatch/openai-stream`; do not implement a second HTTP/SSE stack. |
| Request compatibility | OpenAI-compatible; standard parameters include `temperature`, `max_tokens`, and `tools` | Existing message, image, tool, temperature, and max-token conversion is the correct baseline. |
| Streaming | SSE `data:` chunks ending in `data: [DONE]` | Existing SSE parser is compatible. |
| Streaming usage | Final chunk includes usage when `stream_options.include_usage` is enabled | Existing adapter already requests this and parses token counts. Hyper-specific cost and balance fields can be ignored without losing standard token usage. |
| Models | Public `GET /v1/models`, OpenAI list shape | Existing model-list fetch can be reused. Sending the bearer header is unnecessary but valid and keeps the generic adapter unchanged. |
| Model metadata | Entries include `context_window` and `capabilities.vision` | Extend the generic OpenAI model mapper to honor the explicit vision capability; it already reads `context_window`. Do not infer Hyper vision from model names. |
| Errors | Standard OpenAI error body; 429 and 5xx are transient classes | Existing stream adapter already marks HTTP 429 and 5xx retryable. HTTP 402 remains terminal, which is correct for insufficient Hypercredits. |
| Upstream concurrency usage | The published API documents `/v1/credits`, not the `/v1/usage` concurrent-session shape expected by Dispatch | The Hyper provider must not advertise `ProviderContract.getUsage`; Dispatch's concurrency extension will use its existing cooldown/local-accounting fallback. |

### Primary sources

1. [Hyper documentation](https://hyper.charm.land/docs/) — base URL, environment-variable name, OpenAI compatibility, and basic request example.
2. [Authentication](https://hyper.charm.land/docs/api/authentication.html) — bearer header and public models endpoint.
3. [OpenAI Chat Completions](https://hyper.charm.land/docs/api/openai-chat-completions.html) — request parameters, SSE behavior, usage fields, and errors.
4. [List Models](https://hyper.charm.land/docs/api/list-models.html) — response schema, context window, vision capability, and reasoning metadata.
5. [Live models endpoint](https://hyper.charm.land/v1/models) — confirms the documented list shape as of 2026-08-20. The catalog is dynamic and must never be copied into source code.

Relevant official excerpts:

- "Hyper speaks OpenAI and Anthropic out of the box. Swap the base URL, drop in your key, and go."
- "OpenAI-compatible chat completions. All standard parameters are accepted."
- "Returns all available models in OpenAI format. No authentication required."
- `capabilities.vision`: "Whether the model supports vision (image attachments)."

## 3. Existing Dispatch path to reuse

The proposed path is:

```text
/etc/dispatch/env (or an injected process environment)
  HYPER_API_KEY
        |
        v
provider-hyper extension
  resolve config -> ApiKeyCredentials -> createOpenAICompatProvider
        |
        +--> ProviderContract id "hyper"
        |      stream()     -> POST https://hyper.charm.land/v1/chat/completions
        |      listModels() -> GET  https://hyper.charm.land/v1/models
        |      getUsage     -> omitted (unsupported upstream contract)
        |
        v
host-bin credential { name: "hyper", providerId: "hyper" }
        |
        v
credential-store model catalog
        |
        v
GET /models -> hyper/<model-id> + contextWindow/vision metadata
        |
        v
existing frontend generic key/model selector
```

The closest repository precedents are:

- `packages/provider-longcat`: simple, self-contained OpenAI-compatible provider;
- `packages/provider-umans`: OpenAI-compatible provider with provider-specific model metadata/reasoning behavior;
- `packages/openai-stream`: shared Chat Completions transport, SSE parser, models fetch, and usage adapter;
- `packages/host-bin/src/main.ts`: bundled-provider registration and credential assembly.

## 4. Design decisions

### 4.1 Add a dedicated bundled extension

Create `@dispatch/provider-hyper` rather than treating Hyper as another numbered OpenCode key. Hyper has its own credential identity, default endpoint, catalog metadata, and operational key name. A dedicated extension preserves provider isolation and follows the existing Umans/LongCat architecture.

Use these stable identifiers:

- extension/package: `provider-hyper` / `@dispatch/provider-hyper`;
- provider id: `hyper`;
- credential name: `hyper`;
- environment variables: `HYPER_API_KEY`, `HYPER_BASE_URL`, `HYPER_MODEL`;
- host config key: `provider.hyper.model`.

No glossary entry is needed: **provider**, **credential**, **key**, **model name**, and **model catalog** are already canonical terms.

### 4.2 Configuration precedence

Implement a pure resolver with this precedence:

```text
key:      HYPER_API_KEY (required and non-empty)
base URL: HYPER_BASE_URL -> https://hyper.charm.land/v1
model:    provider.hyper.model -> HYPER_MODEL -> deepseek-v4-flash
```

`deepseek-v4-flash` is the default because Hyper uses it in its official quick-start example. It is only the provider fallback when a request does not supply a model; selectable models still come entirely from the live endpoint.

Do not trim, print, persist, validate by prefix, or include the key in errors. Match current provider behavior: absent/empty key returns `null`; activation logs a secret-free warning and skips registration.

### 4.3 Reuse Chat Completions for the baseline

Use `createOpenAICompatProvider`; do not use Hyper's Anthropic-compatible Messages or OpenAI Responses endpoint in the initial integration. Dispatch's mature path already supports:

- text and OpenAI image content;
- system messages;
- tool definitions and streamed tool calls;
- `reasoning_content` deltas;
- final token usage;
- HTTP error classification and retry.

No Hyper-specific body transform is required for baseline provider support.

### 4.4 Do not pass Dispatch reasoning effort yet

Hyper's model response reports model-specific `reasoning.effort_levels` and a default, but the retrieved Hyper Chat Completions documentation does not explicitly define the request field or behavior for unsupported levels. The available levels also vary by model. Dispatch currently has one global ladder (`low | medium | high | xhigh | max`) and no per-model reasoning-capability contract.

Therefore:

- baseline Hyper support should omit a `transformBody` and let Hyper apply the selected model's default reasoning behavior;
- do not copy Umans' lossy `xhigh|max -> high` mapping, because Hyper explicitly exposes `xhigh` and `max` on some models;
- do not extend `ModelInfo`, transport contracts, or the frontend solely for reasoning metadata in this feature.

A follow-up can add model-aware reasoning effort after confirming Hyper's request field and defining how Dispatch handles a selected value absent from that model's reported levels. This avoids turning simple key support into a cross-repo contract migration.

### 4.5 Honor authoritative vision metadata generically

The generic `parseModelList` currently understands common context-window fields but only uses a narrow name heuristic for vision. Hyper supplies authoritative `capabilities.vision`; failing to read it would route images through vision handoff even for native-vision Hyper models.

Extend the generic OpenAI model entry shape to accept:

```ts
capabilities?: { vision?: boolean };
```

Mapping precedence must be:

1. if `capabilities.vision` is a boolean, emit that value as `ModelInfo.vision`;
2. otherwise retain the current name-based fallback for backward compatibility.

This is a shared-library enhancement, not Hyper identity leaking into the library. Add tests for explicit `true`, explicit `false`, and absent capability/fallback. Continue reading `context_window` as `contextWindow`.

`display_name`, pricing, max output, and reasoning metadata are outside baseline scope because Dispatch's current `GET /models` transport exposes only context-window and vision metadata. Do not add partially wired fields.

### 4.6 Omit unsupported upstream-usage capability

`createOpenAICompatProvider` currently always adds a generic `getUsage()` that calls `<baseURL>/usage` and expects `usage.concurrent_sessions`. Hyper's published API instead documents credits and does not document this concurrency shape.

Add a small backward-compatible factory opt-out, for example:

```ts
getUsage?: false;
```

Behavior:

- option absent: preserve the current generic `/usage` implementation for all existing providers;
- `false`: omit `ProviderContract.getUsage` entirely;
- Hyper passes `getUsage: false`.

Test both the preserved default and opt-out. This keeps the contract honest and prevents pointless authenticated 404 polling if a user configures a Hyper concurrency limit.

## 5. Implementation plan

### Phase A — Extend the shared OpenAI-compatible adapter

Modify:

- `packages/openai-stream/src/listModels.ts`
  - accept `capabilities.vision` in OpenAI-format model entries;
  - prefer explicit boolean capability over the existing fallback heuristic;
  - keep context-window precedence unchanged.
- `packages/openai-stream/src/listModels.test.ts`
  - test explicit `vision: true`;
  - test explicit `vision: false` (including a name that the fallback would otherwise mark true, proving explicit metadata wins);
  - test absent capability preserves existing behavior;
  - include a Hyper-shaped fixture with `context_window`.
- `packages/openai-stream/src/provider.ts`
  - add the backward-compatible `getUsage: false` opt-out;
  - conditionally include the contract method.
- `packages/openai-stream/src/provider.test.ts`
  - assert default providers still expose/use generic `getUsage`;
  - assert opt-out providers omit it.

Do not add the word `hyper` to generic runtime branches; Hyper-shaped data is acceptable in a test fixture, while production logic remains schema-based.

### Phase B — Add `@dispatch/provider-hyper`

Create:

```text
packages/provider-hyper/
├── package.json
├── tsconfig.json
└── src/
    ├── extension.ts
    ├── extension.test.ts
    ├── index.ts
    ├── resolver.ts
    └── resolver.test.ts
```

#### `resolver.ts`

Export:

- `EnvSource`;
- `HyperConfig`;
- `resolveHyperConfig(env, configModel)`;
- `toHyperCredentials(config)`.

Keep it pure. Constants should contain only non-secret defaults.

#### `extension.ts`

Define a bundled, eager, network-capable manifest contributing `providers: ["hyper"]`. Activation should:

1. read `provider.hyper.model` from host config;
2. resolve environment/config;
3. warn and return if the key is missing;
4. build API-key credentials;
5. call `createOpenAICompatProvider` with `id: "hyper"`, the resolved model, no body transform, and `getUsage: false`;
6. define the provider;
7. log only provider/model state, never the key.

#### Unit tests

Resolver tests:

- absent and empty `HYPER_API_KEY` return `null`;
- default base URL is exact;
- `HYPER_BASE_URL` overrides the default;
- model precedence is host config, then `HYPER_MODEL`, then `deepseek-v4-flash`;
- credentials contain the resolved key/base URL.

Activation tests:

- a non-empty key registers exactly one provider with id `hyper`;
- no key registers none and emits the expected secret-free warning;
- manifest has network capability, bundled trust, and the `hyper` provider contribution;
- registered provider has `listModels` and does not have `getUsage`.

Do not call Hyper or use the real key in unit tests.

### Phase C — Wire the package into the composition root

Modify:

- root `tsconfig.json`: add the `packages/provider-hyper` project reference near the other provider packages;
- `packages/host-bin/package.json`: add `@dispatch/provider-hyper: workspace:*`;
- `packages/host-bin/src/main.ts`:
  - import the Hyper extension;
  - add it to `CORE_EXTENSIONS` beside Umans and LongCat;
  - when `HYPER_API_KEY` is non-empty, add `{ name: "hyper", providerId: "hyper" }` to credential assembly and write a secret-free registration log;
  - do not add a credential when the provider will not register.
- `bun.lock`: regenerate through project-local `bun install`; never hand-edit it.

Follow the existing build graph rather than introducing dynamic loading. If TypeScript reports a missing project-reference edge, add `../provider-hyper` to `packages/host-bin/tsconfig.json`; otherwise keep that file consistent with the current Umans/LongCat wiring, which relies on the root build graph and workspace dependency.

Add or extract a small pure credential-assembly seam only if needed to test the new `HYPER_API_KEY -> hyper` entry without booting the full server. Avoid a broad `host-bin` refactor solely for test convenience.

### Phase D — Add operational key management and documentation

The key must live in `/etc/dispatch/env` for normal development/systemd operation. Never add its value to a tracked file.

Modify:

- `bin/setup-env`
  - accept `--hyper-key VALUE` and `--hyper-key=VALUE`;
  - optionally prompt for `HYPER_API_KEY` when interactive;
  - write `HYPER_API_KEY` only when configured;
  - report only “configured,” never any key characters;
  - include Hyper in usage/help and generated-file comments.
- `bin/sync-env`
  - accept the same flag forms;
  - distinguish “flag omitted” from “flag supplied with an empty value” so `--hyper-key ""` removes/disables the key;
  - update or append non-empty values without echoing them;
  - retain permissions behavior.
- `systemd/dispatch.env`
  - add a commented optional Hyper section and management command using placeholders only.
- `.env.example`
  - add commented direct-process examples for `HYPER_API_KEY`, optional `HYPER_BASE_URL`, and optional `HYPER_MODEL`; no real key.
- `README.md`
  - document provider enablement and `hyper/<model>` discovery;
  - add `provider-hyper` to the package/extension table;
  - describe the central `/etc/dispatch/env` path accurately rather than instructing users to commit or duplicate secrets.
- `bin/install`
  - include `HYPER_API_KEY` in the placeholder/setup guidance where provider examples are listed.

Optional overrides should be documented but do not need dedicated privileged-script flags: an operator can edit `HYPER_BASE_URL`/`HYPER_MODEL`, while `--hyper-key` handles the secret safely.

Shell-script tests are not currently established for these scripts. Validate with `bash -n` and manual test cases against a temporary copy or an injected env-file path if the scripts are first refactored to support one. Do not test by modifying the real `/etc/dispatch/env` automatically.

### Phase E — Frontend impact check (no code expected)

No frontend feature code or contract change is required for baseline support:

- the backend emits `hyper/<model-id>` through the existing `ModelsResponse`;
- `modelKeys()` already treats non-OpenCode credentials generically;
- `ModelSelector.svelte` renders any new key and models automatically;
- `modelInfo[fullName].vision` already controls the native-vision label;
- context-window metadata already feeds the current app store/compaction path.

After backend integration, run the frontend's existing live probe or manually refresh the app and confirm:

1. `hyper` appears in the key selector;
2. its model list matches `GET /models`;
3. a model reported as native vision displays the vision indicator;
4. selecting `hyper/<model-id>` persists and sends the exact model name.

Only open a frontend change if this smoke test reveals a generic-selector defect. Do not add Hyper-specific UI branches or labels.

## 6. Verification strategy

### 6.1 Static and automated verification

From the backend worktree, install project-local dependencies and run:

```bash
bun install
bun run typecheck
bun run test
bun run test:bun
bun run check
bash -n bin/setup-env
bash -n bin/sync-env
git status --short
```

At minimum, the new provider tests and touched shared-adapter tests must be green. The final implementation should leave a clean working tree after committing.

### 6.2 Live verification with the real key

Use the key only through the normal secret path; never put it in a command transcript, test fixture, Markdown file, commit, URL, or log. The human-run setup command should use a shell variable or interactive prompt rather than pasting the real value into retained history. The supported operational form will be:

```bash
sudo bin/sync-env --hyper-key "$HYPER_API_KEY"
```

Then restart the user-managed Dispatch process/service and verify:

1. Startup logs contain `Registered credential "hyper" -> hyper provider` (or the repository's Unicode-arrow equivalent) and provider/model registration, with no key material.
2. `GET /models` contains multiple `hyper/<id>` entries sourced from the live endpoint.
3. A representative entry carries the exact live `contextWindow`.
4. At least one live model with `capabilities.vision: true` carries `modelInfo["hyper/<id>"].vision: true`; a false model does not get a false-positive vision badge.
5. A text-only `POST /chat` using an exact `hyper/<id>` model streams text, usage, and a terminal done event.
6. A tool-using turn produces a valid tool call, tool result, and follow-up model step.
7. If a live native-vision model is available, an image turn reaches it without vision handoff and succeeds.
8. Temporarily removing the key causes the Hyper provider/credential to disappear cleanly while other providers still boot.
9. An invalid test key produces a terminal 401 without leaking the full key; do not run this check against a production conversation if it would create noisy traces.

Because the upstream catalog changes, select live test models by inspecting `/v1/models` instead of hardcoding IDs in integration tests.

### 6.3 Regression checks

Confirm existing providers are unchanged:

- numbered OpenCode credentials still register and list models;
- Umans' custom `/models/info` mapping still wins for Umans;
- LongCat still streams and retains generic usage behavior unless separately changed;
- explicit OpenAI-format `capabilities.vision` does not break the existing fallback tests;
- no kernel or transport ABI was changed.

## 7. Acceptance criteria

Implementation is complete when all of the following hold:

- [ ] No `HYPER_API_KEY`: Dispatch boots, logs a secret-free skip warning, and exposes no `hyper/*` models.
- [ ] Valid `HYPER_API_KEY`: provider id `hyper` and credential name `hyper` register exactly once.
- [ ] Hyper uses default base URL `https://hyper.charm.land/v1`, with environment override support.
- [ ] `GET /models` dynamically returns `hyper/<model-id>` entries without a hardcoded catalog.
- [ ] Hyper `context_window` and explicit `capabilities.vision` map correctly.
- [ ] Streaming text, reasoning deltas when supplied, tool calls, standard usage, finish reasons, and error/retry behavior use the shared adapter.
- [ ] Hyper does not advertise unsupported `getUsage` concurrency polling.
- [ ] Key setup/update/removal is supported without printing or committing the secret.
- [ ] Existing backend verification commands pass.
- [ ] The generic frontend displays and can select Hyper models without Hyper-specific code.
- [ ] No secret value appears in git diff, fixtures, reports, logs, or tests.

## 8. Explicit non-goals / follow-ups

Defer these unless separately requested:

- Anthropic Messages or OpenAI Responses transport for Hyper;
- surfacing Hypercredit balance/cost fields in Dispatch metrics/UI;
- exposing price, max-output-token, display-name, or per-model reasoning metadata through `ModelsResponse`;
- model-aware validation/mapping of Dispatch reasoning effort;
- multiple numbered Hyper credentials;
- a Hyper-specific frontend component, logo, ordering rule, or display branch;
- hardcoded model lists or capability guesses.

Potential follow-up: extend `ModelInfo` and `ModelMetadata` with supported reasoning efforts/default effort, then let the frontend restrict choices per selected model and let `provider-hyper` forward a verified `reasoning_effort` wire field. That should be designed as a cross-contract feature rather than smuggled into API-key support.

## 9. Risk and rollback

| Risk | Mitigation |
|---|---|
| Hyper changes its dynamic catalog | Always query `/v1/models`; no hardcoded production model list. |
| A model advertises inaccurate vision support | Treat the live explicit capability as authoritative, test both true/false, and retain vision handoff for false/absent. |
| Dispatch sends a reasoning level unsupported by a model | Baseline sends no Hyper-specific reasoning field. |
| Unsupported `/usage` polling creates errors/noise | Omit `getUsage` on Hyper via the factory opt-out. |
| Secret disclosure | Environment-only key, secret-free logs/errors, fake keys in tests, diff scan before commit. |
| Provider outage/rate limiting | Existing retry policy handles 429/5xx; the provider remains isolated from other credentials. |
| Frontend assumptions about provider names | Existing selector is generic; verify live before deciding any frontend change. |

Rollback is configuration-first: remove/empty `HYPER_API_KEY` and restart; the extension remains loaded but self-disables. Code rollback removes the host credential/import, package dependency/reference, and provider package. No database migration or persisted schema rollback is required. Existing conversations that selected `hyper/<model>` should then show that saved model as unavailable rather than silently falling back.

## 10. Expected implementation file inventory

### New

- `packages/provider-hyper/package.json`
- `packages/provider-hyper/tsconfig.json`
- `packages/provider-hyper/src/index.ts`
- `packages/provider-hyper/src/resolver.ts`
- `packages/provider-hyper/src/resolver.test.ts`
- `packages/provider-hyper/src/extension.ts`
- `packages/provider-hyper/src/extension.test.ts`

### Modified

- `packages/openai-stream/src/listModels.ts`
- `packages/openai-stream/src/listModels.test.ts`
- `packages/openai-stream/src/provider.ts`
- `packages/openai-stream/src/provider.test.ts`
- `packages/host-bin/package.json`
- `packages/host-bin/src/main.ts`
- `package.json` only if workspace metadata changes are required (the existing `packages/*` glob should already discover the package)
- `tsconfig.json`
- `bun.lock`
- `bin/setup-env`
- `bin/sync-env`
- `bin/install`
- `.env.example`
- `systemd/dispatch.env`
- `README.md`

### Expected unchanged

- kernel contracts;
- credential-store contracts/implementation;
- transport contracts and HTTP route shape;
- frontend source;
- database schemas/migrations.
