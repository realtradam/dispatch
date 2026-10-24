# Wave 6 note — root workspace AGENTS.md change (out-of-repo, documented here)

> **Status:** Requested change to an out-of-repo file. Not edited by Wave 6.
> **Target file:** `/path/to/dispatch/AGENTS.md` (the orchestrator /
> workspace-root AGENTS.md at the top of the `dispatch` workspace, OUTSIDE this
> backend worktree—`/path/to/dispatch/worktrees/agent-management-tools-plan/backend`).
> **Reason not edited directly:** per the Wave 6 task, only edit the root AGENTS.md
> if it is within the backend repository. `git ls-files --error-unmatch`
> confirms it is not; this note records the change so the owner of that file can
> apply it.

## Why

The agent-management feature (plan `notes/agent-management-tools-plan.md`) added
a native, AI-callable tool family for starting and managing subagent
conversations. Orchestrators/agents that previously reached for the `dispatch`
CLI inside a model turn should now prefer these native tools where available,
while retaining the CLI for humans, scripts, and recovery.

## Proposed addition to the root AGENTS.md

Add a short section (mirroring the project-scoped `.skills/agent-management.md`
skill) teaching agent users/orchestrators to prefer the native tools. Suggested
wording:

> ## Agent management (prefer native tools, keep CLI fallback)
>
> When your turn exposes the agent-management tool family, prefer those tools
> over constructing `dispatch` CLI commands:
>
> - `list_agent_models` — discover exact model names for `summon_agent`.
> - `summon_agent` — start a subagent conversation; inherits the caller's
>   workspace, working directory, and computer by default.
> - `list_agents` — list conversations you can manage.
> - `read_agent` — read a subagent's latest assistant text or status.
> - `send_agent_message` — message a managed conversation (starts a turn when
>   idle, queues for steering when active).
> - `cancel_agent_message` — cancel a queued message.
> - `open_agent` — signal connected frontends to open/focus a conversation.
>
> The tools are the preferred path inside a model turn. Keep the `dispatch` CLI
> for human use, scripts, recovery, and operations the tools deliberately
> exclude (stop, compact, reasoning streams). See the `agent-management` skill
> for full guidance and the `dispatch-cli` skill for CLI fallback syntax.

## Where the full guidance lives

- The project-scoped skill: `.skills/agent-management.md` (added by Wave 6).
- The glossary entries: `GLOSSARY.md` (`subagent`, `agent management`,
  `agent-management`, and the seven tool names).
- The plan: `notes/agent-management-tools-plan.md` §17 (Wave 6) / §21 (skill +
  decision checklist).