# FE handoff — persisted replay metrics (Pass 2) + metrics endpoint

> **Courier doc** (backend → `../frontend`, via the user). Per ORCHESTRATOR §7
> the backend does NOT write the FE repo; the FE orchestrator applies this delta
> on its side (regenerate the in-repo `.dispatch/*.reference.md` snapshots + bump
> the `file:` dep). `lsp references` does not span the two repos. Backend commit:
> `6db12ff`.

## Versions
- `@dispatch/wire` `0.3.0 → 0.4.0` (additive)
- `@dispatch/transport-contract` `0.3.0 → 0.4.0` (additive)

Pure-type, additive change — no breaking edits to existing types.

## New wire types (`@dispatch/wire`, re-exported by `@dispatch/transport-contract`)

```ts
interface StepMetrics {
  stepId: StepId;          // `<turnId>#<index>`, join key to the live stream
  usage: Usage;            // { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
  ttftMs?: number;         // time to first token (optional — clock + first-token gated)
  decodeMs?: number;       // first token → stream end
  genTotalMs?: number;     // stream start → end (== ttftMs + decodeMs when a first token was seen)
}

interface TurnMetrics {
  turnId: string;          // plain wire turn id, join key to AgentEvents
  usage: Usage;            // aggregate across all steps
  durationMs?: number;     // turn wall-clock (optional — clock gated)
  steps: readonly StepMetrics[];  // per-step, in step order
}
```

These are the **persisted, replayable** counterparts of the live `usage` /
`step-complete` / `done` events (which remain transient and unchanged).

## New read endpoint

`GET /conversations/:id/metrics` → `ConversationMetricsResponse`:

```ts
interface ConversationMetricsResponse { turns: readonly TurnMetrics[] }
```

Semantics:
- `turns` = every **sealed** turn's `TurnMetrics`, in **turn-append order**.
- A turn appears only **after seal** (post-persist); an in-flight/unsealed turn is absent.
- This is a **separate axis** from `GET /conversations/:id?sinceSeq=` (which returns
  seq-cursor chunk CONTENT). Metrics are keyed per **turn**, not per chunk, so they are
  **not** seq-filtered — hence a sibling route, not a field on the history response.
- Unknown / metric-less conversation → `{ turns: [] }`.
- CORS: same wildcard as the other routes.

## Suggested FE consumption
On (re)opening a conversation, the chat feature can `GET /conversations/:id/metrics`
once alongside the history hydrate (`?sinceSeq=`), then render historical
tokens/latency per turn (and per step via `stepId`) — identical fields to what it
already routes from the live `step-complete` / `usage` / `done` stream. TPS is
still derived FE-side (`usage.outputTokens / decodeMs`); context-size proxy =
`usage.inputTokens`.

## Invariants (confirmed live)
- Persisted `TurnMetrics.usage` / `durationMs` and each `StepMetrics`
  (`stepId` + `usage` + `ttftMs`/`decodeMs`/`genTotalMs`) **byte-match** what the
  live stream emitted for the same turn (verified end-to-end against flash).
- `stepId` is the SAME value on the live `step-complete`/`usage` events, the persisted
  `StepMetrics`, and the tool chunks — one grouping key across live + replay.
