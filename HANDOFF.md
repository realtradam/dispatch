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
  branch. Imported `DebugPanel`.
- `packages/frontend/src/lib/components/SettingsPanel.svelte` — added a
  `THEMES` list + `currentTheme` state + `selectTheme` helper at the top
  of the script, and a "Theme → Appearance" `<select>` as the first
  section in the panel body. Same localStorage key (`dispatch-theme`)
  and same DOM-attribute application as `ThemeSwitcher` had, so the
  boot-time theme apply in `App.svelte`'s `onMount` keeps working
  unchanged.

### Added
- `packages/frontend/src/lib/components/DebugPanel.svelte` — new
  sidebar panel grouping dev-facing actions. Currently exposes one
  button: "Copy conversation" (the old header behavior, ported as-is —
  wraps `tabStore.copyConversation()` and shows a 1.5 s
  "Copied" / "Failed" affordance). Sized as a full-width primary button
  in a labeled "Conversation" sub-section; layout/style matches sibling
  panels (`bg-base-200` wrapper handled by `SidebarPanel`, uppercase
  section header, body in `flex flex-col gap-3`).

### Deleted
- `packages/frontend/src/lib/components/ThemeSwitcher.svelte` — was a
  58-line `<dialog>` modal; its only consumer was `Header.svelte`. All
  of its contents (theme list, current-theme state, selectTheme, the
  localStorage key) were inlined into `SettingsPanel.svelte`.

## Public surface changes

- **New sidebar panel type id**: `"Debug"` — selectable from the
  `<select>` dropdown on any sidebar slot.
- **Removed component**: `ThemeSwitcher` (no other importers; safe).
- **Component prop changes**: none. `Header.svelte`'s only prop
  (`onToggleSidebar: () => void`) is unchanged. `SidebarPanel.svelte`,
  `SettingsPanel.svelte`, and `DebugPanel.svelte` keep / introduce
  prop shapes consistent with neighboring panels.

## LocalStorage migration

No migration is needed.

- `dispatch-theme` localStorage key: unchanged shape, unchanged
  consumers (boot apply in `App.svelte:onMount`, write in
  `selectTheme`). A user reloading after this branch sees their
  previously-selected theme intact.
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
Checked 140 files in 172ms. No fixes applied.
```
Exit code: 0.

### `bun run test`
```
Test Files  24 passed (24)
     Tests  393 passed (393)
  Start at  09:15:17
  Duration  2.87s
```
Exit code: 0. (Includes the existing `sidebar-storage.test.ts` 15-test
suite — no test changes were required since storage semantics didn't
change.)

### `bun run typecheck` (svelte-check)
```
svelte-check found 0 errors and 0 warnings
```

### Build
```
vite v6.4.2 building for production...
✓ 166 modules transformed.
✓ built in 3.97s
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
  - `ThemeSwitcher` / `showThemeSwitcher` symbols are absent (count: 0) ✓
  - Theme list (`dracula`, `cyberpunk`, `caramellatte`) and
    `dispatch-theme` storage key are bundled into SettingsPanel ✓

For a human visual pass: `bun run dev:api` + `bun run dev:frontend`,
then verify:
1. Header has only `Dispatch | … | Connection · Sidebar`.
2. Add a sidebar slot via `+`, choose "Settings" → "Theme" section
   appears at the top with a working `<select>` of all 13 themes.
3. Add another sidebar slot, choose "Debug" → "Copy conversation"
   button works and flashes "Copied" for 1.5 s.

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
- **No interactive-browser smoke test was run.** The environment
  doesn't ship a browser harness; build + preview + bundle-grep is the
  closest equivalent, and svelte-check confirms type/template
  correctness. Recommend a 30-second manual eyeball before merge.
- **`ThemeSwitcher.svelte` was deleted, not retained.** Worth noting
  because the brief said either was fine. Choice rationale: it had
  one importer (`Header.svelte`), 58 lines, and using a modal from
  inside a sidebar panel would be a UX regression.

## Commits (atomic)

```
751e411 feat(settings): inline theme picker into Settings panel
dd3c71e feat(sidebar): add Debug panel with copy-conversation action
bbc85ff feat(header): remove copy + theme buttons; keep title, status, sidebar toggle
```

Each commit is independent and reviewable on its own.
