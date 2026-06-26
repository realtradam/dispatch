# FE handoff — reasoning effort (thinking-depth knob)

Courier this to `../frontend` (cross-repo contract change; `lsp references` does not
span repos — ORCHESTRATOR §7). All changes are ADDITIVE — nothing existing breaks.

## What shipped (backend)

A new user-settable knob, **reasoning effort**: how much extended thinking the model spends
before answering. Canonical ladder (type `ReasoningEffort`, exported by `@dispatch/wire` and
re-exported by `@dispatch/transport-contract`):

```ts
type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
```

Versions: `@dispatch/wire` `0.6.1 → 0.7.0`, `@dispatch/transport-contract`
`0.10.0 → 0.11.0`. Bump the pinned `file:` deps.

It has TWO setting scopes, resolved server-side per turn:

1. **Per-turn override** — optional `reasoningEffort` on `ChatRequest` (HTTP `POST /chat`)
   and therefore on the WS `chat.send` message (`ChatSendMessage extends ChatRequest`).
   Applies to THAT turn only; does NOT persist.
2. **Persisted per-conversation setting** — sticky; used for every turn that has no per-turn
   override:
   - `GET /conversations/:id/reasoning-effort` → `ReasoningEffortResponse`
     `{ conversationId, reasoningEffort: ReasoningEffort | null }` (`null` = never set).
   - `PUT /conversations/:id/reasoning-effort` with body `SetReasoningEffortRequest`
     `{ reasoningEffort }` → persists it.

**Resolution chain (server-owned — do not re-implement):** per-turn override → persisted
conversation value → **default `"high"`**. So a conversation with nothing set already runs at
`high`; `null` from the GET means "default (`high`) applies", not "off".

**Validation:** an unrecognized level → HTTP 400 `{ error }` (the error message lists the
valid levels). Same for the WS path (the standard `chat.send` error reply). Send only the
five ladder strings; omit the key entirely for "no override" (don't send `null`/`""`).

## What the model does with it (context for UX copy)

The Anthropic provider maps the level to an extended-thinking token budget
(`low` 4 096 · `medium` 10 240 · `high` 16 384 · `xhigh` 32 768 · `max` 65 536). Higher
levels = the model thinks longer before answering (more `reasoning-delta` events / thinking
chunks ahead of the text — the FE already renders those). Providers without a thinking knob
ignore the field — sending it is always safe.

## What we need the FE to do

1. **Per-conversation effort selector** — a 5-option control (plus an implicit "default"
   state when the GET returns `null`):
   - On conversation open: `GET /conversations/:id/reasoning-effort`; render `null` as
     "high (default)".
   - On change: `PUT` the chosen level. It takes effect from the NEXT turn — no turn restart
     needed.
2. **(Optional) per-turn override** — if the composer grows a "think harder for this one
   message" affordance, set `reasoningEffort` on that `chat.send` only. The persisted setting
   is untouched by overrides.
3. **Expect more thinking** — at `xhigh`/`max` the pre-answer thinking phase can be long;
   whatever spinner/" thinking…" treatment exists should tolerate extended runs of
   reasoning deltas before the first text delta.

## Cache note (don't surprise users)

Changing the effort level changes the provider request shape, which can bust the prompt
cache for the next turn (one-time re-prefill cost). The backend's cache-warming path already
warms with the SAME resolved effort as a real turn, so a STABLE setting stays cache-safe;
only the act of changing it costs. If the FE wants, it can mention this in the selector's
tooltip — no functional handling required.

## Verify (manual)

```bash
# sticky setting round-trip
curl -s localhost:24203/conversations/<id>/reasoning-effort          # → null first time
curl -s -X PUT localhost:24203/conversations/<id>/reasoning-effort \
  -H 'content-type: application/json' -d '{"reasoningEffort":"xhigh"}'
curl -s localhost:24203/conversations/<id>/reasoning-effort          # → "xhigh"
# bad level → 400
curl -s -X PUT localhost:24203/conversations/<id>/reasoning-effort \
  -H 'content-type: application/json' -d '{"reasoningEffort":"banana"}'
```
