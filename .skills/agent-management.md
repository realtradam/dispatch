How to start and manage subagent conversations with Dispatch's native agent-management tools — prefer them over the CLI when available; keep the CLI for fallback/recovery.
---
# Agent Management (native tools)

Dispatch exposes a first-class, AI-callable tool family for starting and managing
other agent conversations. Prefer these **native tools** over constructing CLI
`run_shell` commands whenever they are available in your turn's tool set. The
`dispatch` CLI remains the fallback for humans, scripts, recovery, and for
operations the tools deliberately exclude (stop, compact, reasoning streams).

## The seven tools

| Tool | Purpose |
|---|---|
| `list_agent_models` | Discover exact model names (with optional `query`, `vision`, `limit`) you can pass to `summon_agent`. |
| `summon_agent` | Start a new **subagent** conversation and its first turn. |
| `list_agents` | List direct children by default (across workspaces), or select descendant/workspace scope. |
| `read_agent` | Read a subagent's latest assistant **text** or its status. |
| `send_agent_message` | Send to any existing conversation except yourself (starts a turn when idle, queues for steering when active). |
| `cancel_agent_message` | Cancel one queued message on any existing conversation except yourself. |
| `open_agent` | Signal connected frontends to open/focus a managed conversation. |

## Summoning a subagent (`summon_agent`)

- `model` and `task` are **required**. `model` must be an exact name from
  `list_agent_models`.
- By default the subagent **inherits your workspace, working directory, and
  computer** — you only need to override them when they should differ.
- `files` attaches text files the same way the CLI's `--file` does (they fold
  into the message; image files are not attached here).
- Defaults: `wait: false`, `open: true`, `toolAccess: all`. Pass `wait: true` to
  block until the child settles and receive only its final assistant text. The
  returned text is capped; the full answer lives in the child conversation.
- A non-waiting call returns the new `conversationId`, `workspaceId`, status,
  and a `started` flag.

## Managing an existing subagent

- **List**: `list_agents` — optionally filter by `status`,
  `relationship` (`children` | `descendants` | `workspace`), `query`, `limit`.
- **Read**: `read_agent` accepts a full `conversationId` or an unambiguous
  short-ID prefix (4+ chars) within your authorized scope. It returns the last
  assistant **text only** — never reasoning or tool streams.
- **Send**: `send_agent_message` accepts any existing conversation except the
  caller itself, including parents, siblings, unrelated conversations, and targets
  in another workspace. Use a full ID or unique prefix of at least four characters;
  prefixes resolve across all existing conversations, and ambiguity returns candidates
  without delivering. Delivery starts a new turn when idle or queues for mid-turn
  steering when active. `wait: true` is rejected when the target is active.
- **Cancel a queued message**: `cancel_agent_message{conversationId, messageId}`
  uses the same global target resolution and self-target restriction as send. It is
  idempotent; it cannot retract steering already injected into a turn.
- **Open in the frontend**: `open_agent` signals connected frontends; the
  frontend decides whether to focus the tab.

## Scope & safety

- **Messaging is not lineage- or workspace-restricted.** Send and queued-message
  cancellation resolve full IDs and unique prefixes across all existing conversations.
  Neither operation may target the caller itself.
- `read_agent` and `open_agent` retain their existing caller/descendant scope,
  including scoped prefix resolution. Permission to send does not grant read access.
- `list_agents` still defaults to direct children; workspace-wide listing returns
  concise metadata in the selected workspace. Its `manageable` field describes
  descendant management scope, not whether a conversation can receive messages.

## What the tools deliberately exclude

Stop active generation, compact history, close/delete conversations, move a
conversation across workspaces, mutate a conversation's persistent model/cwd
/computer/reasoning-effort, arbitrary history reads, recursive descendant
kills, and exposing child reasoning streams. Use the CLI or frontend for these.

## CLI fallback / recovery

When the native tools are unavailable (or for human/script/recovery use), use
the `dispatch` CLI — see the **dispatch-cli** skill for full syntax. Equivalent
mapping: `dispatch models` → `list_agent_models`, `dispatch <model> --text ...`
→ `summon_agent`, `dispatch list` → `list_agents`, `dispatch read` →
`read_agent`, `dispatch send` → `send_agent_message`, `dispatch open` →
`open_agent`, queued-message cancellation → `cancel_agent_message`. The tools
are the preferred path inside a model turn; the CLI is the fallback and the
recovery surface outside one.