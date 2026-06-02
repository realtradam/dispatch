# Handoff — sb/status-bar

Add a status bar beneath the chat input that houses the send button and shows
generation status + context-window usage.

## Files changed
- `packages/frontend/src/lib/components/ChatInput.svelte` — restructured into
  **two stacked bars** (wrapped in `flex flex-col`):
  - **Top bar:** the existing auto-resizing textarea + a single, fixed-width
    (`w-20`) send/stop button that morphs in place so the layout never shifts.
    Three states:
    - not generating → `btn-primary` **Send**, disabled when the box is empty
      (unchanged look).
    - generating + empty box → **Stop** (`btn-error btn-outline`, spinner +
      "Stop"), calls `tabStore.stopGeneration(tabId)`.
    - generating + text in box → enabled **Send** (queues the message via
      `tabStore.sendMessage`).
  - **Bottom bar:** agent status icon on the left (✓ idle / spinner running /
    ✗ error), a context-window fill `progress` bar filling the middle, and a
    compact token count + percent on the right (e.g. `12.3k / 200k · 6.1%`).
    When the model's max context is unknown the bar renders inert/disabled
    (`opacity-40`, no value) and the right side shows the bare current token
    count with no percent. Before the first response it reads `— tokens`.
- `packages/frontend/src/App.svelte` — pass the already-computed `contextLimit`
  into `<ChatInput {contextLimit} />` (same value handed to the sidebar).

## Public surface changed
- `ChatInput.svelte` gained one optional prop: `contextLimit?: number | null`
  (defaults to `null`). No other exported API/type changes.
- Reuses the shared `computeContextUsage()` helper (`lib/context-window.ts`) and
  the same fill-color thresholds (calm→warning→danger) as the Context Window
  sidebar panel, so the two displays always agree. Compact `k`/`M` token
  formatting is local to `ChatInput` (the sidebar keeps full `toLocaleString`).

## Design decisions (agreed with requester)
- Two stacked bars; send button kept (not dropped) for discoverability.
- Send and Stop are the **same button** at a fixed width — no layout jump.
- Bottom bar: status icon left; context number + percent right; progress bar
  fills the remaining width; disabled/inert bar when the model has no known max.
- Token format: compact (`12.3k`) for the slim bar.

## Verification status — PASS
- `bun run check` (biome): **PASS** — "Checked 163 files… No fixes applied."
- `bun run test` (vitest): **PASS** — 35 files, 552 tests.
- `bun run --cwd packages/frontend typecheck` (svelte-check): **PASS** — 0
  errors, 0 warnings.
- Re-verified all three after `git merge --no-edit dev` — still all-green.
- Note: `bun install` was required first; deps were not present in the worktree.

## Published
- Yes. Feature commit `2756730`, merged `dev` down (`f0207a7`, clean merge —
  picked up another agent's CacheRatePanel/KeyUsage changes + their HANDOFF.md),
  pushed fast-forward `3f0bfe7..f0207a7 → dev`.
- This HANDOFF.md was rewritten from the incoming `m1/minor-fixes` handoff (that
  content remains preserved in git history on its own merge).

## Assumptions / known gaps
- User visually confirmed the UI before merge ("sweet, merge it in").
- No component-render tests were added for the Svelte markup, consistent with
  the existing repo (these panels have no render tests). Logic is exercised
  indirectly via the unchanged `computeContextUsage` unit tests.
- Context usage reflects the most recent turn (`last.inputTokens +
  last.outputTokens`) — identical semantics to the sidebar panel.
