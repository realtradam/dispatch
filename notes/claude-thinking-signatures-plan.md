# Plan: persist & replay Anthropic thinking signatures

Branch `feature/claude-thinking-display` in BOTH repos:
- `worktrees/claude-thinking-display/backend/` — backend git worktree (off `dev`)
- `worktrees/claude-thinking-display/claude/` — claude-extension git worktree. Already has
  commit `e2c14f8` (display:"summarized", adaptive thinking for 4.7+, and an
  *omit-unsigned-thinking* replay fallback). Read `packages/provider-anthropic/THINKING.md` there.
- `frontend/`, `codex/`, `bin/` in the worktree dir are symlinks to the main checkouts — do not edit them.

The claude repo's tsconfig resolves `@dispatch/kernel` / `@dispatch/wire` via
`../backend/packages/*/dist`, which from the claude worktree now points at the **backend
worktree**. So: change + build the backend first, then the claude provider.

## Goal
Anthropic returns each thinking block with an opaque `signature` (and sometimes a
`redacted_thinking` block carrying opaque `data`). Anthropic requires those blocks to be sent
back **unchanged, in original order** alongside the `tool_use` they accompanied (required within a
tool-use turn, recommended across turns). Today the kernel drops the signature and merges
consecutive thinking blocks, so we can't. Make the signature/redacted payload flow:

provider SSE → ProviderEvent → runtime chunk → persisted chunk → reloaded history → provider request.

Docs: https://platform.claude.com/docs/en/build-with-claude/thinking (sections "Preserving thinking
blocks", "Redacted thinking", "Preserved thinking") and
https://platform.claude.com/docs/en/build-with-claude/preserved-thinking.

## 1. Wire (`backend/packages/wire/src/index.ts`)
Extend `ThinkingChunk` with OPTIONAL, provider-opaque replay fields (additive, back-compat — old
rows lack them, other providers never set them):
```ts
export interface ThinkingChunk {
  readonly type: "thinking";
  readonly text: string;
  /** Opaque provider signature for verbatim replay (Anthropic `signature`). Never render. */
  readonly signature?: string;
  /** Opaque redacted-thinking payload (Anthropic `redacted_thinking.data`); text is "". Never render. */
  readonly redactedData?: string;
}
```
Do NOT add a new chunk type (the frontend has exhaustive switches over `Chunk["type"]`).

## 2. Kernel provider contract (`backend/packages/kernel/src/contracts/provider.ts`)
Add an optional event that CLOSES the current thinking block:
```ts
/** End of one reasoning block. Optional: providers without signed reasoning never emit it. */
export interface ReasoningEndEvent {
  readonly type: "reasoning-end";
  readonly signature?: string;
  readonly redactedData?: string;
}
```
Add it to the `ProviderEvent` union and re-export from the kernel index as other events are.

## 3. Runtime (`backend/packages/kernel/src/runtime/run-turn.ts`)
- `appendThinkingDelta` currently appends to the last chunk if it is `thinking`, rebuilding the
  object as `{type, text}`. Change it so it only merges into an **open** thinking chunk (one that
  has not been closed by `reasoning-end`) and never drops existing fields. Track "closed" without
  putting a flag on the persisted chunk (e.g. a local Set/index in the step state, or treat
  "has signature/redactedData" as closed).
- Handle `reasoning-end`: if the last chunk is an open thinking chunk, attach
  `signature`/`redactedData` and close it; otherwise (e.g. redacted block with no deltas) push a new
  `{ type: "thinking", text: "", signature?, redactedData? }` chunk. Emit NO outward AgentEvent
  (signatures never go to the frontend live stream). Not a first-token marker.
  > **Superseded (2026-10-22):** the kernel now emits a payload-free outward `reasoning-end`
  > event per block so live and persisted thinking split identically. Signatures/redacted data
  > still never leave the server. See `notes/reasoning-end-live-event-plan.md`.
- Consecutive thinking blocks must stay separate chunks (don't coalesce across a `reasoning-end`).
- `stripToolCallChunks` (aborted step): also strip `signature`/`redactedData` from thinking chunks
  in that message (a signed block whose tool_use was removed is a modified turn — degrade to
  unsigned, which the provider omits on replay). Drop now-empty thinking chunks if that leaves
  nothing meaningful; keep existing semantics otherwise.
- Audit every other place that reconstructs/copies thinking chunks (rg `"thinking"` across
  `backend/packages`, e.g. `conversation-store/src/reconcile.ts`, `openai-stream`, any compaction
  package) so the new fields survive persistence → `load()` → history. Persistence stores
  `JSON.stringify(chunk)` so it should round-trip automatically — verify with a test.
- `openai-stream` (OpenAI-compat providers) merges thinking into text; leave behavior as-is, just
  make sure nothing breaks.

## 4. Don't leak signatures to the frontend (nice-to-have, do it if cheap)
Signatures can be ~10 KB each. The FE history read path (`loadSince` via transport-http /
transport-ws) returns persisted chunks. If there is a single clean chokepoint, strip
`signature`/`redactedData` from thinking chunks in the FE-facing response. If it's invasive,
skip and note it. Never strip them from the provider-facing `load()` path.

## 5. Tests (backend)
- run-turn: deltas + `reasoning-end` produce a signed chunk; two thinking blocks stay two chunks;
  redacted-only block; providers that never emit `reasoning-end` behave exactly as before
  (consecutive deltas still merge); abort strips signatures.
- conversation-store: signed/redacted thinking chunks round-trip append → load.
- Then: `bun install`, typecheck, test, check/lint per backend AGENTS.md, and **build** the
  `wire` and `kernel` dist so the claude worktree resolves the new types.

## 6. Claude provider (`claude/packages/provider-anthropic`)
### stream.ts (SSE parser)
- Track block type per `index` from `content_block_start`.
- `thinking` block: keep emitting `reasoning-delta` for `thinking_delta` (including empty strings
  — an omitted-display block still needs a chunk); accumulate `signature_delta` per index; on
  `content_block_stop` emit `{ type: "reasoning-end", signature }`.
- `redacted_thinking` block: `content_block_start.content_block.data` → on stop emit
  `{ type: "reasoning-end", redactedData: data }`.
- Text deltas must remain a separate chunk after thinking (the runtime already alternates types).
### convert.ts (history → request)
- Build assistant content blocks **in chunk order** (no longer "all text, then tool_use"):
  - thinking with `signature` → `{ type: "thinking", thinking: text, signature }` (text EXACTLY as
    stored — any edit = 400)
  - thinking with `redactedData` → `{ type: "redacted_thinking", data }`
  - thinking without either → omit (keep the current fallback for old/unsigned/other-provider chunks)
  - adjacent text chunks → merged `text` block (skip empty); tool-call → `tool_use`
- Never put `cache_control` on a thinking/redacted_thinking block — adjust
  `applyRollingCacheBreakpoint` to target the last cacheable block.
- Only replay signatures when the request actually has thinking enabled? Anthropic accepts thinking
  blocks in history regardless; verify against docs and decide. Thinking from other Claude models
  is silently dropped by the API (documented) — fine.
### Prefix-binding safety net (important)
Anthropic validates a signature against everything before it (system, tools, earlier messages).
Our system blocks include the billing header (`cch=` hash patched per request), Dispatch's system
prompt may change between turns, and compaction rewrites history — any of these can invalidate
earlier blocks. For newer accounts the API **400s by default** on a prefix mismatch.
- On a 400 whose body indicates invalid/modified thinking blocks or signatures, retry ONCE with all
  thinking/redacted_thinking blocks stripped from history (same as today's fallback), and log a
  warning via the logger. Mirror the existing version-adoption retry loop structure.
- Research whether the `thinking-binding-controls-2026-08-01` beta +
  `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` is a better primary mechanism.
  Note: adding a beta header changes the Claude Code mimicry fingerprint (`claude-mimicry/betas.ts`)
  — only do it if real Claude Code sends it; otherwise rely on the retry fallback. Document the
  decision in THINKING.md.
### Tests
- SSE: signature accumulation, redacted block, two thinking blocks, empty omitted block.
- convert: ordered thinking/text/tool_use; signed vs unsigned vs redacted; cache_control placement.
- stream: 400-on-bad-thinking retry strips thinking and succeeds.
- Update `THINKING.md` to describe the final design (remove the "backend follow-up" section).

## 7. Verification & commit
- Backend worktree: typecheck/test/check green; commit to `feature/claude-thinking-display`.
- Claude worktree: typecheck/test/check green against the rebuilt backend dist; commit.
- Do NOT stop/restart the running Dispatch server (it's the one hosting this conversation, ports
  24203–24205). If you want a live API probe, write a small standalone script that calls
  `streamAnthropic` twice (turn with a tool call, then the follow-up with the signed history) using
  the real Claude credentials resolver — no server restart. Delete or don't commit secrets/output.
- Do NOT merge or push. Do NOT edit the frontend or codex repos.
