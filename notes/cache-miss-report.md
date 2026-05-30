# Cache Miss Investigation — Dispatch / Claude prompt caching

> Read-only investigation. No code was modified. File:line references are to the
> state of the tree at the time of writing.

## TL;DR

The beta header and cache-breakpoint placement are **correct**. The cache misses
come from a **message-serialization instability inside multi-step turns**:
dispatch stores an entire multi-step assistant turn as a *single growing
assistant message*, and `toModelMessages` + the Anthropic Pass-3 normalization
**re-bucket every tool-call and every tool-result on every step**. This moves
earlier steps' `tool_use` / `tool_result` blocks to new positions each step, so
Anthropic can only match the prefix up to the *first* step's text/thinking.
Everything after is re-written as a new cache entry.

Result: `cache_write` grows every step while `cache_read` stays flat — exactly
the panel readout (write 100,470 ≫ read 40,448; last request 19% < session 29%).

## Evidence (the Cache Rate panel)

```
readCache hits        40,448
writeCache writes     100,470
freshUncached input   18
Total input           140,936   (= read + write + fresh, confirms inputTokens is the TOTAL prompt)
Output                5,130
9 req
Session (this tab)    29%
Last request          19%
```

Two tells:

1. **writes ≫ reads.** In a healthy rolling cache over a growing turn, reads
   accumulate and dominate writes. Here writes are ~2.5× reads → the cacheable
   prefix is being invalidated and re-written almost every request.
2. **Last request (19%) < cumulative (29%).** The *largest* request has the
   *lowest* hit rate. In a working rolling cache the last turn should be the
   *highest* (biggest cached prefix, smallest delta). The inversion means the
   newest, biggest request re-wrote the most.

## What is fine (ruled out)

- **Beta header present** — `prompt-caching-scope-2026-01-05` is sent
  (`packages/core/src/credentials/anthropic-betas.ts:13-20`, wired in
  `packages/core/src/llm/provider.ts:123`). The earlier `claude-report.md`
  "Root Cause 1" (missing beta) is fixed.
- **Breakpoint placement matches OpenCode exactly** — dispatch's
  `applyAnthropicCaching` (`packages/core/src/agent/agent.ts:448-466`) marks
  first-2 system + last-2 non-system messages at the *message* level, identical
  to OpenCode's `applyCaching`
  (`references/opencode/packages/opencode/src/provider/transform.ts:345-394`)
  for `providerID === "anthropic"`.
- **System prompt is deterministic** — `buildSystemPrompt`
  (`packages/api/src/agent-manager.ts:127-147`) has no date/cwd/env/timestamp.
  The billing-header `cch` derives from the first user message
  (`packages/core/src/credentials/claude.ts:354-372`), stable within a
  conversation. So the `tools + system` prefix does **not** churn.
- **OAuth body transform is a faithful port** of the reference plugin
  (`packages/core/src/llm/anthropic-oauth-transform.ts` ≈
  `references/opencode-claude-auth/src/transforms.ts`).

## Root cause (primary) — multi-step turns reshuffle their own prefix every step

### The architecture

A whole turn (all tool steps) accumulates into ONE assistant message whose
`chunks` array is shared across steps (`agent.ts:786`, pushed once at
`agent.ts:923-926`). Each step's first `tool-call` opens a *new* `tool-batch`
chunk because the preceding chunk is text/thinking
(`packages/core/src/chunks/append.ts:111-124`). So after 2 steps the single
message is:

```
assistant.chunks = [ text0, think0, batch0{A:+resultA},  text1, think1, batch1{B:+resultB} ]
```

### The serialization

`toModelMessages` (`agent.ts:162-256`) walks all chunks of that one message,
pushing **all** tool-calls into `parts` and **all** results into a single
trailing `tool` message. Then `applyAnthropicStructuralNormalisations` Pass 3
(`agent.ts:399-413`) splits the assistant message because tool-calls are
followed by later-step text.

Concrete trace of the request prefix:

```
# Step-1 request (after step 0)         # Step-2 request (after step 1)
assistant:[text0, think0, callA]        assistant:[text0, think0, text1, think1]   <- Pass-3 non-tool
tool:[resultA]                          assistant:[callA, callB]                    <- Pass-3 tool bucket
                                        tool:[resultA, resultB]
```

After the `@ai-sdk/anthropic` converter merges the two consecutive assistant
messages, the single Anthropic assistant turn is:

- step 1 cached: `[text0, think0, tool_use_A]`
- step 2 sends:  `[text0, think0, text1, think1, tool_use_A, tool_use_B]`

The two diverge **right after `think0`** (cached had `tool_use_A` next; step 2
has `text1`). Anthropic's longest-prefix match ends at roughly
`static + user1 + text0 + think0`. Everything from there on — including
`resultA`, which was the cached tail one step earlier but is now re-grouped with
`resultB` — becomes a **cache write**.

Every additional step pushes all prior `tool_use` blocks further back and
re-groups all results, so:

- the matchable read prefix stays ≈ constant (static prefix + first step),
- the re-written suffix grows with the entire turn,
- cumulative `cache_write` balloons, `cache_read` stays low, and the **largest
  (last) request has the lowest hit rate**.

This reproduces every symptom in the panel.

### Why it slipped through

The caching tests (`packages/core/tests/agent/agent.test.ts:1034`, `:1078`) only
exercise a *single* step with parallel calls (3 reads → one tool message), which
is correct. The **multi-step accumulation path has no test**, and that's the
path that churns.

### Contrast with OpenCode

OpenCode's native loop appends each step as its own stable `assistant` + `tool`
message pair (`[system, user, assistant0, tool0, assistant1, tool1, …]`). Those
never move, so its rolling cache accumulates. Dispatch's "one growing assistant
message, re-derive the split each step" is the divergence.

## Secondary findings (smaller, worth noting)

1. **Per-turn session-id rotation.** `createProvider` runs inside `run()` and
   mints a new `X-Claude-Code-Session-Id` per turn (`provider.ts:92`, called at
   `agent.ts:745`). Within a turn it's stable, but if the `prompt-caching-scope`
   beta keys cache by session, cross-turn reads are lost on top of the
   within-turn churn. *Confidence: medium — verify against Anthropic's scope
   semantics.*
2. **Reasoning empty-text filter diverges from OpenCode.** Dispatch drops any
   `reasoning` part with `text === ""` (`agent.ts:356-360`); OpenCode keeps it
   when a signature / `redactedData` is present (`transform.ts:144-150`).
   Dropping a signed-but-empty thinking block changes assistant bytes and can
   break thinking-signature round-trips. Minor vs. the primary issue.
3. **5-minute ephemeral TTL** — generic: idle gaps > 5 min between turns force a
   cold re-write regardless of the above.

## Recommended fix direction (not yet implemented)

Make the wire history **stable across steps** by emitting one `assistant` + one
`tool` message **per step (per `tool-batch` chunk)** instead of collapsing the
whole turn into one assistant message and one trailing tool message. Concretely,
in `toModelMessages`, segment the assistant chunks at each `tool-batch` boundary
and emit `[assistant(text, think, tool-calls), tool(results)]` per segment. This:

- keeps the intended within-step grouping (parallel calls in one step → one tool
  message), satisfying the existing "Root Cause 2" tests,
- preserves earlier steps' block positions so the rolling cache accumulates,
- removes the Pass-3 reshuffle trigger (no later-step text after a tool-call
  within a single message),
- and matches OpenCode's stable message layout.

Add a regression test for a **3-step sequential** turn asserting the step-0 and
step-1 message blocks are byte-identical between the step-2 and step-3 requests.

## Key files

| Area | Location |
| --- | --- |
| Turn accumulator (single assistant msg) | `packages/core/src/agent/agent.ts:786`, `:923-926` |
| New tool-batch chunk per step | `packages/core/src/chunks/append.ts:111-124` |
| Rebuild + group all results | `packages/core/src/agent/agent.ts:162-256` |
| Pass-3 reshuffle (split) | `packages/core/src/agent/agent.ts:399-413` |
| Breakpoints (faithful port) | `packages/core/src/agent/agent.ts:448-466` |
| OpenCode reference `applyCaching` | `references/opencode/packages/opencode/src/provider/transform.ts:345-394` |
| Beta headers | `packages/core/src/credentials/anthropic-betas.ts:13-20` |
| Per-run session id | `packages/core/src/llm/provider.ts:92` |
| OAuth body transform | `packages/core/src/llm/anthropic-oauth-transform.ts` |
| Cache Rate panel + aggregation | `packages/frontend/src/lib/components/CacheRatePanel.svelte`, `packages/frontend/src/lib/tabs.svelte.ts:856-877` |
| Caching tests (single-step only) | `packages/core/tests/agent/agent.test.ts:1034`, `:1078` |
