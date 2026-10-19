# Plan: Provider image-count cap — fix HTTP 400 "Invalid request" on umans

## Problem

The umans endpoint rejects any `/v1/chat/completions` request containing **more than 8
`image_url` parts** with an opaque `400 {"error":{"type":"invalid_request_error","message":"Invalid request"}}`
(no field pointer, identical text for every invalid shape — verified by replay/bisect).

Two gaps in Dispatch allow such a request to be built:

1. **No per-model image-count cap exists.** `/v1/models/info` reports
   `supports_vision: true` for `umans-deepseek-v4.1-flash-1017-lab` (and others) but no
   max-image count. The only knob is the **global** `vision-settings.imageLimit`
   (default 10; currently 7), which is not model-aware.
2. **The limit is only enforced at turn start.** `session-orchestrator.ts` runs
   `visionHandoff.prepareForProvider([...history, userMsg], ...)` once per turn. Images
   appended **mid-turn** — the kernel's synthetic user-role image messages for
   `read_image` tool results (`packages/kernel/src/runtime/run-turn.ts` ~L816) — never
   pass through any compaction. With `imageLimit = L`, worst case per request is
   `L + 10` (read_image accepts up to 10 paths).

Evidence (conversation 23caaa6e, turn-1792401406084-sld3f8): five requests with 7
images → 200; after `read_image` of 2 images (`mapinit.png`, `slab_tiles.png`) the next
request carried 9 → 400. Sending a new message works again because a fresh turn
re-compacts the persisted history.

## Design

Two layers — transcription stays the *primary* mechanism (it preserves information);
adapter-level clamping is a last-resort safety net that can never be bypassed.

### Layer 1 — Count cap in `openai-stream` (the actual fix)

`packages/openai-stream/src/stream.ts` already has a body-size budget that evicts the
**oldest** inline image parts in place when `JSON.stringify(body)` exceeds
`maxBodyBytes` (see `enforceBodyBudget` in `body-budget.ts`, placeholder text with the
"trailing phrase" pattern so the model knows an image was dropped). Mirror that for
count:

- Add `enforceImageCount(body, maxImages)` in `body-budget.ts` (same module, same
  placeholder, same oldest-first in-place replacement). Evict while
  `imageCount > maxImages`, oldest first.
- Wire `maxImages` through:
  - `CreateOpenAICompatProviderOpts.maxImages?: number` → `streamConfig` → `StreamConfig`
    (alongside `maxBodyBytes`).
  - `provider-umans/src/extension.ts` passes `maxImages: 8` (constant
    `UMANS_MAX_IMAGES = 8` — the endpoint does not report it, so it is a known
    provider constant; comment why).
  - Default `undefined` = no count cap → **all other providers unchanged**
    (openai-compat, longcat, hyper, …).
- Order of application in `streamChat`: count cap FIRST, then the byte budget (count
  eviction also frees bytes; both report through the same report shape).
- Observability: extend the existing span attrs on `provider.request` —
  `request.image_count`, `request.image_count_max`, and reuse
  `request.images_evicted` (add the count-evicted total to it). A future 400 of this
  class is then diagnosable from `app.ndjson` instead of opaque.

### Layer 2 — Model-aware effective limit for turn-start compaction

- Add `maxImages?: number` to `ModelInfo` (`packages/kernel/src/contracts/provider.ts`),
  optional + provider-reported; umans' `listModels` (which already maps
  `/v1/models/info`) sets it for every umans model.
- In `session-orchestrator.ts`, when calling `visionHandoff.prepareForProvider`,
  compute `effectiveImageLimit = min(globalImageLimit, modelMaxImages)` when the model
  reports a cap. Result: at turn start the oldest images beyond the *model's* cap are
  **transcribed** (information preserved), not placeholder-evicted.
- `vision-handoff` itself stays generic — it already takes `imageLimit` as an opt; the
  orchestrator is where the min() belongs.

The kernel's mid-turn path (`run-turn.ts` appending `imageMessages`) is intentionally
**left unchanged**: Layer 1 clamps whatever the kernel assembles, for every step, with
zero kernel blast radius. (A kernel-level transcription at step boundaries is a
possible follow-up if mid-turn images should be *transcribed* rather than
placeholder-dropped — costs a vision-model call per eviction, so not in v1.)

### Optional follow-ups (separate, low priority)

- Mirror `maxImages` in `transport-contract` `ModelMetadata` + a frontend hint on the
  imageLimit input ("clamped to 8 for umans models").
- Enrich the umans `ProviderError` with request-shape diagnostics (image count, tool
  count, body bytes) so any future 400 self-describes.

## Implementation steps

Worktree: `feature/provider-image-count-cap` (backend only — symlink frontend/bin/claude).

1. **`openai-stream`** — `enforceImageCount` + config wiring + span attrs; tests in
   `body-budget.test.ts` and `stream.test.ts` (oldest-first eviction, no cap when
   undefined, interplay with byte budget, placeholder text, span attrs).
2. **`provider-umans`** — pass `maxImages: 8`; unit test via `fetchFn` fixture: a
   10-image message list produces a body with exactly 8 `image_url` parts + 2
   placeholders.
3. **`kernel`** — `ModelInfo.maxImages?`; umans `listModels` populates it; typecheck
   ripple (small — optional field).
4. **`session-orchestrator`** — `effectiveImageLimit = min(global, modelMaxImages)`;
   test that a model cap below the global limit transcribes down to the cap.
5. **Verification** — `bun install`, `bun run typecheck`, `bun run test`, `bun run
   check`. Optional manual repro: replay the saved failing payload
   (`/tmp/23ca-request.json`) through a scratch script — expect 200 post-fix.
6. **Commit** on the feature branch. Do NOT merge/push.

## Acceptance criteria

- A request to umans never carries more than 8 image parts — enforced in the adapter,
  unit-tested, regardless of origin (pasted, history, or mid-turn `read_image`).
- The 23ca conversation completes turns that call `read_image` instead of dying with
  HTTP 400 mid-turn.
- Evictions are visible: `request.images_evicted` / `request.image_count` span attrs,
  and the model sees the standard eviction placeholder.
- Providers without a declared cap behave exactly as before (no count clamping).
- Existing test suites green (`openai-stream`, `provider-umans`,
  `session-orchestrator`, `vision-handoff`, `kernel`).

## Risks / open questions

- The 8 limit is **empirical** (bisected: 8 → 200, 9 → 400; size-independent). It may
  be gateway-wide vs per-model — worth one cheap confirmation against another umans
  model before hardcoding for all; the constant makes refining trivial either way.
- Mid-turn evictions drop to placeholders (not transcriptions) — information loss is
  possible in long vision-heavy turns. Acceptable for v1; kernel-level transcription
  is the follow-up if it bites.
- In-place image replacement inside a message with `cache_control` breakpoints could
  invalidate a cache segment — same semantics as the existing byte-budget eviction,
  so no new behavior class.
