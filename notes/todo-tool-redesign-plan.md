# Todo/Task tool redesign — port opencode's effective design into Dispatch

## 1. What each implementation does today

### Dispatch (current — disabled because it confused agents)
- Tool name: `todo`. **Imperative CRUD** with 5 actions: `add`, `update`, `list`, `get`, `remove`.
- Each task gets a **server-assigned opaque id** (`task-1`, `task-2`, …) returned by `add`.
- To mutate state the model must call `update` / `remove` **with the right `task_id`**.
- `TaskItem = { id, title, description, status }`, status `pending | in_progress | done | blocked`.
- Wiring: `packages/core/src/tools/task-list.ts` (class `TaskList` + `createTaskListTool`),
  instantiated per-tab in `packages/api/src/agent-manager.ts`, broadcast via the
  `task-list-update` agent event, rendered by `packages/frontend/.../TaskListPanel.svelte`.

### opencode (effective)
- Tool name: `todowrite`. **One declarative action**: a single param `todos` containing the
  **entire list**. Every call **replaces** the whole list.
- Todo shape: `{ content, status, priority }`. **No ids exposed to the model.**
- Statuses: `pending | in_progress | completed | cancelled`. Priority: `high | medium | low`.
- Rich tool description (`todowrite.txt`) + heavy **system-prompt reinforcement**
  (`prompt/anthropic.txt` "Task Management" section) with worked examples of the *flow*.
- Persisted per session, broadcast via a `todo.updated` bus event to the UI.

## 2. Why opencode's is effective and Dispatch's spirals

The single biggest problem with Dispatch's version is that it is an **imperative, id-based,
multi-action API**. That creates several failure modes that make weaker models spiral:

1. **Id bookkeeping.** The model must remember each `task-N` id returned by `add` and reference
   it later. LLMs lose track, **guess an id**, and hit `Error: Task with ID 'task-3' not found`,
   then thrash trying to re-sync with `list`/`get`.
2. **Many round-trips.** Setting up a 5-item plan and marking one in progress is **6+ tool calls**
   (5×`add` + 1×`update`). Re-planning means `remove`+`add` churn.
3. **Delta reasoning.** The model has to reason about *current server state* vs *desired state* and
   emit the diff. LLMs are far better at emitting a **full desired state**.
4. **Inconsistent surface.** `blocked` exists in the type but is never explained in the prompt and
   isn't rendered — dead state that invites confusion.

opencode's `todowrite` removes the entire class of problems: it is **declarative / idempotent**.
The model emits the full desired list each time; no ids, no deltas, no "not found" errors, and a
5-item plan + one in-progress is **one call**. The strong description + system-prompt examples teach
the *cadence* (write list → mark in_progress → work → mark completed → next).

## 3. Plan for Dispatch

Goal: keep all existing plumbing (tool **name `todo`**, the `task-list-update` event, the
`TaskList` per-tab store, the sidebar panel) but swap the **imperative CRUD interface for a
declarative whole-list write**, matching opencode's model. Keeping the name `todo` means zero churn
in the allowlist/summon/loader/permission wiring and existing agent TOMLs.

### Core (`packages/core`)
1. `types/index.ts`
   - `TaskStatus = "pending" | "in_progress" | "completed" | "cancelled"`.
   - `TaskPriority = "high" | "medium" | "low"`.
   - `TaskItem = { id; content; status; priority }` (`id` kept = positional, for UI keying + event
     contract; **never shown to the model**).
2. `tools/task-list.ts`
   - Replace the CRUD `TaskList` (add/update/get/remove) with a declarative store:
     `setTasks(items)` rebuilds the list (positional ids), `getTasks()`, `onChange()`.
   - `createTaskListTool` exposes ONE param `todos: Array<{content, status, priority}>`; `execute`
     calls `setTasks` and echoes the canonical stored list back (without ids). Robust defaults:
     missing `priority`→`medium`, missing/invalid `status`→`pending`, empty array clears the list.
   - New rich `TODO_DESCRIPTION` ported/adapted from opencode's `todowrite.txt` (When to use / When
     NOT / States / Rules / Examples), emphasising "send the whole list every time, no ids".

### API (`packages/api/src/agent-manager.ts`)
3. Replace `TODO_GUIDANCE` with an opencode-style **"Task Management"** system-prompt section:
   declarative whole-list semantics, "use it VERY frequently", one `in_progress` at a time, mark
   completed immediately, plus the two worked examples. Update `TOOL_DESCRIPTIONS.todo`.
   (Wiring via `createTaskListTool(tabAgent.taskList)` and `onChange → task-list-update` is unchanged.)

### Frontend (`packages/frontend`)
4. `lib/types.ts`: mirror the new `TaskItem` (`{ id, content, status, priority }` + new status union).
5. `lib/components/TaskListPanel.svelte`: render `content`; map statuses (completed→checked/struck,
   in_progress→indeterminate/bold, cancelled→dim/struck, pending→empty); subtle `high` priority hint;
   update the counter label (`completed`/`in progress`).

### Tests + verification
6. `packages/core/tests/tools/task-list.test.ts`: empty list, whole-list replace, status/priority
   preservation, default priority, `onChange` fires, tool `execute` updates store + echoes no ids.
7. `bun run typecheck` (core), `bun run test` (vitest), `bun run check` (biome).

### Out of scope / deliberately unchanged
- Tool name stays `todo`; `expandAgentToolNames`, summon defaults, permission keys, agent TOMLs
  untouched.
- Persistence to DB (opencode stores todos in SQLite) is **not** added — Dispatch keeps the existing
  in-memory per-tab `TaskList`; the visible/UX behaviour is what was failing, and that's what we fix.

---

## As-built (implemented on branch td/todo-fix)

Implemented the opencode-style declarative whole-list `todo` tool. **Deviations from the plan above:**

- **No `priority`.** Dropped per product decision. `TaskItem = { id, content, status }`;
  the tool param is `todos: Array<{ content, status }>`.
- **Reload reliability fix (new).** Todos previously blanked on page reload because they were
  broadcast only via the `task-list-update` change event and were absent from the reconnect
  snapshot. `TabStatusSnapshot` now carries an optional `tasks` field (core + frontend mirror);
  `getAllStatuses()` includes each tab's `taskList.getTasks()` for ALL tabs (omitted when empty).
  The frontend hydrates `tasks` from the snapshot in both restore paths (initial `GET /status`
  map and the `statuses` WS handler) instead of hardcoding `tasks: []`. Still in-memory per-tab
  (no DB; does not survive a server restart).
- **Statuses:** `pending | in_progress | completed | cancelled` (as planned).
- **UI:** the existing sidebar **Tasks** panel (`TaskListPanel.svelte`) was upgraded to render
  `content`, all four statuses (completed→checked+strikethrough, in_progress→indeterminate+bold,
  cancelled→dim+strikethrough, pending→empty) and a `completed/active` progress counter. No new
  UI surfaces were added (panel only).
- **System prompt:** `TODO_GUIDANCE` replaced by a `TASK_MANAGEMENT_GUIDANCE` "Task Management"
  section adapted from opencode's `anthropic.txt`; `TOOL_DESCRIPTIONS.todo` and the tool's own
  `TODO_DESCRIPTION` adapted from `todowrite.txt`.

Verification: `bun run check` clean; `bun run test` 569 passing; all three packages typecheck.
