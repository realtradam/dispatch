# Frontend handoff — live turn metrics (tokens + timing)

> From: arch-rewrite (backend) orchestrator · For: the dispatch-web FE team.
> Status: **LIVE on the stream now** (backend committed + live-verified). Consume via the pinned
> contracts `@dispatch/wire@0.3.0` + `@dispatch/transport-contract@0.3.0` (reference snapshots
> regenerated in `dispatch-web/.dispatch/{wire,transport-contract}.reference.md`).

## 1. What you can now access
The backend's **authoritative** token + timing metrics are now on the live turn stream:

| Metric | Where | Field(s) |
|---|---|---|
| Per-step tokens | `usage` event | `usage` (`inputTokens`/`outputTokens`/`cacheReadTokens?`/`cacheWriteTokens?`) + new `stepId?` |
| Per-step **TTFT** | new `step-complete` event | `ttftMs?` |
| Per-step **decode** time | new `step-complete` event | `decodeMs?` |
| Per-step total generation | new `step-complete` event | `genTotalMs?` |
| **Tool execution** time | `tool-result` event | `durationMs?` |
| **Turn** wall-clock | `done` event | `durationMs?` |
| **Turn** total tokens | `done` event | `usage?` |
| **Tokens/sec** (TPS) | derive | `usage.outputTokens / (step-complete.decodeMs / 1000)` |
| Context-size proxy | `usage` event | `usage.inputTokens` (size the model counted; `cacheReadTokens` = cached portion) |

"Authoritative" = measured by the backend runtime, not client wall-clock. They differ from
anything you'd time in the browser (no network/buffering in them).

## 2. How they're delivered
**Inline, in the same chat stream you already consume** — WS `chat.delta` frames (and the
`POST /chat` NDJSON stream) carry the `AgentEvent` union; metrics are additional event types /
fields in that union. **No new endpoint, no subscription/negotiation.** You already `switch` on
`event.type`; route the metric events to a telemetry handler and ignore any you don't render
(zero cost). They do **not** appear in message content — keep your transcript rendering as-is.

These events are **low-frequency** (one `step-complete` per step, one `done` per turn, a
`durationMs` per tool result) — not per-token — so there's no stream-volume concern.

## 3. The new/changed events (shapes)
All new fields are **optional** — see §5. Every event still carries `conversationId` + `turnId`.

```ts
// NEW variant in AgentEvent — emitted once per step, AT STEP END (timing is final here)
interface TurnStepCompleteEvent {
  type: "step-complete";
  conversationId: string;
  turnId: string;
  stepId: StepId;        // join key to the step's `usage` event + tool events
  ttftMs?: number;       // time to first token (stream start → first text|reasoning delta)
  decodeMs?: number;     // first token → stream end  (== genTotalMs - ttftMs)
  genTotalMs?: number;   // whole-step generation (present even if no first token was seen)
}

// usage event — now labeled by step
interface TurnUsageEvent {
  type: "usage";
  conversationId: string; turnId: string;
  stepId?: StepId;       // NEW — attribute tokens to a step / join to step-complete
  usage: Usage;          // { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
}

// tool-result — now carries execution time
interface TurnToolResultEvent {
  type: "tool-result";
  conversationId: string; turnId: string;
  stepId: StepId; toolCallId: string; toolName: string;
  content: string; isError: boolean;
  durationMs?: number;   // NEW — tool execution time (dispatch → result)
}

// done — now carries turn totals
interface TurnDoneEvent {
  type: "done";
  conversationId: string; turnId: string;
  reason: string;
  durationMs?: number;   // NEW — whole-turn wall-clock
  usage?: Usage;         // NEW — aggregate turn tokens (so you needn't sum the usage events)
}
```

## 4. Correlation & derived metrics
Keys: `turnId` groups a turn; `stepId` groups a step within it; `toolCallId` pairs a tool call
with its result. A turn has **one `step-complete` (and usually one `usage`) per step**.

- **Per-step TPS** = `usage.outputTokens / (step-complete.decodeMs / 1000)` — join `usage` and
  `step-complete` by `stepId`. (Use `decodeMs`, not `genTotalMs`, for decode-rate TPS; it excludes
  first-token latency. See "which TPS" caveat below.)
- **Turn TPS** = `done.usage.outputTokens / (Σ step-complete.decodeMs / 1000)`.
- **Generation total per step** = `genTotalMs` (or `ttftMs + decodeMs`).
- **Turn-visible first-token latency** = the `ttftMs` of **step 0** (the first `step-complete`).
- **Total prefill overhead** = `Σ ttftMs` across steps; **pure generation** = `Σ decodeMs`.
- **Tool time** = `tool-result.durationMs` per call; sum per `stepId` for a batch.

"Which TPS": `decodeMs` is first-token → end, so TPS over it is the decode rate (first-token
latency removed). If you want end-to-end rate including the wait, use `ttftMs + decodeMs`.

## 5. Optionality — you MUST tolerate absence
- `step-complete` is always emitted per step, but its **timing fields are present only when the
  server runs with a clock** (it does in normal operation). `ttftMs`/`decodeMs` are additionally
  absent for a step that produced **no text/reasoning token** (e.g. a tool-call-only step) —
  `genTotalMs` is still present in that case.
- `usage.stepId`, `tool-result.durationMs`, `done.durationMs`, `done.usage` are all optional.
- Render gracefully when a value is missing (omit the figure; don't show `NaN`/`undefined`).

## 6. What is NOT available yet (deferred — Pass 2)
**Metrics are LIVE-ONLY.** They are **not persisted**, so:
- `GET /conversations/:id` (history) returns messages/chunks but **no tokens/timing**. Reopening a
  past conversation will show content without metrics.
- If you need historical metrics (e.g. show TPS on a reloaded conversation), that's the planned
  **Pass 2** (persist per-turn metrics + a read path) — see `tasks.md` "Pass 2 — DEFERRED". Tell
  us if you need it and we'll prioritize.
- TPS is not sent pre-computed (derive it, §4). No per-token timing (metrics are per-step/per-turn).

## 7. Integration checklist
1. Refresh deps: `bun run typecheck` in dispatch-web (picks up `wire@0.3.0` / `transport-contract@0.3.0`).
2. Extend your `chat.delta` event handler: add a `case "step-complete"` and read the new optional
   fields on `usage`/`tool-result`/`done`. (No exhaustive-switch break — these are additive.)
3. Keep a per-turn (and per-step, keyed by `stepId`) telemetry accumulator alongside the transcript
   store; fold metric events into it; render where you want (e.g. a turn footer / per-step badges).
4. Treat every metric field as optional (§5).

## 8. Carrier facts (unchanged)
HTTP 24203 (`POST /chat` NDJSON, `GET /conversations/:id`, `GET /models`), WS 24205 (one socket,
`chat.delta` carries each `AgentEvent`), CORS `*`. Same events on both carriers.
