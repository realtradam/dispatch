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
  | `stat`   | last cache % | most recent warm's hit % (`"—"` when none yet) | — (read-only) |
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
  200   WarmResponse { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; cachePct }
  409   { error }    // the conversation is currently generating — try again when idle
  400   { error }    // missing/invalid conversationId
```
- Pass the **same `model`** (`<credentialName>/<model>`) the conversation chats with, so the warm
  request's prefix matches the real turn (that's what makes the cache hit). `cwd` only matters if the
  conversation uses cwd-scoped tools.
- `cachePct` = `round(clamp(cacheReadTokens / inputTokens, 0, 1) * 100)` — show it as the "last
  warming" hit indicator. The warm is **never** persisted or streamed and is **never** folded into
  the conversation's real usage/cache-rate (keep it visually distinct from the real cache rate in
  §`frontend-cache-rate-handoff.md`).
- Types live in `@dispatch/transport-contract` (`WarmRequest`, `WarmResponse`).

## E. Behavior model (for the UX)
- Warming is **per-conversation**: each conversation that has had a turn arms its own timer
  (default **4 min**, under the provider's ~5-min cache TTL); it cancels while a turn is generating
  and re-arms when the turn settles. Default **enabled = true**.
- The toggle/interval in the surface control THIS conversation's automatic warming; the button (§D)
  fires one immediately regardless.
- Verified live against Claude (`claude/claude-haiku-4-5-...`): an idle conversation's warm reports
  ~100% cache read once its prefix exceeds the provider's min-cacheable size.

## Versions / type references
- `@dispatch/ui-contract`: `NumberField` (new `SurfaceField` variant); `conversationId?` on
  `SubscribeMessage`/`UnsubscribeMessage`/`InvokeMessage`/`SurfaceMessage`/`SurfaceUpdate`.
- `@dispatch/transport-contract`: `WarmRequest`, `WarmResponse`.
- Cache-% math + the real (non-warming) cache rate: see `frontend-cache-rate-handoff.md` (unchanged).
