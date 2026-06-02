# Handoff — m1/minor-fixes

Three small, independent UI fixes in the Dispatch frontend.

## Files changed
- `packages/frontend/src/lib/components/CacheRatePanel.svelte`
  - **Fix 1:** Added `whitespace-nowrap` to the requests-count badge (`{cacheStats.requests} req`) so it no longer wraps to a second line.
  - **Fix 2:** Removed the trailing explanatory paragraph ("Cache reads cost ~10% of fresh input; writes cost ~25% more…").
- `packages/frontend/src/lib/components/KeyUsage.svelte`
  - **Fix 3:** Added `pacedProgressClass(percentUsed, elapsedPct)` and applied it to the 5 bars that render a "time dot" (Claude 5-Hour/Weekly, opencode-go 5-Hour/Weekly/Monthly).

## Public surface changed
- None externally. No exported API, prop, or type changes.
- New module-internal helper `pacedProgressClass` in `KeyUsage.svelte` (not exported). Existing `progressClass` retained and reused as the fallback.

## Fix 3 coloring logic
`pacedProgressClass(percentUsed, elapsedPct)`:
- `percentUsed >= 90` → `progress-error` (red) — always, per spec.
- no time dot (`elapsedPct < 0`, e.g. missing `resetsAt`) → fall back to existing `progressClass` thresholds.
- `percentUsed <= elapsedPct` → `progress-success` (green; equal counts as green/on-pace).
- otherwise (usage ran ahead of the dot) → `progress-warning` (orange).

Applied only to the 5 dot-bearing bars. The 3 Copilot/Gemini bars were intentionally left on the original `progressClass` (confirmed unused/out of scope by the requester).

## Verification status — PASS
- `bun run check` (biome): **PASS** — "Checked 163 files… No fixes applied."
- `bun run test` (vitest): **PASS** — 35 test files, 552 tests passed.
- Re-verified after `git merge --no-edit dev` (was already up to date) — still all-green.
- Note: `bun install` was required first; deps were not present in the worktree.

## Published
- Yes. Committed `084f4d7`, merged `dev` down (already up to date), pushed fast-forward `7c527b4..084f4d7 → dev`.

## Assumptions / known gaps
- Per requester: Copilot & Gemini usage bars are unused, so they keep the old threshold coloring (untouched).
- Red threshold is `>= 90%` (exactly 90 is red); tie between usage and the dot resolves to green — both confirmed by requester.
- Dot-less / hidden-dot cycle bars fall back to the original `progressClass` thresholds (confirmed option "a").
- Changes are presentation-only (Tailwind/daisyUI classes + a coloring helper); no automated tests were added for the Svelte markup, consistent with the existing repo (no component-render tests for these panels). User visually confirmed the result before publish.
