# FE handoff — cache hit/miss + percentage (calculation guide)

> **Courier doc** (backend → `../frontend`, via the user). Per ORCHESTRATOR §7
> the backend does not write the FE repo. This describes ONLY how to compute cache
> hit/miss + percentages from data the backend ALREADY exposes — **no UI design here**
> (the look is specified separately) and **no backend change is required**.
> Contracts: `@dispatch/wire` + `@dispatch/transport-contract` `0.4.0`.

## TL;DR
The cache hit rate is `cacheReadTokens / inputTokens`. Everything you need is already
on the `usage` + `done` live events and in `GET /conversations/:id/metrics`. There is
**no separate cache endpoint or boolean** — it's derived from token counts, exactly as
the old `CacheRatePanel` did.

## The data shape (`Usage`, from `@dispatch/wire`)
```ts
interface Usage {
  inputTokens: number;       // TOTAL prompt tokens this step/turn, INCLUDING cached ones
  outputTokens: number;
  cacheReadTokens?: number;  // input tokens served FROM cache (the "hit" count). Optional.
  cacheWriteTokens?: number; // cache-creation count. Optional; usually ABSENT (see caveats).
}
```
Field semantics that matter for the math:
- `inputTokens` is the **whole** prompt, so `cacheReadTokens ≤ inputTokens` and the rate is in `[0,1]`.
- The cache fields are **optional** — treat `undefined` as `0` in all arithmetic.

## Formulas
```ts
const read  = u.cacheReadTokens  ?? 0;
const write = u.cacheWriteTokens  ?? 0;

const isHit   = read > 0;                               // hit vs miss
const hitRate = u.inputTokens > 0 ? read / u.inputTokens : 0;   // 0..1  (guard /0)
const hitPct  = Math.round(hitRate * 100);
const fresh   = Math.max(0, u.inputTokens - read - write);      // uncached input tokens
```
(These are byte-identical to the old `CacheRatePanel.svelte` formulas: hit rate =
`cacheReadTokens/inputTokens` clamped; uncached = `max(0, input − read − write)`.)

## Where to get `Usage` — three granularities, two channels

| Scope | LIVE (WS `chat.delta` / NDJSON) | REPLAY (`GET /conversations/:id/metrics`) |
|---|---|---|
| **Per step** | `usage` event (`type:"usage"`, carries `stepId`, `usage`) | `TurnMetrics.steps[].usage` (each has `stepId`) |
| **Per turn** (authoritative aggregate) | `done` event (`type:"done"`, carries `usage`, `durationMs`) | `TurnMetrics.usage` |
| **Cumulative** (conversation) | Σ of each turn's `done.usage` | Σ of `turns[].usage` |

Notes:
- The **per-turn aggregate IS the sum of its steps** (the runtime aggregates). So when
  summing a cumulative figure, pick ONE granularity — sum `done.usage`/`TurnMetrics.usage`
  per turn, **or** sum all steps — never both (double-count).
- `done.usage` is the authoritative per-turn total. (`turn-sealed` does NOT carry usage in
  this backend — it's just `{conversationId, turnId}`; the numbers ride the immediately
  preceding `done` event.)
- `step-complete` is timing only (ttft/decode) — no tokens; ignore it for cache.

## Live accumulation + reconcile (recommended pattern)
1. **In-progress turn (optional live counter):** as `usage` events stream, you may sum
   `read`/`input` across the turn's steps to show a live-updating hit % for the current turn.
2. **Turn finished:** take that turn's authoritative totals from its `done.usage`. Use it as
   the turn's final value (replace any live partial for that turn).
3. **Cumulative (session/conversation):** add each completed turn's `done.usage` to a running
   total. Compute the cumulative hit % from the running totals (`ΣcacheRead / Σinput`).
4. **"Last request" rate:** the most recent turn's `done.usage` (or most recent step's `usage`
   if you want per-round-trip granularity).

## Replay / reopening a conversation
On open, `GET /conversations/:id/metrics` → `ConversationMetricsResponse { turns: TurnMetrics[] }`.
Seed the cumulative totals from `Σ turns[].usage`, the "last request" from `turns.at(-1).usage`,
and you can render a per-turn (and per-step, via `steps[]`) breakdown — a superset of what the
old session-cumulative-only panel could show.

## Caveats (be honest in the UI)
- **`cacheWriteTokens` is usually absent.** The current provider is OpenAI-compatible
  (OpenCode Go): it reports a cache **read** count (`cached_tokens`) but **no cache-creation**
  count. So the old panel's separate "write" row will be 0/empty. Hit/miss and the read
  percentage are unaffected. It would populate only if an Anthropic-native (or
  `cache_write`-reporting) provider is added.
- **Optional fields:** any of the cache fields can be `undefined` (provider-dependent). Default
  to 0; never assume presence.
- **A legitimate 0% is not a bug.** OpenAI-style providers auto-cache (no `cache_control`
  breakpoints), and short prompts below the provider's cache threshold simply won't be cached —
  `cacheReadTokens: 0` is a real "miss", not missing data. Cache reads grow as a conversation's
  resent prefix gets large enough.
- **Provider doesn't report cache at all — distinguish from 0.** Some providers (e.g.
  **Umans**) never include `cache_read_tokens` / `cache_write_tokens` in their usage
  payload. In that case `cacheReadTokens` is `undefined` — the provider can't tell you
  whether cache was hit or missed. This is **different from `cacheReadTokens: 0`**,
  which means "cache was checked and there were 0 hits" (a real miss).

  The FE should distinguish these three states:

  | `cacheReadTokens` | Meaning | FE display |
  |---|---|---|
  | `undefined` | Provider doesn't report cache | Hide cache panel, or show "N/A" |
  | `0` | Provider reports cache; this request had 0 hits | Show "0%" (genuine miss) |
  | `> 0` | Cache hit | Show percentage |

  ```ts
  function cacheDisplay(u: Usage): { kind: "not-reported" } | { kind: "reported"; hitPct: number } {
    if (u.cacheReadTokens === undefined) return { kind: "not-reported" };
    const read = u.cacheReadTokens;
    const hitRate = u.inputTokens > 0 ? read / u.inputTokens : 0;
    return { kind: "reported", hitPct: Math.round(hitRate * 100) };
  }
  ```

  When `kind === "not-reported"`, do NOT show "0%" — that's misleading. Either hide the
  cache panel entirely or show "Cache: not reported". This also applies to `cacheWriteTokens`
  (if `undefined`, don't show a write row).

## Worked example (real numbers, captured live against OpenCode Go flash)
| Turn | inputTokens | cacheReadTokens | hit % |
|---|---|---|---|
| 1 | 2669 | 384 | 14% |
| 2 (history resent) | 2737 | 2560 | **93%** |

Cumulative: read `2944` / input `5406` → **54%**. These exact values appear both on the live
`done.usage` stream and in `GET /conversations/:id/metrics` (`turns[].usage`).

## Type references
- `@dispatch/wire`: `Usage`, `TurnUsageEvent` (`usage`), `TurnDoneEvent` (`done`),
  `TurnMetrics`, `StepMetrics`.
- `@dispatch/transport-contract`: `ConversationMetricsResponse`, and the WS `chat.delta`
  envelope carrying each `AgentEvent`.
