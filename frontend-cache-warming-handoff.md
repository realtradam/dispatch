# FE handoff — cache warming: cache-rate fix + "expected cache" metric

> **Courier doc** (backend → `../dispatch-web`, via the user). Per ORCHESTRATOR §7 the backend does
> NOT write the FE repo. `lsp references` does not span the two repos.
> Backend commits: `7ffb6b2` (arch-rewrite), `0e9d118` (`../claude/provider-anthropic`).

## Status — most of the original handoff is DONE (removed)
Per the FE's `backend-handoff.md` (2026-06-11), the frontend has already consumed the bulk of the
earlier version of this doc — those sections are **removed**:
- ✅ `NumberField` (`kind:"number"`) renderer.
- ✅ Conversation-scoped surface subscriptions (focused `conversationId` on subscribe/invoke +
  staleness rule; re-scope on conversation switch).
- ✅ The "Cache Warming" sidebar view: enabled toggle, minutes+seconds interval (`cache-warming/
  set-interval`), `cache-warming/toggle`, manual **Warm now** (`POST /chat/warm`), live countdown,
  hit-% history.
- ✅ `warmNow()` posting `/chat/warm` with the conversation's model.

What remains below is the ONE piece the FE has not yet consumed: a cache-rate **correctness fix** and
a new **retention** metric.

## Cache-rate metric — a correctness fix + the "expected cache" metric (TO CONSUME)
A backend bug made the cache-hit % read **100% on Claude whenever anything was cached** (it inflated).
Root cause: Anthropic's `input_tokens` is the *uncached remainder*, with cache read/creation reported
separately — but the wire `Usage.inputTokens` convention (which the flash/OpenAI-compat provider
already follows) is the **TOTAL prompt incl. cached**. Fixed in `../claude/provider-anthropic`
(`inputTokens = input + cacheRead + cacheWrite`). **No FE change needed for the fix itself** — your
existing `cacheRead/inputTokens` math (in `frontend-cache-rate-handoff.md`) now yields the *true* rate
on Claude. (That older handoff's caveat "cacheWriteTokens is usually absent" is **not** true for
Claude — it reports both.)

Show two distinct cache numbers:
- **Cache rate** = `cacheReadTokens / inputTokens` — *what fraction of THIS turn's prompt came from
  cache*. Legitimately **drops when a turn adds a lot of new content** (e.g. pasting a big file: reads
  the old prefix back but also writes the new file → rate < 100%). Per-turn efficiency; on every
  `usage`/`done` event + persisted metrics.
- **Expected cache (retention)** = *of the cache that existed going into this turn, how much we read
  back* — ideally **~100% every turn after the first**. **<100% = the cache busted/expired.** It is a
  **cross-turn** derivation (FE-side, from two consecutive turns' usage you already have):
  ```
  expectedCache(turn N) = clamp01( cacheRead_N / (cacheRead_{N-1} + cacheWrite_{N-1}) )
  ```
  (denominator = the prior turn's cached prefix = what it read + what it wrote).

**Worked example (live, Claude haiku), one chat, two real turns:**
| turn | inputTokens (total) | cacheRead | cacheWrite | cache rate `cr/input` | expected cache (cross-turn) |
|---|---|---|---|---|---|
| 1 (fresh) | 5149 | 0 | 5146 | 0% | — |
| 2 (new msg) | 8462 | 5146 | 3313 | **61%** | `5146/(0+5146)` = **100%** |

So on turn 2 the prompt was 61% cache (the rest was the new message), yet you read back **100%** of
what turn 1 cached — two true, complementary signals. (Pre-fix, the rate wrongly showed 100% because
the denominator excluded the 5146 cached tokens.)

### Warming-specific (already on the wire — small additions)
For the warming feature, the backend now also reports a **single-shot** retention so you don't have to
track cross-turn state there:
- **`WarmResponse.expectedCacheRate`** (new field on `POST /chat/warm`) =
  `round(cacheReadTokens / (cacheReadTokens + cacheWriteTokens) * 100)` — ~**100%** when the warm
  found the cache still warm, **0%** when it had expired (rewrote everything). This is the **"is
  warming working?"** signal — headline this for the Warm-now result rather than `cachePct`.
- The conversation-scoped `cache-warming` surface gained a matching **`stat` "cache retention"** field
  (alongside the existing "last cache rate" stat). It's a generic `stat`, so your existing renderer
  already shows it — just relabel/position as desired.

Types: `@dispatch/transport-contract` `WarmResponse` now carries `expectedCacheRate` (additive).
