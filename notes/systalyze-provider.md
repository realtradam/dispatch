# Systalyze provider

**Added:** 2026-10-22
**Package:** `packages/provider-systalyze` (provider id `systalyze`)
**Scope:** backend only — providers are surfaced through the dynamic model
catalog (`GET /models`), so no frontend change is required.

## Upstream contract (verified live)

| Concern | Behavior |
|---|---|
| Base URL | `https://inference.systalyze.com/v1` (override `SYSTALYZE_BASE_URL`) |
| Auth | `Authorization: Bearer <key>` |
| Chat | `POST /v1/chat/completions`, OpenAI-compatible |
| Models | `GET /v1/models` — OpenAI list shape, **no** `context_window`/vision metadata |
| Usage endpoint | `GET /v1/usage` → HTTP 404 `unknown route` → provider omits `getUsage` |
| Streaming | SSE `data:` chunks + `data: [DONE]` |
| Reasoning deltas | `delta.reasoning` (string), **not** the standard `delta.reasoning_content` |
| Streaming usage | `stream_options.include_usage` is **ignored** — no final usage chunk |

## Key handling

- Primary env var `SYSTALYZE_API_KEY`; the vendor's documented `STLZ_API_KEY`
  is accepted as a fallback alias.
- Install/rotate: `bin/set-systalyze-key` (or `sudo bin/sync-env --systalyze-key "stlzi_..."`).
- Remove/disable: `sudo bin/sync-env --systalyze-key ""`.
- No key → provider is absent (warn only, not an error).

## Wiring points

- `packages/provider-systalyze` — manifest (`tier: providers`, bundled, eager,
  network capability, contributes `providers: ["systalyze"]`), resolver, tests.
- `packages/host-bin/src/bundled.ts` — extension registration.
- `packages/host-bin/src/main.ts` — credential `systalyze` → providerId `systalyze`.
- `tsconfig.json` + `packages/host-bin/package.json` — workspace reference/dep.
- `packages/openai-stream/src/parse-sse.ts` — generic `delta.reasoning` alias
  fallback (standard `reasoning_content` remains authoritative).

## Model naming

Models appear as `systalyze/<model-id>` (model ids contain slashes, e.g.
`moonshotai/Kimi-K3`). Default model is `moonshotai/Kimi-K3`; override with
`provider.systalyze.model` host config or `SYSTALYZE_MODEL`.
