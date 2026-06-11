# FE handoff — cache warming controls + surface protocol (NumberField, per-conversation scoping)

> **Courier doc** (backend → `../dispatch-web`, via the user). Per ORCHESTRATOR §7 the backend does
> NOT write the FE repo; the FE applies this delta on its side (regenerate the in-repo
> `.dispatch/*.reference.md` surface snapshots + bump the `file:` deps for `@dispatch/ui-contract` /
> `@dispatch/transport-contract`). `lsp references` does not span the two repos.
> Backend commits: `c2b4c05` (warming engine), `27fd0be` (manual `/chat/warm`), `ffbbcf6` (surface
> framework + cache-warming controls surface).

## What this delivers (and what the FE must do)
A **prompt-cache warming** feature: the backend periodically re-sends an idle conversation's prefix
to keep the provider cache warm, plus a manual trigger. The FE needs to (1) render a new **`number`**
surface field, (2) make the surface WS protocol **conversation-aware** (send/handle `conversationId`),
(3) render the **cache-warming control surface**, and (4) optionally wire a **"warm now" button** to a
new HTTP endpoint. All backend changes are **additive / backward-compatible** — existing global
surfaces (e.g. `loaded-extensions`) are unchanged.

---

## A. `@dispatch/ui-contract` — new `NumberField` (RENDER THIS)
A new variant was added to the `SurfaceField` union:
```ts
export interface NumberField {
  readonly kind: "number";
  readonly label: string;
  readonly value: number;
  readonly min?: number;     // semantic lower bound (validate/step)
  readonly max?: number;     // semantic upper bound (may be absent = free value)
  readonly step?: number;
  readonly unit?: string;    // display hint, e.g. "s"
  readonly action: ActionRef;// invoke this with the new number as payload
}
```
**FE action:** add a renderer case for `field.kind === "number"` (a numeric input/stepper). On
change, send an `invoke` (see §B) with the new number as the payload. It is the free-value
counterpart to `selector`. Until you add the case, your field switch should already gracefully skip
unknown kinds (it does for `custom`) — but the interval control won't show without it.

## B. `@dispatch/ui-contract` — surface WS protocol is now conversation-aware
A surface can be **global** (one state for everyone, e.g. `loaded-extensions`) or **conversation-
scoped** (state differs per conversation, e.g. cache-warming). To support the latter, an optional
`conversationId` was added to the messages — **all optional, fully backward-compatible**:

- **Client → server**: `SubscribeMessage`, `UnsubscribeMessage`, `InvokeMessage` each gained
  `conversationId?: string`.
- **Server → client**: `SurfaceMessage` (the full-spec reply) and `SurfaceUpdate` (live patch) each
  gained `conversationId?: string` (echoes which conversation the spec/update is for; absent for
  global surfaces).

**FE action / rules:**
1. When subscribing to a **conversation-scoped** surface, include the **currently-focused
   `conversationId`**: `{ type: "subscribe", surfaceId, conversationId }`. The server replies with
   `{ type: "surface", spec, conversationId }` and pushes `{ type: "update", update: { surfaceId,
   spec, conversationId } }` for that conversation only.
2. **On conversation switch:** unsubscribe the old `(surfaceId, conversationId)` and resubscribe with
   the new id (the server keys subscriptions by the pair). For **global** surfaces, just omit
   `conversationId` — behaves exactly as today; no resubscribe needed on switch.
3. **Route incoming `surface`/`update` by `conversationId`** so a stale conversation's update doesn't
   overwrite the focused one.
4. There is **no `scope` flag** on the catalog — the simplest correct FE policy is: always send the
   focused `conversationId` on subscribe/invoke. Global surfaces ignore it; scoped ones use it. (If
   no conversation is focused, omit it — a scoped surface then returns a default/empty spec.)

## C. The cache-warming control surface (RENDER THIS)
- **Catalog entry:** `id: "cache-warming"`, `region: "side"`, `title: "Cache Warming"`.
  **Conversation-scoped** → subscribe with the focused `conversationId`.
- **Spec fields (per conversation):**
  | kind | label | meaning | action |
  |---|---|---|---|
  | `toggle` | enabled on/off | warming on for this conversation | `cache-warming/toggle` |
  | `number` | refresh interval | **seconds** (`unit:"s"`, `min:1`, `step:1`, no `max` = free value) | `cache-warming/set-interval` |
  | `stat`   | last cache rate | most recent warm's `cachePct` (`"—"` when none yet) | — (read-only) |
  | `stat`   | cache retention | most recent warm's `expectedCacheRate` — the **health** signal (~100% = cache stayed warm; 0% = it expired) | — (read-only) |
- **Invoke payloads:**
  - `cache-warming/toggle` → **flips** the current enabled state. Send `{ type: "invoke", surfaceId:
    "cache-warming", actionId: "cache-warming/toggle", conversationId }` (payload is ignored — it
    toggles, it does not set).
  - `cache-warming/set-interval` → send the new interval **in seconds** as the payload: either a bare
    number (`payload: 120`) or `{ value: 120 }`. The backend converts to ms and floors at 1000 ms
    (1 s); NaN/non-positive are ignored.
- **Live updates:** the surface pushes an `update` (with `conversationId`) whenever the toggle/interval
  changes or a warm completes (so the "last cache %" stat refreshes). Just re-render from the pushed
  spec.

## D. Manual warm trigger — `POST /chat/warm` (the "warm now" button)
For an on-demand warm (e.g. a button) without waiting for the automatic timer:
```
POST /chat/warm
  body  WarmRequest  { conversationId: string; model?: string; cwd?: string }
  200   WarmResponse { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens;
                       cachePct; expectedCacheRate }
  409   { error }    // the conversation is currently generating — try again when idle
  400   { error }    // missing/invalid conversationId
```
- Pass the **same `model`** (`<credentialName>/<model>`) the conversation chats with, so the warm
  request's prefix matches the real turn (that's what makes the cache hit). `cwd` only matters if the
  conversation uses cwd-scoped tools.
- `cachePct` = `round(cacheReadTokens / inputTokens * 100)` — the cache RATE of the warm request.
- `expectedCacheRate` = `round(cacheReadTokens / (cacheReadTokens + cacheWriteTokens) * 100)` — the
  **retention / health** signal: ~**100%** when the cache was still warm (read back, ~nothing
  rewritten), **0%** when it had expired (rewrote everything). This is the one to headline for a
  "is warming working?" indicator.
- The warm is **never** persisted or streamed and is **never** folded into the conversation's real
  usage/cache-rate (keep it visually distinct from the real cache rate in §F / `frontend-cache-rate-handoff.md`).
- Types live in `@dispatch/transport-contract` (`WarmRequest`, `WarmResponse`).

## E. Behavior model (for the UX)
- Warming is **per-conversation**: each conversation that has had a turn arms its own timer
  (default **4 min**, under the provider's ~5-min cache TTL); it cancels while a turn is generating
  and re-arms when the turn settles. Default **enabled = true**.
- The toggle/interval in the surface control THIS conversation's automatic warming; the button (§D)
  fires one immediately regardless.
- Verified live against Claude (`claude/claude-haiku-4-5-...`): an idle conversation's warm reports
  ~100% cache read once its prefix exceeds the provider's min-cacheable size.

## F. Cache-rate metric — a correctness fix + the "expected cache" metric (READ THIS)
A backend bug made the cache-hit % read **100% on Claude whenever anything was cached** (it inflated).
Root cause: Anthropic's `input_tokens` is the *uncached remainder*, with cache read/creation reported
separately — but the wire `Usage.inputTokens` convention (which the flash/OpenAI-compat provider
already follows) is the **TOTAL prompt incl. cached**. Fixed in `../claude/provider-anthropic`
(`inputTokens = input + cacheRead + cacheWrite`). **No FE change needed** — your existing
`cacheRead/inputTokens` math (see `frontend-cache-rate-handoff.md`) now yields the *true* rate on
Claude. (Note: that older handoff's caveat "cacheWriteTokens is usually absent" is **not** true for
Claude — it reports both.)

Two distinct cache numbers — show them as different things:
- **Cache rate** = `cacheReadTokens / inputTokens` — *what fraction of THIS turn's prompt came from
  cache*. It legitimately **drops when a turn adds a lot of new content** (e.g. a turn that pastes a
  big file reads back the old prefix but also writes the new file → rate < 100%). This is the
  per-turn efficiency number, available on every `usage`/`done` event and in persisted metrics.
- **Expected cache (retention)** = *of the cache that existed going into this turn, how much did we
  read back* — ideally **~100% every turn after the first** (you re-read the entire prefix you
  cached). It is a **cross-turn** derivation:
  ```
  expectedCacheRate(turn N) = cacheRead_N / (cacheRead_{N-1} + cacheWrite_{N-1})   // clamp [0,1]
  ```
  (denominator = the prior turn's cached prefix = what it read + what it wrote). **<100% means the
  cache busted/expired** between turns. The FE derives this from two consecutive turns' usage (which
  you already have, live + persisted). For the WARM endpoint/surface this same idea is the single-shot
  `expectedCacheRate` (§C/§D) the backend already computes.

**Worked example (live, Claude haiku), one chat, two real turns:**
| turn | inputTokens (total) | cacheRead | cacheWrite | cache rate `cr/input` | expected cache (cross-turn) |
|---|---|---|---|---|---|
| 1 (fresh) | 5149 | 0 | 5146 | 0% | — |
| 2 (new msg) | 8462 | 5146 | 3313 | **61%** | `5146/(0+5146)` = **100%** |

So on turn 2 the prompt was 61% cache (the rest was the new message), yet you successfully read back
**100%** of what turn 1 cached — two true, complementary signals. (Pre-fix, the rate wrongly showed
100% because the denominator excluded the 5146 cached tokens.)

## Versions / type references
- `@dispatch/ui-contract`: `NumberField` (new `SurfaceField` variant); `conversationId?` on
  `SubscribeMessage`/`UnsubscribeMessage`/`InvokeMessage`/`SurfaceMessage`/`SurfaceUpdate`.
- `@dispatch/transport-contract`: `WarmRequest`, `WarmResponse` (now incl. `expectedCacheRate`).
- Cache-% fix: `../claude/provider-anthropic` now reports `inputTokens` as the total prompt — the
  real (non-warming) cache rate in `frontend-cache-rate-handoff.md` becomes accurate on Claude with
  no FE change; ignore that doc's "cacheWriteTokens usually absent" caveat for Claude.
