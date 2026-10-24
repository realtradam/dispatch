# Plan: forward `reasoning-end` to clients as a live AgentEvent

Branch: `feature/fix-ongoing-chat-tool-calls` (backend + frontend worktrees).
Follow-up to frontend commit `6f91e07` ("keep tool calls visible when opening an
in-flight chat").

## 1. Why

Claude returns several thinking blocks in one step, each with its own signature. The
provider (`claude/packages/provider-anthropic/src/stream.ts`) already yields one
`ProviderEvent { type: "reasoning-end", signature? | redactedData? }` per block, and the
kernel (`packages/kernel/src/runtime/run-turn.ts` → `closeThinkingBlock`) uses it to
persist **one thinking chunk per block**. But per the original design in
`notes/claude-thinking-signatures-plan.md`, it emits **no outward AgentEvent**. So the live
stream (and the late-join replay buffer, which merges adjacent same-type deltas) delivers
consecutive blocks as **one** merged thinking chunk, while HTTP history has **N** chunks.

Effects:
- The live transcript shows one "Thoughts" bubble where history (after reload/seal) shows
  several, so the rendering changes at seal.
- The frontend's replay-vs-history de-dup (`frontend/src/core/chunks/selectors.ts`,
  `committedOverlap`) can't line up 1:1. Commit `6f91e07` added a defensive
  concatenation match (`mergedRun`). That stays as a fallback for older servers/replays,
  but the wire should carry the boundary so live == persisted by construction.
- Redacted-only blocks persist as empty `{ type: "thinking", text: "" }` rows (history keeps
  them; see `transport-http/src/logic.ts`). Live has no counterpart at all today.

**Decision (reverses the "emit NO outward AgentEvent" line in
`claude-thinking-signatures-plan.md`):** the kernel emits an outward
`reasoning-end` event for **every** provider `reasoning-end`. It carries **no** opaque
payload (signature / redactedData never go to clients, same as HTTP history). This is an
**additive** wire change: no version bump, documented as a delta (repo convention).

The `claude` repo needs **NO changes** and must **NOT** be edited (it's a shared main checkout).

## 2. Exact semantics the frontend must mirror (the kernel's chunk builder)

Kernel today (`run-turn.ts`):
- `reasoning-delta`: if the LAST chunk of the step is an OPEN thinking chunk, append to it;
  else push a new thinking chunk `{ type: "thinking", text: delta }`.
- `reasoning-end`: if the LAST chunk is an OPEN thinking chunk, close it (attach payload);
  else push a new CLOSED empty thinking chunk `{ type: "thinking", text: "" , …payload }`.
- Any other chunk (text, tool-call) also ends the "last chunk is open thinking" condition.

So after this change, for every persisted thinking chunk there is exactly one live
`reasoning-end` (plus zero or more preceding `reasoning-delta`s with no other content
event in between). Providers that never emit `reasoning-end` (OpenAI-compat, etc.) behave
exactly as before: no outward `reasoning-end`, deltas merge as today.

## 3. Backend changes (`/path/to/dispatch/worktrees/fix-ongoing-chat-tool-calls/backend`)

### 3.1 `packages/wire/src/index.ts`
- Add to the `AgentEvent` union, right after `TurnReasoningDeltaEvent`:
  ```ts
  /**
   * End of one reasoning / thinking block. Emitted once per block by providers with
   * block-structured reasoning (e.g. Anthropic, whose consecutive thinking blocks — each
   * separately signed — persist as separate thinking chunks). Lets a live consumer split
   * thinking exactly as history does: the open thinking chunk closes; if none is open (a
   * redacted/empty block with no deltas) an EMPTY thinking chunk is implied. Carries no
   * content: the opaque replay payloads (signature / redacted data) never leave the
   * server. Providers without block structure never emit it (deltas merge as before).
   */
  export interface TurnReasoningEndEvent {
    readonly type: "reasoning-end";
    readonly conversationId: string;
    readonly turnId: string;
  }
  ```
- Make sure it's exported wherever `TurnReasoningDeltaEvent` is re-exported (check
  `packages/kernel/src/contracts/events.ts` + `contracts/index.ts`, and
  `packages/transport-contract` if it re-exports wire event types). Use `rg` to find
  every re-export site.

### 3.2 `packages/kernel/src/runtime/events.ts`
- Add a factory beside `reasoningDeltaEvent`:
  `export function reasoningEndEvent(conversationId: string, turnId: string): AgentEvent`
  → `{ type: "reasoning-end", conversationId, turnId }`.

### 3.3 `packages/kernel/src/runtime/run-turn.ts` (`processEvent`)
- In `case "reasoning-end":` keep `closeThinkingBlock(...)` exactly as is, then
  `ctx.emit(reasoningEndEvent(ctx.conversationId, ctx.turnId));`.
- Do **NOT** call `markFirstToken` for it (it isn't a first-token marker; keep the comment
  accurate. Update "Replay-only content: no live event" to say it emits a payload-free
  boundary event).
- Update the `ReasoningEndEvent` doc comment in `packages/kernel/src/contracts/provider.ts`:
  replace "Produces no outward event" with "Produces a payload-free outward
  `reasoning-end` event (block boundary); never a first-token marker."
- Kernel purity: no I/O. Nothing else changes.

### 3.4 `packages/session-orchestrator/src/pure.ts` (replay buffer)
- No logic change should be needed: `mergeDeltas` only merges a delta into the
  immediately preceding node, so a `reasoning-end` node between two `reasoning-delta`s
  keeps them separate, and `reasoning-end` is never dropped (only `status` / finished
  `tool-output` nodes are removed). **Verify this with tests** (3.6). If a test shows
  otherwise, fix `pure.ts` minimally.

### 3.5 Other backend consumers of `AgentEvent`
- `packages/cli/src/render.ts` `renderEvent`: add `case "reasoning-end":` →
  `return opts.showReasoning ? { stdout: "\n" } : undefined;` (keeps consecutive blocks
  visually separated when reasoning is shown). Add/adjust a render test.
- Run `bun run typecheck`. Any other exhaustive `switch` on `AgentEvent["type"]` that now
  fails must get a `reasoning-end` case that behaves like a no-op unless there's an
  obvious reason otherwise. Use `rg -n '"reasoning-delta"' packages` to find the
  candidates (known: `wire`, `kernel`, `session-orchestrator/pure.ts`, `cli/render.ts`,
  `openai-stream/parse-sse.ts`; the last is a PROVIDER-side parser and should NOT change).

### 3.6 Backend tests (vitest; pure units have zero internal mocks)
- `packages/kernel/src/runtime/run-turn.test.ts`, `describe("reasoning block
  boundaries")`: for each scripted case, also assert the OUTWARD events. Example: for
  `[delta "first", end sig-1, delta "second", end sig-2]` the emitted event types
  (filtering to reasoning-*) are
  `["reasoning-delta","reasoning-end","reasoning-delta","reasoning-end"]`. Assert every
  emitted `reasoning-end` has exactly the keys `type`, `conversationId`, `turnId` (NO
  `signature` / `redactedData`). Assert the redacted-only case emits one `reasoning-end` per
  block with no preceding delta. Assert the "legacy deltas still merge" case emits NO
  `reasoning-end`. Fix any existing assertion that lists exact emitted event types for a
  script containing `reasoning-end`.
- Add a TTFT/first-token test only if a timing test already covers reasoning: a step whose
  first provider event is `reasoning-end` (redacted block) must NOT mark the first token.
- `packages/session-orchestrator/src/pure.test.ts`: add tests that
  `compactReplay([d("a"), end, d("b"), end])` and the equivalent
  `appendCompacted` fold/`snapshotReplay` keep 4 events, with the deltas NOT merged, and
  that `[d("a"), d("b")]` (no end) still merges to one delta. If there is a seeded
  random equivalence test with an event generator, add `reasoning-end` to its generator.
- `packages/cli` render test for the new case.

### 3.7 Backend docs
- `notes/claude-thinking-signatures-plan.md`: add a short dated note at the
  "Emit NO outward AgentEvent" line saying it was superseded by this plan (link the file).
- Do not touch `GLOSSARY.md` (no new concept; `reasoning-end` is an existing provider-contract term).

### 3.8 Backend verification
```
cd /path/to/dispatch/worktrees/fix-ongoing-chat-tool-calls/backend
bun install
bun run typecheck   # must be clean; ALSO builds packages/*/dist which the frontend consumes
bun run test        # all green; note the count
bun run check       # biome clean
```
Commit: `feat(wire,kernel): emit a payload-free reasoning-end live event per thinking block`.

## 4. Frontend changes (`/path/to/dispatch/worktrees/fix-ongoing-chat-tool-calls/frontend`)

Read `frontend/AGENTS.md` first (pure core / thin Svelte / tests alongside).

### 4.0 Refresh the contract dependency
The frontend's `@dispatch/*` deps are `file:` COPIES of the backend packages' built `dist`.
After 3.8, run in the frontend worktree:
```
rm -rf node_modules/@dispatch && bun install
```
Then confirm `node_modules/@dispatch/wire/dist/index.d.ts` contains `TurnReasoningEndEvent`.

### 4.1 `src/core/wire/conformance.ts`
- `assertAgentEventExhaustive`: add `case "reasoning-end": return "reasoning-end";`
  (typecheck will fail until this exists, which is good).

### 4.2 `src/core/chunks/reducer.ts` (`reduceEvent`). This is the core of the change.
Add a case mirroring the kernel (section 2):
```ts
case "reasoning-end": {
  const acc = state.accumulating;
  // Close the open thinking block of this turn: flush it as its own provisional chunk.
  if (acc !== null && acc.kind === "thinking" && acc.turnId === event.turnId) {
    return {
      ...state,
      provisional: flushAccumulating(state.provisional, acc),
      accumulating: null,
      generating: true,
    };
  }
  // No open thinking (a redacted/empty block with no deltas): history persists an
  // EMPTY thinking chunk for it, so mirror that 1:1.
  return {
    ...state,
    provisional: [
      ...flushAccumulating(state.provisional, acc),
      { role: "assistant", chunk: { type: "thinking", text: "" }, turnId: event.turnId },
    ],
    accumulating: null,
    generating: true,
  };
}
```
- Add `"reasoning-end"` to `RETRY_CLEARING_EVENTS` (model output resumed).
- `foldEvent`'s stepId stamping does NOT need to include `reasoning-end` (later
  tool-call / step-complete stamps the flushed chunk, exactly like today).
- Update the `reduceEvent` doc-comment bullet list with the new event.
- Do NOT remove `mergedRun` / the alignment fallbacks in `selectors.ts`. They remain the
  defense for servers or replays without `reasoning-end`.

### 4.3 `src/core/metrics/cache-timer.ts`
- Add `case "reasoning-end":` to the same group as `"reasoning-delta"` (output from the
  next request ends the step gap).

### 4.4 Rendering
- No `.svelte` change. An empty provisional thinking chunk renders exactly as the
  committed empty thinking rows already do today (consistency is the point).

### 4.5 Frontend tests (vitest, pure; no mocks of our own modules)
In `src/core/chunks/reducer.test.ts` (new `describe("foldEvent — reasoning-end (thinking block boundary)")`):
1. `delta "a", end, delta "b", end` → two provisional thinking chunks `"a"`, `"b"`,
   `accumulating === null`.
2. `delta "a", delta "b"` (no end) → still ONE accumulating thinking `"ab"` (legacy).
3. `end` with nothing open → one provisional EMPTY thinking chunk tagged with the turnId.
4. `text-delta "x", end` → text flushed, then an empty thinking chunk (mirrors kernel).
5. `end` for a different turn than the accumulating thinking → the accumulating chunk is
   flushed and an empty thinking for the event's turn is appended (mirror rule).
6. A pending `providerRetry` banner is cleared by `reasoning-end`.

In `src/core/chunks/selectors.test.ts`:
7. Late-join alignment: committed history `[user "hi", thinking "first. ", thinking
   "second.", tool-call a, tool-result a]` + replay `[user-message, turn-start, delta
   "first. ", end, delta "second.", end, call a, result a, delta "next"]` → rendered is
   the 5 committed chunks + one streaming provisional thinking `"next"`. No duplicates.
8. Same with a redacted block: committed has `{thinking ""}` between the two, replay has
   an extra bare `end` → still no duplicates.

In `src/core/metrics/cache-timer.test.ts` (if a reasoning-delta case exists there): mirror it for `reasoning-end`.

### 4.6 Frontend docs
- `.dispatch/wire.reference.md`: add a dated "ADDITIVE, no version bump" delta paragraph at
  the top (follow the existing delta style) describing `TurnReasoningEndEvent`, AND add
  the interface + union member in the mirrored source section next to
  `TurnReasoningDeltaEvent`.
- `backend-handoff.md`: add a short entry noting the frontend consumes the new
  `reasoning-end` event (follow the file's existing format).

### 4.7 Frontend verification
```
cd /path/to/dispatch/worktrees/fix-ongoing-chat-tool-calls/frontend
bun run typecheck   # svelte-check: 0 errors
bun run test        # all green; note the count
bun run check       # biome clean
bun run build       # succeeds
```
Commit: `feat(chunks): split live thinking at reasoning-end block boundaries`.

## 5. Rules / guardrails
- Edit ONLY the files named above (plus tests next to them). Never edit the `claude` repo,
  never edit outside the two worktrees, never merge or push.
- Kernel stays pure (no I/O). Pure-core tests must not `vi.mock("@dispatch/*")`.
- Don't change history persistence, the HTTP projection, or chunk shapes.
- If something in this plan turns out to be wrong (e.g. a test proves the replay buffer
  DOES merge across `reasoning-end`), fix minimally and explain in the report.

## 6. Report
Write `backend/reports/reasoning-end-live-event.md` (gitignored): what changed in each
repo, the commit hashes, the typecheck/test/check/build output summaries (counts), and any
deviation from this plan with the reason.
