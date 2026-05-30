# Changes Report

## Overview
This report reviews the uncommitted changes in the `dispatch` repository. The changes can be broadly categorized into two parts:
1. **Codebase Updates**: The removal of the `todo` (task list) tool and a fix to a `summon` tool test.
2. **Documentation Additions**: Several new untracked markdown documents regarding planning and incident reports.

## Per-File Analysis

### Untracked Files
- **`claude-auth-report.md`** & **`tool-runner-duplication-incident.md`**: New post-mortem and incident investigation reports.
- **`cyberdeck/credentials.md`**: Documentation regarding credentials.
- **`skill-plan/` directory**: Multiple markdown files outlining a multi-step plan for building a new "skill" architecture (tool definitions, registration, routes, etc.).

**Assessment**: Adding detailed markdown documents for incidents and project planning is a very good practice. They are cleanly separated from the application source code.

### Modified Files (Staged & Unstaged)

#### 1. `packages/core/src/tools/task-list.ts`
- **Change**: Removed the `createTaskListTool` function and the Zod/ToolDefinition imports. The `TaskList` class remains.
- **Correctness**: The removal of the factory is clean.

#### 2. `packages/api/src/agent-manager.ts`
- **Change**: Removed `createTaskListTool` imports and invocations. Removed `todo` from the `TOOL_DESCRIPTIONS` and the lengthy `TODO_GUIDANCE` string from the agent's system prompt. 
- **Correctness**: Consistently applies the removal of the `todo` tool. However, it still retains `tabAgent.taskList = new TaskList()`, which may now be dead state (see Issues section).

#### 3. `packages/core/src/agents/loader.ts` & `packages/core/src/tools/summon.ts`
- **Change**: Removed `"todo"` from the default tool arrays and documentation comments for child agents.
- **Correctness**: Follows through with the removal of the `todo` tool across tool lists, ensuring child agents don't request a missing tool.

#### 4. `packages/core/src/index.ts`
- **Change**: Updated exports to remove `createTaskListTool`, while keeping `TaskList`.
- **Correctness**: Correctly reflects the module changes.

#### 5. Tests (`packages/api/tests/*.test.ts` & `packages/core/tests/agents/loader.test.ts`)
- **Change**: Removed mocked `createTaskListTool` injections and updated assertions that previously verified the automatic injection of the `todo` tool.
- **Correctness**: Properly aligns tests with the new implementation. Build/tests should pass cleanly.

#### 6. `packages/core/tests/tools/summon.test.ts`
- **Change**: Updated the "surfaces child errors when blocking" test to correctly anticipate the `agent_id: <id>` prefix before the child output. Added an excellent explanatory comment about why this prefix exists (for frontend `ToolCallDisplay` regex parsing).
- **Correctness**: The change is highly robust. Explicitly asserting `.toContain()` before the final `.toBe()` provides great debugging signals if the test fails in the future. The comment is an excellent practice.

## Correctness Assessment
The changes successfully and cleanly remove the `todo` tool logic from the backend tools and system prompt. The test fix for `summon.test.ts` is technically sound and well-documented. The changes are internally consistent from a backend tooling perspective.

## Issues & Concerns Found
**Incomplete Refactoring (Dead Code)**: 
While the `todo` tool was completely removed, the `TaskList` class itself and its instantiation in `AgentManager` (`tabAgent.taskList = new TaskList()`) were kept. Because the agent no longer has a tool to interact with this list, any tasks will remain empty. 
Consequently, the UI component that relies on this (`TaskListPanel.svelte` in the `frontend` package) will now always render an empty state. This represents an incomplete feature removal/refactor.

## Recommendations
1. **Clean Up `TaskList`**: If the todo feature is permanently removed, you should also delete the `TaskList` class from `packages/core`, remove the `taskList` property from `tabAgent` in `packages/api`, and delete `TaskListPanel.svelte` (along with its imports in `SidebarPanel.svelte`) from the frontend.
2. **Staging**: If the untracked markdown documents are ready, ensure they are intentionally added (`git add`) and committed. 
3. **Commit the Changes**: The code removal of the `todo` tool is safe to commit. I recommend summarizing it as "refactor: remove todo tool from agent capabilities".