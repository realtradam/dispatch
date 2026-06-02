# Handoff — perm/fix-user-agent-summon-permission

## Summary
Fixed a permissions bug: granting **only** the user-agent (top-level) permission
(`perm_user_agent`) without the subagent-summon permission (`perm_summon`) left
the agent unable to summon user agents. The whole `summon` tool was gated behind
`perm_summon`, so `perm_user_agent` alone produced no summon tool at all.

The two permissions are now fully independent in **both** directions:
- **`perm_summon` only** → spawn ordinary subagents (unchanged; no `top_level`).
- **`perm_user_agent` only** → `summon` is registered in *user-agent-only* mode:
  it spawns **only** top-level user agents (`top_level` forced on; the
  `top_level`/`background` params are dropped; the catalog lists user agents only;
  `retrieve` is NOT granted since user agents are fire-and-forget). This prevents
  the inverse leak (a user-agent-only grant cannot spawn plain subagents).
- **both** → full behavior, byte-for-byte identical to before.
- **neither** → no `summon` tool (unchanged).

## Root cause
`packages/api/src/agent-manager.ts`, parent tool-build path: `if (permSummon) { … }`
built the entire `summon` (+`retrieve`) tool. `perm_user_agent` only flipped the
`userAgentEnabled` flag *inside* that block, so without `perm_summon` the tool was
never created.

## Files changed
- `packages/core/src/tools/summon.ts`
  - `createSummonTool(...)` gained a trailing `subagentEnabled = true` param
    (mirrors `perm_summon`) alongside `userAgentEnabled` (mirrors `perm_user_agent`).
    Default `true` keeps every existing call site / mock behaving as before.
  - New internal `userAgentOnly = userAgentEnabled && !subagentEnabled` mode:
    description leads with user-agent spawning and omits subagent/parallel-work
    prose; `top_level` and `background` params are omitted; `execute()` forces
    `topLevel: true`; `agent` param lists only user-agent slugs.
  - `buildAgentsCatalog(...)` gained a `subagentEnabled` param and a user-agent-only
    branch ("User agents (spawned as independent top-level tabs):", no
    `requires top_level=true` suffix since it is implied).
- `packages/api/src/agent-manager.ts`
  - Parent path: `if (permSummon)` → `if (permSummon || permUserAgent)`.
  - Passes `permSummon` as the new `subagentEnabled` arg to `createSummonTool`.
  - `retrieve` is now only registered when `permSummon` is granted (bundled with
    the subagent capability; user agents are fire-and-forget).
  - Child/subagent path (`toolsOverride`, whitelist-driven) left untouched — out of
    scope per agreement.
- `packages/core/tests/tools/summon.test.ts`
  - New `user-agent-only mode` describe block (description content, catalog groups,
    `agent` slug list, omitted `top_level`/`background` params, forced
    `topLevel: true` on spawn).
  - New regression block asserting the `subagentEnabled` default keeps legacy
    subagent spawning unchanged.
- `packages/api/tests/agent-manager.test.ts`
  - New `summon / user_agent permission split` describe block: summon+retrieve when
    only `perm_summon`; **summon WITHOUT retrieve** when only `perm_user_agent`
    (the bug-fix regression); both → summon+retrieve; neither → neither.
  - `@dispatch/core` test mock gained `loadAgents`, `toAvailableSubagents`,
    `toAvailableUserAgents`, `getAgentDirPaths`, `GLOBAL_AGENTS_DIR` (the summon
    parent-branch was never exercised before, so these were missing).

## Public surface changed
- `createSummonTool(defaultWorkingDirectory, callbacks, availableSubagents?,
  availableUserAgents?, agentDirs?, userAgentEnabled?, subagentEnabled?)` — added a
  final optional `subagentEnabled` param (default `true`). Backward compatible:
  all existing callers omit it and keep prior behavior.
- No DB/schema/migration changes; both settings (`perm_summon`, `perm_user_agent`)
  already existed. No frontend changes (the "Spawn user agents" checkbox and
  independent `perm_user_agent` persistence already existed).

## Verification (post-merge with `dev`, all green)
- `bun run test` → **605 passed** (37 files). +15 net new tests on this branch
  (the +9 over the pre-merge 596 are from `dev`'s send_to_tab/read_tab prompt suite).
- `bun run check` (biome) → clean, "No fixes applied."
- `bun run --cwd packages/core typecheck` → clean.
- `bun run --cwd packages/api typecheck` → clean.
- `bun run --cwd packages/frontend typecheck` → 0 errors, 0 warnings.

## User test
Confirmed by the user: with only "Spawn user agents" granted (Summon agents OFF),
the agent receives the `summon` tool and can spawn a top-level user agent. ✅

## Published
Yes. Merged `dev` down into `perm/fix-user-agent-summon-permission` (resolved one
test-file conflict where this branch's new describe block and `dev`'s new
send_to_tab/read_tab system-prompt block landed at the same location — kept both),
re-ran all verification (green), and fast-forwarded:
`git push . HEAD:dev` → `e0b63c0..a243976  HEAD -> dev`.

Commits:
- `3ff2db6` fix(perm): decouple perm_user_agent from perm_summon for spawning user agents
- `a243976` Merge branch 'dev' into perm/fix-user-agent-summon-permission

## Assumptions / known gaps
- **Child/nested summon path unchanged** (per agreement #3): a spawned subagent gets
  `summon` only if `"summon"` is in its tool whitelist, and `userAgentEnabled` there
  still tracks the `perm_user_agent` DB setting. Decoupling nested user-agent
  spawning was deliberately out of scope.
- **`hasSummon` system-prompt note** (agent-manager ~line 163) still says "You have
  pre-configured subagent types… delegate to a subagent." In user-agent-only mode
  this wording is slightly off, but the `summon` tool's own (mode-correct)
  description carries the authoritative instructions. Left as-is to limit scope —
  flag if you want it tailored.
