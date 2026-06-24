# Handoff → orchestrator (bcb5): broken-chat self-repair

> From: diagnostic session. Agent/conversation `77574596`
> (`77574596-3e7b-46f8-8d67-c9e17a529dee`) "broke unrecoverably." User goal:
> **chats must self-heal when broken so they can continue.** Implement the fixes
> below. Full diagnosis + plan also in `reports/broken-chat-repair-diagnosis.md`.

## 0. Your job (TL;DR)

`reconcile()` only repairs orphaned tool-calls. The production DB has **two other
broken states** it doesn't handle, and they make a chat uncontinuable. Implement a
read-time repair so broken chats auto-heal on next open — **no DB surgery**
(append-only durability preserved; repair is a turn-path transform that runs on
every `load()`). Three units, two repos:

- **Wave 1 (arch-rewrite, PARALLEL — disjoint packages):**
  - `conversation-store` — extend `reconcile` (Layer 1) + harden `load()`.
  - `openai-stream` — harden `convertMessages` args (Layer 2).
- **Wave 2 (separate repo `../claude`, SEPARATE agent):**
  - `provider-anthropic` — harden its `safeJson` (Layer 2 equivalent).

**Key architectural insight that shapes the waves:** Layer 1 lives in
`conversation-store.reconcile`, which runs in `load()` BEFORE any provider sees
the messages. So the Layer 1 fix protects **every** provider (openai-compat AND
anthropic) — the Claude plugin needs **no** Layer 1 change. Layer 2 (malformed
tool-call args) is **per-provider** serialization safety, so it must be applied
in each provider's converter (openai-stream + provider-anthropic).

## 1. The break (what actually happened in `77574596`)

Production DB: `/var/lib/dispatch/dispatch.db` (systemd `dispatch.service`).
136 chunks; seq counter = 136; **all JSON valid; no orphaned tool-calls** — so
`reconcile()` finds nothing wrong, yet the chat is uncontinuable. The tail:

| seq | role | type | note |
|---|---|---|---|
| 133 | assistant | text | "Wave 0 fully verified…" |
| 134 | assistant | tool-call | `todo_write`, `input` = **malformed JSON** (`json_type=text`, raw string) |
| 135 | tool | tool-result | isError: "todo_write args must be an object with a `todos` array" |
| 136 | assistant | **error** | `HTTP 400: unexpected character: line 1 column 1413 (char 1412). Received Model Group=glm-5.2` |

### Root cause (confirmed byte-for-byte)
- seq 134's `input` is a raw string. Parsing it fails
  `Expecting ':' delimiter: line 1 column 1413 (char 1412)` — an **exact match** to
  the provider's `unexpected character: line 1 column 1413`. The **model emitted
  malformed JSON as the `todo_write` arguments**.
- Chain: model emits text + malformed-args tool-call (step 5) → kernel dispatches
  the tool, which returns an error result (seq 135) → kernel calls the provider
  again (step 6); the request re-includes the assistant message carrying the
  malformed `arguments` → provider 400s → persisted as an `error` chunk (seq 136).

### Why it's "unrecoverable"
- `openai-stream` `convertAssistantMessage` serializes tool-call args as
  `typeof c.input === "string" ? c.input : JSON.stringify(c.input)` — passes the
  malformed string straight through as the OpenAI `arguments` field → provider
  400s on **every** continuation.
- The trailing `assistant` message whose only chunk is `error` serializes to
  `content:""` + no tool_calls (error chunk is filtered out, leaving an empty
  assistant message) → also uncontinuable.
- `reconcile()` touches neither. `load()` also has no try/catch on
  `JSON.parse(value)` — a single corrupt row would throw and brick the chat.

### Scope (production DB, 140 conversations)
- **6 conversations end in a trailing `error` chunk:** `102587c0`(seq2, HTTP 401
  model-not-supported), `2bf78252`(seq2), `61127511`(seq250), `77574596`(seq136),
  `d0d85eca`(seq2), `e1ee0989`(seq20).
- **2 tool-calls total** carry a raw malformed-string `input`.
- `102587c0` has **only** the trailing-error break (no args, no tool-calls) —
  proving Layer 1 is independently necessary. `77574596` has **both**.

## 2. The fix

### Layer 1 — `conversation-store` `reconcile.ts` (structural repair)
Extend `reconcileWithReport` to:
1. **Strip `error` chunks from assistant messages.** An `error` chunk is a
   failed-generation marker, never valid provider content (no provider understands
   an "error" content type) — provider-agnostic.
2. **Drop any assistant message left with no `text` and no `tool-call` chunks**
   (the now-empty error-only message). This is what unblocks continuation. **Safe:**
   an error-only step ends with no tool-calls, so it is never followed by a `tool`
   message — no "tool-without-preceding-assistant-tool_calls" 400 can result. Keep
   the existing orphaned-tool-call synthesis unchanged.
3. Extend `ReconcileReport` with counts of stripped error chunks / dropped messages
   (for the existing `reconcile.repair` boot/log span).

Why here: the constitution designates `reconcile` as "the pure function run on load
that repairs any partial turn." A trailing error-only assistant message IS a
partial/broken turn. Pure, provider-agnostic, runs on every `load()` → auto-repairs
all 6 broken chats. Repair is read-time only; storage (append-only) untouched.
`loadSince` (FE reads) is intentionally NOT reconciled, so the user still SEES the
error while the provider gets clean history.

### Hardening — `conversation-store` `store.ts` `load()` (same unit)
Wrap the per-chunk `JSON.parse(value)` in try/catch: on a corrupt/unparseable row,
log + skip it (don't throw) so `reconcile` can still run on the rest. Today a single
bad row makes `load()` throw → unrecoverable. (0 such rows today; "never leave the
system broken" asks for it.)

### Layer 2 — `openai-stream` `convert-messages.ts` (serialization safety)
In `convertAssistantMessage`, ensure a tool-call's `arguments` is **always a valid
JSON string**: if `input` is a string, `JSON.parse` it; on failure substitute a
valid fallback object (e.g. `JSON.stringify({})` or a wrapped
`{ _malformed_arguments: <truncated> }`). Objects pass through `JSON.stringify` as
today. This neutralizes already-stored malformed args (seq 134) so the provider
stops 400ing on continuation. Follow the SAME semantics as the Claude fix below
(isolation over DRY: each provider reimplements locally, same behavior).

### Layer 2 (equivalent) — `../claude` `provider-anthropic` `convert.ts` (SEPARATE agent)
The Claude plugin already has a `safeJson(s)` helper (line ~115) used at
`input: typeof c.input === "string" ? safeJson(c.input) : c.input`. But its fallback
**returns the raw string `s` on parse failure** — for Anthropic, `tool_use.input`
must be an object, so a raw string can still 400 when a historical malformed tool_use
is re-sent. Fix: make `safeJson` return a **valid object fallback** (e.g. `{}`) on
parse failure instead of the raw string. (Layer 1 does NOT apply here — the
arch-rewrite `reconcile` already strips error chunks before the Claude provider sees
the messages, so the Claude converter never receives error-only assistant messages.)

## 3. Waves & summoning

- **Wave 1 (arch-rewrite, PARALLEL):** `conversation-store` (Layer 1 + `load()`
  hardening) and `openai-stream` (Layer 2). Disjoint packages, no contract/type
  change, both depend only on already-built `@dispatch/kernel` contracts. Standard
  summon per ORCHESTRATOR §2/§3 (attach the scoped rules: conversation-store gets
  `pure-core.md`+`no-internal-mocks.md`+`typed-handles.md`+`extension-logging.md`;
  openai-stream gets `pure-core.md`+`no-internal-mocks.md`+`extension-logging.md`;
  both get `one-owner.md`+`isolation-over-dry.md`+`biome-clean.md`+`package-agent.md`+
  `extension-agent.md`).
- **Wave 2 (separate repo, SEPARATE agent):** summon against
  `--cwd /home/tradam/projects/dispatch/claude` for `packages/provider-anthropic`
  (`convert.ts` `safeJson`). That repo has its own `AGENTS.md`; attach the
  arch-rewrite `package-agent.md`+scoped rules as needed. Can run in parallel with
  Wave 1 (different repo, no shared files).

## 4. Why this auto-heals `77574596` (and the other 5) — no DB surgery
On next open/continue, `load()` returns history ending at seq 135 (the tool-result):
Layer 1 strips the seq-136 error message; Layer 2 sanitizes the seq-134 args to
valid JSON. The provider receives
`[…, assistant{text+tool-call(args:{})}, tool{error result}]` — a valid "continue
after a tool result" state. The model sees its `todo_write` failed and adjusts.
Chat continues. Same auto-repair applies to the other 5 (Layer 1 alone for the
401/empty cases; Layer 1+2 for any malformed-args case).

## 5. Test requirements (regression scar tissue)

**conversation-store `reconcile.test.ts`:**
- `reconcile strips error-only trailing assistant message` (the 77574596/102587c0
  shape: `[user, assistant{error}]` → `[user]`).
- `reconcile strips error chunk but keeps sibling text`
  (`assistant{text,error}` → `assistant{text}`).
- `reconcile drops assistant message left empty after stripping error`
  (`assistant{error}` only → dropped).
- `reconcile keeps tool-call + strips error` (`assistant{tool-call,error}` with a
  matching result → `assistant{tool-call}`).
- existing orphaned-tool-call behavior unchanged (regression).
- (hardening) corrupt-JSON chunk row is skipped, rest load + reconcile.

**openai-stream `convert-messages.test.ts`:**
- `arguments is valid JSON when input is a malformed string` (seed from seq 134's
  raw string → output `JSON.parse`s, no throw).
- `arguments passes through valid string input` and `stringifies object input`
  (regression).

**provider-anthropic `convert.test.ts` (claude repo):**
- `safeJson returns a valid object fallback on malformed string` (raw malformed
  string → `{}` or wrapped object, not the raw string).
- `safeJson parses valid string input` (regression).

## 6. Verify (ORCHESTRATOR §4)
`bun run typecheck && bun run test && bun run check` whole-project green; both agents
in-lane (`git status --short`); zero internal mocks in the pure-core units. Live-spot:
open `77574596` against a probe/`bin/up` and confirm it now continues past the tool
result instead of 400-looping.

## 7. Notes / out of scope
- **Parse-time prevention** (openai-stream / provider-anthropic could reject or
  repair malformed args when the model emits them, instead of storing a raw
  string) is a deeper follow-up; Layer 2 is the safety net that also repairs
  already-stored data.
- Deploying the fix auto-repairs the 6 broken production chats on next load — no
  migration needed.
