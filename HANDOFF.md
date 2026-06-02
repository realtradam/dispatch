# Handoff — tab/fix-tab-messaging-tool: cross-tab messaging tools usable when granted

## Summary
Agents could be granted the cross-tab messaging tools (`send_to_tab` / `read_tab`) yet
behaved as if they didn't have them — claiming they were "incapable" and refusing to call
them. **Root cause:** the tools were correctly registered, permission-gated, resolved
per-tab, and executable, and their JSON schemas WERE sent to the model — but the agent's
**system prompt** enumerates "You have access to the following tools" by filtering tool
names through a static `TOOL_DESCRIPTIONS` map, and that map had **no entries** for
`send_to_tab` / `read_tab`. So the prompt explicitly told the model it lacked them.

After fixing the core bug, two follow-up behavioral/prompting issues surfaced in live
testing and were also fixed in the tool context:
1. The **sender busy-waited** (ran `sleep`/polled) for a reply instead of ending its turn.
2. The **recipient replied to its own user in plain text** instead of routing the answer
   back through `send_to_tab` to the sender.
A third refinement made every `read_tab` mention **conditional** on the tab actually
holding `read_tab` (the permissions are split, so a tab can have `send_to_tab` without
`read_tab` — advertising a tool it wasn't granted is wrong).

## What changed (and why)
- **Advertise the tools (the actual bug):** added `send_to_tab` + `read_tab` entries to
  `TOOL_DESCRIPTIONS` so the system prompt's capability list matches the granted toolset.
- **Stop sender busy-wait:** the `send_to_tab` tool description, its delivery-result text,
  and the system-prompt one-liner now say plainly: do NOT sleep/poll/run commands to wait;
  if the target replies it will **WAKE you with a new message** in a later turn; keep
  working if you have other tasks, else **end your turn**.
- **Fix recipient reply routing:** the delivered-message wrapper now states the message is
  from **another agent, NOT your user**, and that to reply you must use `send_to_tab`
  addressed back to the sender's handle — and **ONLY** if asked (it may just be context).
  A plain text response reaches only the recipient's own user.
- **Conditional `read_tab` guidance:** `createSendToTabTool` takes a new `canReadTab`
  callback flag. `AgentManager.buildTabCommToolEntries(tabId, canReadTab)` passes it
  (`allowed.has("read_tab")` on the child path; `permReadTab` on the parent path). The
  description + result text only reference `read_tab` when the tab actually has it. The
  static `TOOL_DESCRIPTIONS.send_to_tab` one-liner dropped its `read_tab` phrasing (it
  can't be per-tab conditional there).

## Files changed
- `packages/api/src/agent-manager.ts`
  - `TOOL_DESCRIPTIONS`: added `send_to_tab` + `read_tab`; `send_to_tab` one-liner carries
    the no-busy-wait / wake-you-with-a-new-message guidance (no `read_tab` reference).
  - `buildTabCommToolEntries(tabId, canReadTab)`: new param, forwarded into
    `createSendToTabTool` as `canReadTab`. Both call sites updated
    (`allowed.has("read_tab")` / `permReadTab`).
- `packages/core/src/tools/send-to-tab.ts`
  - `SendToTabCallbacks` gained `canReadTab: boolean`.
  - Description built conditionally (the `read_tab` follow-up line only appears when
    `canReadTab`); "WAKE you with a new message" phrasing; recipient reply-contract footer
    with **ONLY** uppercased; header marks sender as another agent (not your user).
  - Delivery-result text built conditionally (mentions `read_tab` only when `canReadTab`).
- `packages/api/tests/agent-manager.test.ts`
  - Agent mock now captures `config.systemPrompt`; new describe block
    "send_to_tab / read_tab system-prompt advertisement" (5 tests) asserts the prompt lists
    the granted tab tools (and omits ungranted ones), locking the prompt list to the schema.
- `packages/core/tests/tools/send-to-tab.test.ts`
  - `makeCallbacks` default `canReadTab: true`; assertions for provenance header/footer,
    **ONLY** uppercase, no-busy-wait/end-your-turn, "wake you with a new message", and both
    `canReadTab` branches (description + result text) for `read_tab` presence/absence.

## Public surface changed
- **`@dispatch/core` — `SendToTabCallbacks`**: added required field `canReadTab: boolean`.
  Any external caller of `createSendToTabTool` must now supply it. (In-repo, the only caller
  is `AgentManager.buildTabCommToolEntries`, updated here.)
- No changes to tool NAMES, permission keys, registry, execution path, wire formats, DB, or
  the frontend. Tool behavior (delivery routing, auto-wake budget, resolution) is unchanged
  — only the advertised/contextual text and the new `canReadTab` plumbing.

## Verification status
- `bun run check` (biome): **clean** (165 files, no fixes).
- `bun run test`: **594 passing** (37 files). (Baseline was 585; +9 new tests.)
- `tsc --noEmit` core + api: **0 errors**.
- `svelte-check` (frontend): **0 errors, 0 warnings**.
- Re-verified after `git merge --no-edit dev` (already up to date) immediately before push.

## Published
**Yes.** `dev` was already an ancestor of this branch (clean fast-forward, no merge commit
needed). Fast-forwarded `dev`: `c0c0872..e4379da`. User confirmed the fix before merge.

Commits (oldest→newest):
- `9c89ec9` advertise send_to_tab/read_tab in the agent system prompt (+ regression tests)
- `e475e52` clearer send_to_tab context to stop busy-wait + wrong-recipient replies
- `aa295e8` only mention read_tab when the sender actually has it; CAPS on ONLY
- `e4379da` say a reply will WAKE you with a new message

## Assumptions / known gaps
- The static `TOOL_DESCRIPTIONS.send_to_tab` system-prompt one-liner can't be per-tab
  conditional, so it deliberately omits any `read_tab` reference. The precise, conditional
  `read_tab` guidance lives in the tool's own description/result (which ARE per-tab).
- `read_tab` itself was already truthful (it's only present when granted); no description
  changes were needed there.
- These are prompting/UX nudges — model adherence isn't guaranteed, but the wording now
  matches actual runtime behavior (split perms, wake-on-reply, reply-via-tool).
- Pre-existing untracked dirs in the worktree root (e.g. `bookmark-manager/` noted in a
  prior handoff) were left untouched; not part of this feature.
