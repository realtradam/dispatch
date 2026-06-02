# Handoff — td/todo-fix: declarative todo/task system

## Summary
Replaced Dispatch's imperative, id-based `todo` tool (actions `add`/`update`/`list`/`get`/`remove`)
with opencode's **declarative whole-list** design, and fixed the panel blanking on reload. The tool
name (`todo`), the `task-list-update` event, the per-tab `TaskList` store, and the sidebar **Tasks**
panel are all preserved — only the interface, status model, and UI rendering changed.

## What changed (and why it's better)
- **Declarative whole-list write** (from opencode's `todowrite`): the model sends the *entire*
  desired list in one `todos` param each call; the store replaces its list. No model-visible ids,
  no delta reasoning, no "task not found" spirals, no multi-call churn — the failure modes that made
  the old CRUD tool confuse weaker models.
- **Status lifecycle:** `pending | in_progress | completed | cancelled` (was `pending | in_progress |
  done | blocked`; `blocked` was dead/unrendered state).
- **No `priority`** (deliberately dropped per product decision; opencode has it, we don't).
- **Reload reliability:** todos used to blank on page reload (broadcast only on change, absent from
  the reconnect snapshot). Now `TabStatusSnapshot` carries per-tab `tasks`, so the panel rehydrates
  from the backend on reload/reconnect. Still **in-memory per-tab** (no DB; does not survive a server
  restart).

## Files changed
- `packages/core/src/types/index.ts` — `TaskStatus` union; `TaskItem = { id, content, status }`
  (`id` internal/positional, never shown to the model); `TabStatusSnapshot.tasks?`.
- `packages/core/src/tools/task-list.ts` — rewrote `TaskList` (declarative `setTasks`/`getTasks`/
  `onChange`); `createTaskListTool` with a single `todos` param that echoes the stored list without
  ids; new exported `TODO_DESCRIPTION` (adapted from opencode `todowrite.txt`).
- `packages/core/src/index.ts` — export `TODO_DESCRIPTION`.
- `packages/api/src/agent-manager.ts` — `TODO_GUIDANCE` → `TASK_MANAGEMENT_GUIDANCE` (system-prompt
  section adapted from opencode `anthropic.txt`); updated `TOOL_DESCRIPTIONS.todo`; `getAllStatuses()`
  now includes each tab's `tasks` (all tabs, omitted when empty).
- `packages/frontend/src/lib/types.ts` — mirror `TaskItem` + `TabStatusSnapshot.tasks`.
- `packages/frontend/src/lib/tabs.svelte.ts` — hydrate `tasks` from the snapshot in both restore
  paths (initial `GET /status` map + `statuses` WS handler); updated debug-dump label.
- `packages/frontend/src/lib/components/TaskListPanel.svelte` — render `content`; all four statuses
  (completed→checked+strikethrough, in_progress→indeterminate+bold, cancelled→dim+strikethrough,
  pending→empty); `completed/active` progress counter. Sidebar panel only — nothing relocated.
- `packages/core/tests/tools/task-list.test.ts` — new (15 tests).
- `packages/api/tests/agent-manager.test.ts`, `packages/api/tests/routes.test.ts` — updated
  `TaskList` mocks to the declarative shape; added `getAllStatuses` task-snapshot coverage.
- `notes/todo-tool-redesign-plan.md` — appended an "As-built" section.

## Public surface changed
- **Tool `todo`**: parameters changed from `{ action, title, description, task_id, status }` to a
  single `{ todos: Array<{ content, status }> }`. Statuses `pending|in_progress|completed|cancelled`.
- **`@dispatch/core` exports**: added `TODO_DESCRIPTION`. `TaskItem` shape changed (`title`+
  `description` → `content`; status union changed). `TaskList` methods changed (`addTask`/`updateTask`/
  `removeTask`/`getTask` removed; `setTasks` added).
- **`TabStatusSnapshot`** (wire format, core + frontend mirror) gained optional `tasks`.
- Tool name, allowlist/loader/summon/permission wiring, agent TOMLs: **unchanged**.

## Verification status
- `bun run check` (biome): clean.
- `bun run test`: **585 passing** (37 files).
- `tsc --noEmit` (core, api) + `svelte-check` (frontend): 0 errors.
- Verified post-merge of `dev`.

## Published
Yes. Merged `dev` down (no conflicts), re-verified all-green, fast-forwarded
`dev` → `9d6b7a9`. User confirmed the task system works before merge.

## Assumptions / known gaps
- No DB persistence: todos are in-memory per-tab and do not survive a server restart (matches scope;
  opencode persists to SQLite — intentionally not ported).
- No `priority` field (dropped per decision).
- No new UI surfaces — the existing sidebar Tasks panel only.
- An unrelated untracked `bookmark-manager/` directory exists in the worktree root; it is not part of
  this feature and was left untouched (never staged/committed).
