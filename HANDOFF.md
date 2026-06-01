# H3 — Header Declutter

Branch: `h3/header-declutter` (branched off `dev`)
Worktree: `/home/tradam/projects/dispatch/h3-header-declutter`

## Summary

The app header used to be: **`Dispatch | … | Connection · Copy · Theme · Sidebar`** — four right-aligned buttons, two of them unrelated to navigation.

It is now: **`Dispatch | … | Connection · Sidebar`**.

The two removed buttons moved into the sidebar where the rest of the app's
controls already live:

| Button     | Old location               | New location                                   |
| ---------- | -------------------------- | ---------------------------------------------- |
| **Copy**   | Header                     | New **Debug** sidebar panel                    |
| **Theme**  | Header → `ThemeSwitcher` modal | Inlined as a section in the **Settings** sidebar panel |

`ThemeSwitcher.svelte` was deleted; its theme list + apply-and-persist logic
was inlined into `SettingsPanel.svelte` (a sidebar panel doesn't need a
modal, and Settings already owns all other UI preferences).

A post-implementation Gemini review surfaced a real bug in the first cut
(the Settings panel's hardcoded `"dark"` default disagreed with the
DOM's actual first-paint theme, which was `light` via daisyUI fallback).
That's fixed by a shared `lib/theme.ts` module; see commit `6c377fb`.

## Files

### Modified
- `packages/frontend/src/lib/components/Header.svelte` — removed Copy
  button, Theme button, ThemeSwitcher import, `showThemeSwitcher` state,
  `copyLabel` state, `handleCopy` / `resetCopyLabel` helpers, and the
  `{#if showThemeSwitcher}` block. Only the Dispatch title (left),
  connection status indicator, and Sidebar toggle (right) remain.
- `packages/frontend/src/lib/components/SidebarPanel.svelte` — registered
  `"Debug"` as a new entry in `viewOptions` (last in the list) and added
  the corresponding `{:else if panel.selected === "Debug"} <DebugPanel />`
  branch. Imported `DebugPanel`. Also added `aria-label="Remove panel"`
  to the per-slot ✕ button (pre-existing a11y nit found in review).
- `packages/frontend/src/lib/components/SettingsPanel.svelte` — added a
  Theme `<select>` as the first section in the panel body. After the
  Gemini-review fix this now uses `lib/theme.ts` for constants, default
  value, and apply/persist (removed the duplicated `THEMES` array,
  `THEME_STORAGE_KEY` const, and inline `selectTheme` logic that
  hardcoded a conflicting `"dark"` fallback).
- `packages/frontend/src/App.svelte` — onMount theme apply switched from
  the bare `localStorage.getItem(...)` + conditional `setAttribute` to
  `applyTheme(loadStoredTheme())` from `lib/theme.js`, so the first
  paint always matches what Settings will show as the selected option
  (including on a fresh install where nothing is stored — previously
  this branched and the DOM was left untouched).
- `.gitignore` — added `claude-report.md` so the Gemini review artifact
  in the working tree doesn't get accidentally committed.

### Added
- `packages/frontend/src/lib/components/DebugPanel.svelte` — new
  sidebar panel grouping dev-facing actions. Currently exposes one
  button: "Copy conversation" (the old header behavior, ported as-is —
  wraps `tabStore.copyConversation()` and shows a 1.5 s
  "Copied" / "Failed" affordance). Sized as a full-width primary button
  in a labeled "Conversation" sub-section; layout/style matches sibling
  panels (`bg-base-200` wrapper handled by `SidebarPanel`, uppercase
  section header, body in `flex flex-col gap-3`).
- `packages/frontend/src/lib/theme.ts` — single source of truth for the
  theme picker: `THEMES` tuple, `Theme` type, `THEME_STORAGE_KEY`,
  `DEFAULT_THEME` (= `"dark"`), `loadStoredTheme()`, `applyTheme()`.
  Handles SSR (`localStorage` undefined), `SecurityError` on read,
  `QuotaExceededError` on write, and unknown stored values (e.g. a
  theme that was removed from the list).
- `packages/frontend/tests/theme.test.ts` — 11 unit tests covering the
  default-fallback, known/unknown stored values, SecurityError on
  read, SSR (no `localStorage`), DOM-attribute write, persistence
  round-trip, and the "DOM still updates even if storage write throws"
  contract. Follows the same in-memory-mock pattern as
  `sidebar-storage.test.ts`.

### Deleted
- `packages/frontend/src/lib/components/ThemeSwitcher.svelte` — was a
  58-line `<dialog>` modal; its only consumer was `Header.svelte`. All
  of its contents (theme list, current-theme state, selectTheme, the
  localStorage key) were inlined into `SettingsPanel.svelte` and (post-
  review) extracted further into `lib/theme.ts`.

## Public surface changes

- **New sidebar panel type id**: `"Debug"` — selectable from the
  `<select>` dropdown on any sidebar slot.
- **Removed component**: `ThemeSwitcher` (no other importers; safe).
- **New module**: `packages/frontend/src/lib/theme.ts` (exports
  `THEMES`, `Theme`, `THEME_STORAGE_KEY`, `DEFAULT_THEME`,
  `loadStoredTheme`, `applyTheme`). Anyone needing to read or write
  the app theme should import from here.
- **Component prop changes**: none. `Header.svelte`'s only prop
  (`onToggleSidebar: () => void`) is unchanged. `SidebarPanel.svelte`,
  `SettingsPanel.svelte`, and `DebugPanel.svelte` keep / introduce
  prop shapes consistent with neighboring panels.

## LocalStorage migration

No migration is needed.

- `dispatch-theme` localStorage key: unchanged shape, unchanged
  consumers (boot apply in `App.svelte`'s `onMount`, write in
  `applyTheme`). A user reloading after this branch sees their
  previously-selected theme intact. A user with a stored value that
  is no longer in `THEMES` (e.g. someone removed a daisyUI theme later)
  now falls back to `DEFAULT_THEME` cleanly — previously they'd have
  silently rendered the bad value as a `data-theme` attribute that
  daisyUI doesn't recognize.
- `dispatch-sidebar-panels` (the sidebar layout): the existing
  `loadSidebarPanels` already filters non-string entries and falls
  back to the default layout when nothing valid is stored. Adding
  `"Debug"` to `viewOptions` is purely additive: existing users
  with stored layouts continue to render exactly what they had
  before, and the new option becomes available to anyone who opens
  the dropdown. No code change to `sidebar-storage.ts` was required.

## Verification

### `bun run check`
```
$ biome check .
Checked 142 files in 171ms. No fixes applied.
```
Exit code: 0.

### `bun run test`
```
Test Files  25 passed (25)
     Tests  404 passed (404)
  Start at  09:45:10
  Duration  2.76s
```
Exit code: 0. (393 pre-existing tests + 11 new `theme.test.ts` tests.)

### `bun run --cwd packages/frontend typecheck` (svelte-check)
```
svelte-check found 0 errors and 0 warnings
```

### Build
```
vite v6.4.2 building for production...
✓ 167 modules transformed.
✓ built in 3.91s
```

### Manual UI smoke (programmatic)
Full interactive `dev:frontend` + `dev:api` boot wasn't run from this
CLI environment, but the equivalents were exercised:

- Production build (`vite build`) succeeds — confirms all components
  compile and Svelte's reactivity contracts are satisfied.
- `vite preview` boots and serves the HTML shell on port 4173.
- Static grep over the built bundle confirms the post-refactor wiring:
  - `"Debug"` appears in the bundle as a panel option ✓
  - `"Copy conversation"` button label is present ✓
  - `ThemeSwitcher` / `showThemeSwitcher` symbols are absent ✓
  - Theme list (`dracula`, `cyberpunk`, `caramellatte`) and
    `dispatch-theme` storage key are bundled ✓

For a human visual pass: `bun run dev:api` + `bun run dev:frontend`,
then verify:
1. Header has only `Dispatch | … | Connection · Sidebar`.
2. **Fresh install** (clear `dispatch-theme` from localStorage): first
   paint should be **dark** (the new `DEFAULT_THEME`), matching what
   the Settings dropdown shows. Before the post-review fix the first
   paint was *light* while Settings showed *dark*.
3. Add a sidebar slot via `+`, choose "Settings" → "Theme → Appearance"
   `<select>` shows all 13 themes and applies immediately.
4. Add another sidebar slot, choose "Debug" → "Copy conversation"
   button works and flashes "Copied" for 1.5 s.

## Code-review pass

`HANDOFF.md` committed at `60999dc` triggered a second-opinion code
review by Gemini 3 Flash Preview (the user asked for "flash 3.1
preview"; the API doesn't expose a 3.1 flash variant yet — only
`gemini-3-flash-preview` and `gemini-3.1-pro-preview` exist as of this
writing). The review report (untracked, gitignored) is at
`claude-report.md` in the worktree root.

Findings triaged:

| # | Severity | Verdict | Disposition |
|---|----------|---------|-------------|
| 1 | Major   | **Real bug.** App.svelte left DOM untouched on first load (daisyUI fell back to `light`); SettingsPanel hardcoded `"dark"` UI fallback. | **Fixed** in commit `6c377fb` via shared `lib/theme.ts`. |
| 2 | Minor   | **Real, pre-existing pattern**, not specific to this branch. Two `SettingsPanel` instances would also drift on `autoExpandThinking`, `localChunkLimit`, `backendUrl` — all of which already worked this way before this branch. | **Deferred.** Out of scope for "declutter the header." Would require lifting all of Settings' state into `appSettings.svelte.ts`, which is a separate refactor. |
| 3 | Minor/nit | **Real, fixed by #1.** | Subsumed by `6c377fb`. (Only the daisyUI `@plugin` block in `app.css` remains as a parallel theme list; that's a CSS-time concern and can't be imported from TS — kept in sync by convention, noted in the new module's doc comment.) |
| 4 | Nit     | **Real, pre-existing.** ✕ button on remove-panel had no aria-label. | **Fixed** in commit `5ea668d` while touching the file. |

Open recommendations from Gemini that were intentionally *not* taken:

- **"Add a 'System' theme option** that reads
  `prefers-color-scheme`." — Out of scope for this branch (it's a
  feature, not a bug). The existing daisyUI theme list already
  includes both `light` and `dark`; users can pick. Worth filing as a
  separate ticket.
- **"Move all `localStorage` keys to `lib/config.ts` or
  `lib/storage.ts`."** — This branch already adds one such module
  (`lib/theme.ts`) for the theme key. A broader audit (chunk limit,
  auto-expand, backend URL, sidebar layout, theme) belongs in its own
  refactor; doing it here would balloon the diff.
- **"Theme should not be first in Settings; functional things first."**
  — Subjective. Current order (Theme → Title Generation → Chat →
  Memory → Backend URL) puts user-visible appearance up top; happy to
  swap if preferred.

## Assumptions / known gaps

- **No dev-only gate on the Debug panel.** The brief flagged this as
  a possible question; I chose consistency — all other panel types are
  always available, and there's no existing dev-flag plumbing to hook
  into. Easy to add later if desired.
- **Theme picker is a `<select>`, not a vertical menu.** The original
  `ThemeSwitcher` used a menu of buttons because it was a modal with
  the room to display all 13 themes at once. Inside the sidebar a
  `<select>` is more compact and matches the existing pattern for
  every other "pick one of N" control in `SettingsPanel`
  (key, model, etc.).
- **Settings section order.** Theme is now first
  (Theme → Title Generation → Chat → Memory → Backend URL); rationale
  is that Theme is the most user-visible preference. If a different
  order is preferred this is a one-block move.
- **Multiple Settings panels desync** (Gemini #2). Open `Settings`
  twice in the sidebar, change theme in one — only that one's `<select>`
  updates; the other still shows the previous value (the DOM and
  storage are correct, only the second component's local `currentTheme`
  state is stale). Same is true today for `autoExpandThinking`,
  `localChunkLimit`, `backendUrl`. Fixing it requires hoisting state
  into a shared reactive store — out of scope for "declutter the
  header" and noted for follow-up.
- **No interactive-browser smoke test was run.** The environment
  doesn't ship a browser harness; build + preview + bundle-grep is the
  closest equivalent, and svelte-check confirms type/template
  correctness. Recommend a 30-second manual eyeball before merge —
  particularly to confirm the fresh-install theme now matches Settings.
- **`ThemeSwitcher.svelte` was deleted, not retained.** Worth noting
  because the brief said either was fine. Choice rationale: it had
  one importer (`Header.svelte`), 58 lines, and using a modal from
  inside a sidebar panel would be a UX regression.

## Commits (atomic)

```
5ea668d a11y(sidebar): label the remove-panel button for screen readers
6c377fb fix(theme): consolidate boot apply and Settings picker into shared module
60999dc docs: add HANDOFF.md for h3 header declutter
751e411 feat(settings): inline theme picker into Settings panel
dd3c71e feat(sidebar): add Debug panel with copy-conversation action
bbc85ff feat(header): remove copy + theme buttons; keep title, status, sidebar toggle
```

The first three (`bbc85ff` → `751e411`) are the original refactor.
`60999dc` is the initial handoff. `6c377fb` and `5ea668d` are the
post-Gemini-review fixes. Each commit is independent and reviewable on
its own.
