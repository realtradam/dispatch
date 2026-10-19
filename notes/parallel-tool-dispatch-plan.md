# Plan — Run concurrency-safe tools in parallel

Status: approved by user, ready to implement
Branch: `feature/parallel-tool-dispatch`
Out of scope: SSH / remote execution (leave untouched).

---

## 1. Why

`defaultDispatchPolicy()` (`packages/session-orchestrator/src/pure.ts` ~L132)
hard-codes `{ maxConcurrent: 1, eager: true }`, and nothing wires the
orchestrator's `resolveDispatch` dep (`orchestrator.ts` ~L498, used ~L1033), so
**every turn runs tools strictly one at a time** — even tools already marked
`concurrencySafe: true` (`read_file`, `web_search`, `youtube_transcript`,
`lsp`, `read_image`, `consult_vision`, `load_skill`).

When a model batches several slow, safe calls in one step (web searches,
transcripts, LSP queries), the step takes the **sum** of their latencies
instead of the **max**.

The kernel dispatcher (`packages/kernel/src/runtime/dispatch.ts`) already
handles mixed batches correctly:
- a tool with `concurrencySafe === false` only starts when nothing else is
  running, and blocks everything behind it while it runs;
- the queue is head-of-line ordered, so a `read_file` issued after an
  `edit_file` waits for the edit (call order is preserved across the barrier);
- identical calls (same name + same JSON input) within a step are de-duplicated
  to one execution (existing behavior — unchanged by this feature).

So the change is mostly policy + an audit of tool flags.

## 2. Changes

### 2.1 New default policy + override (`packages/session-orchestrator`)
- Change `defaultDispatchPolicy()` to `{ maxConcurrent: 4, eager: true }`.
  (A cap rather than unlimited `0`: the contract doc in
  `kernel/src/contracts/dispatch.ts` flags unlimited as a deliberate opt-in.)
- Wire `resolveDispatch` in `packages/session-orchestrator/src/extension.ts`
  (both places the orchestrator deps are built, if there are two — check ~L60
  and ~L221) so an operator can override via environment variable
  `DISPATCH_TOOL_MAX_CONCURRENT` (integer ≥ 0; 0 = unlimited, 1 = sequential).
  Read/validate it at the edge (extension), not in pure code; invalid values →
  log a warning and use the default. `eager` stays `true`.
  Keep the parsing/validation in a small pure function with unit tests.
- Update tests that assert the old default.

### 2.2 Docs
- `packages/kernel/src/contracts/dispatch.ts`: update the **doc comment** only
  ("Default: …") to the new default. No code change in the kernel.
- `AGENTS.md` (root of this backend repo), section "Tool dispatch (kernel turn
  loop)": update the stated default to `{ maxConcurrent: 4, eager: true }` and
  mention the `DISPATCH_TOOL_MAX_CONCURRENT` override. You are authorized to
  edit exactly that section.

### 2.3 Audit every tool's `concurrencySafe` flag
The dispatcher treats a **missing** flag as safe
(`next.tool?.concurrencySafe !== false`). With parallelism on, that default now
matters. Every bundled tool must declare the flag **explicitly**.

Known unflagged tools (verify with search; there may be more, including tools
contributed through filters):
- `packages/agent-management/src/tools/*` — `summon_agent`,
  `list_agent_models`, `list_agents`, `read_agent`, `send_agent_message`,
  `cancel_agent_message`, `open_agent`. Decide per tool: read-only listing/reading
  tools → `true`; tools that create conversations or mutate shared state → think
  about whether two concurrent calls could race (e.g. two `summon_agent` calls
  in one step, two `send_agent_message` to the same conversation). Pick the safe
  answer and justify each in the report.
- `packages/plugin-scaffold/src/extension.ts` — `scaffold_echo` (template):
  set explicitly, and make sure the scaffold template that generates new plugins
  also sets it explicitly so new tools don't silently default to safe.

**Do not edit** these packages — they are owned by other in-flight features:
`packages/lsp`, `packages/vision-handoff`, `packages/conversation-store`,
`packages/tool-edit-file`, `packages/tool-write-file`. They already declare the
flag explicitly. If you believe one of their flags is wrong under parallelism
(e.g. two concurrent `lsp` diagnostics calls on the same file), **report it in
your final reply** instead of editing.

### 2.4 MCP: honor `readOnlyHint` (`packages/mcp`)
All MCP tools are hard-coded `concurrencySafe: false` (`registry.ts` ~L47).
The MCP spec lets servers annotate tools in `tools/list` with
`annotations: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }`.
- Add optional `annotations` to `McpToolInfo` (`types.ts`) and make sure the
  client passes it through from `tools/list`.
- `concurrencySafe = annotations?.readOnlyHint === true`. Everything else stays
  `false` (conservative default — hints are untrusted, but a server claiming
  read-only is the best signal we have).
- Tests: a tool with `readOnlyHint: true` → safe; missing/false → unsafe;
  `destructiveHint: true` with `readOnlyHint: true` → treat as **unsafe**
  (contradictory → conservative).

## 3. Tests
- Pure: env parsing (`"4"`, `"0"`, `"1"`, `""`, `"-1"`, `"abc"`, `"2.5"`).
- Kernel dispatch already has tests; confirm (don't rewrite) there is coverage
  for: safe tools overlapping, unsafe tool exclusive, order preserved across an
  unsafe barrier, maxConcurrent cap respected. Add a test **only if** a case is
  missing — kernel tests must use zero internal mocks (AGENTS.md).
- Orchestrator: the policy handed to `runTurn` reflects the default / override.
- MCP: annotation mapping as above.
- Agent-management: flags present on every tool (a simple assertion test is fine).

## 4. Verification gate
`bun install`, `bun run typecheck`, `bun run test`, `bun run check` (and
`bun run test:bun` if touched) — all green. Optionally run `bin/up` from
`worktrees/parallel-tool-dispatch/` (stop any running stack first; same ports)
and have an agent issue several `web_search` calls in one step to confirm they
overlap. Commit to `feature/parallel-tool-dispatch` only. Do not merge or push.
Write the report per AGENTS.md "Reports".
