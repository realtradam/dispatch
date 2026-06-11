# FE handoff — context size (current context-window usage)

Courier this to `../dispatch-web` (cross-repo contract change; `lsp references` does not
span repos — ORCHESTRATOR §7). Backend commit adds an optional `contextSize` field; no
breaking change.

## What shipped (backend)

A new optional field **`contextSize`** (a token count) now flows to the frontend on two
existing carriers. Both are computed identically and are EQUAL for the same turn:

1. **Live** — `TurnDoneEvent.contextSize?: number` (the `done` AgentEvent, arriving in a
   `chat.delta` WS message / the NDJSON stream).
2. **Persisted** — `TurnMetrics.contextSize?: number`, served by
   `GET /conversations/:id/metrics` (`ConversationMetricsResponse.turns[].contextSize`).

Types: `@dispatch/wire` (`0.4.0 → 0.5.0`), re-exported by
`@dispatch/transport-contract` (`0.5.0 → 0.6.0`). Bump the pinned `file:` deps.

## Definition (read this — it's subtle)

`contextSize` = **the turn's FINAL step `inputTokens + outputTokens`** — the tokens the
conversation occupies right now.

It is deliberately **NOT** the aggregate `usage` already on `done` / `TurnMetrics`.
`usage.inputTokens` is the SUM across steps, which **overcounts** a multi-step / tool-calling
turn (each step re-prefills the growing prompt). The final step's input already contains all
prior context, so `finalStep.input + finalStep.output` is the true occupancy. Do not derive
context size from `usage` yourself — read `contextSize`.

## How to render it

- **Current value = the LATEST turn's `contextSize`.** The chat's "current context usage" is
  whatever the most recent turn reported.
- **Live update:** when a `done` event arrives, if `event.contextSize !== undefined`, set the
  displayed context size to it.
- **On (re)hydrate:** call `GET /conversations/:id/metrics`, take the LAST element of `turns`
  that has a defined `contextSize`, and show its value. (Turns appear only after they seal.)
- **Optionality:** `contextSize` may be `undefined` (provider reported no per-step usage).
  Treat absent as "unknown" — render a placeholder, NOT `0`.

## Not included yet (next step)

The model's **max context-window limit** is a SEPARATE, later field — so a UI like
`contextSize / limit` (e.g. `34,102 / 200,000`) can't show the denominator yet. For now show
only the current size (e.g. "34,102 tokens in context"). "context size" = current usage;
"context window" = the future limit (see GLOSSARY).
