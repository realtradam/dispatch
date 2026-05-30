# Dispatch - AI Agent Harness Requirements

## Overview

Dispatch is a multi-layered AI agent orchestration harness. The user interacts with a top-level **dispatch** layer, which spawns background **orchestrators** for high-level tasks. Orchestrators in turn spawn parallel **subagents** to execute atomic units of work.

The goal is to enable complex, multi-step software engineering workflows (planning, research, implementation, review) through composable, config-driven agent hierarchies.

## Architecture

### Agent Hierarchy (Emergent, Not Rigid)

The hierarchy is not a fixed three-layer structure enforced in code. Instead, it **emerges naturally from agent permissions and context**. Every agent is the same primitive -- what distinguishes a "dispatch agent" from an "orchestrator" from a "leaf worker" is the permissions and skills it was given when spawned.

```
User <-> Dispatch Agent (top-level, has all permissions)
              |
              +---> Agent A (given orchestration skills + summon permission)
              |         |-- Agent A1 (given task skills, no summon permission)
              |         |-- Agent A2 (given task skills, no summon permission)
              |
              +---> Agent B (given orchestration skills + summon permission)
                        |-- Agent B1 (given task skills + summon permission)
                                |-- Agent B1a (given narrow task skills, no summon)
```

**When an agent spawns a subagent, the parent defines:**
- **Context**: What information and skills the child receives
- **Model/pool**: Which model or model group tag the child should use (e.g., `heavy`, `coding`)
- **Permissions**: What the child is allowed to do -- run shell commands, summon its own subagents, access specific directories, etc.

This means:
- An "orchestrator" is just an agent with the `summon_subagents` permission and a skill file that teaches it how to decompose and delegate work
- A "leaf worker" is just an agent without `summon_subagents` permission
- Hierarchy depth is unlimited and determined by the agents themselves, not hardcoded
- The dispatch layer is simply the first agent in the tree, with full permissions

### Communication Model

- **Strict hierarchy**: Subagents report only to the agent that spawned them. No peer-to-peer communication between sibling agents.
- Each agent communicates with its parent (upward) and its children (downward).
- The specific transport mechanism (filesystem, IPC, message queue) is an implementation detail left open.

### Detached Orchestrators

The dispatch agent can spawn orchestrators in **detached mode**. A detached orchestrator:

- Runs independently from the dispatch conversation
- Has its own **direct communication channel to the user** — it can ask questions, request clarification, and wait for user input
- The user interacts with the detached orchestrator as if it were its own conversation thread
- The orchestrator may spawn its own subagents (which follow strict hierarchy — reporting only to the orchestrator)
- When the orchestrator completes its task, it reports results back to the dispatch agent

**Use case:** The dispatch agent spawns a planning orchestrator. The orchestrator opens a conversation with the user, asks clarifying questions about requirements, iterates on the plan with user feedback, and when the plan is finalized, hands it back to the dispatch agent for execution.

A detached orchestrator is simply an agent spawned with `detached: true` — it receives a user-facing channel in addition to its parent channel.

### User-to-Agent Messaging

The user can send messages to any running agent at any time, regardless of where that agent is in its execution. Messages are delivered through tool interfaces -- any tool invocation point doubles as a message reception point.

**Message types:**
- **Instructions**: Direct the agent to change approach or focus
- **Corrections**: Fix a misunderstanding or wrong assumption
- **Context**: Provide additional information the agent lacks
- **Data**: Supply concrete values, file contents, references, etc.

**Requirements:**
- Messages can target any agent in the hierarchy (dispatch, orchestrator, or subagent)
- Delivery must not require the agent to finish its current tool call first -- the message is available on the next tool boundary
- The agent must acknowledge and incorporate the message into its ongoing work
- The dispatch layer provides a mechanism for the user to see which agents are active and route messages to them

### Conflict Prevention

When multiple subagents operate on code, the orchestrator must assign **non-overlapping scopes** (e.g., distinct files or file regions) to each subagent before dispatching them. Orchestrators are responsible for partitioning work to avoid merge conflicts.

## Configuration

### Config-Driven Orchestrators

Orchestrators are defined through configuration files, not hardcoded. A configuration defines:

- **Name and description** of the orchestrator type
- **System prompt / instructions** for the orchestrator's LLM context
- **Allowed tool set** for the orchestrator itself
- **Subagent templates** -- what types of subagents this orchestrator can spawn, with their own tool scopes and prompts
- **Concurrency limits** -- max parallel subagents
- **Checkpoint rules** -- which stages require human approval (if any)

### Role-Scoped Tooling

Tools available to each agent are scoped by role:
- Research subagents: web search, file read, documentation fetch
- Coding subagents: file read/write, shell execution, code analysis
- Review subagents: file read, test execution, linting
- Custom roles define their own tool sets via config

## Skills System

Skills are markdown files (`.md`) containing specialized instructions, context, or workflows that are injected into an agent's context. Skills are organized in a standardized directory structure at two levels: **global** (home directory) and **project-level**.

### Directory Structure

```
~/.skills/
  default/        # .md skills auto-loaded for ALL agents globally
  agents/         # Agent-type mappings (which skills activate for which agent)
  project/        # .md skills available to any project (manually activated)

<project>/.skills/
  default/        # .md skills auto-loaded for agents working in this project
  agents/         # Agent-type mappings specific to this project
  project/        # .md skills available in this project (manually activated)
```

### Directories Explained

| Directory | Scope | Loading |
|-----------|-------|---------|
| `default/` | All agents at that level | **Auto-loaded** -- always injected into agent context |
| `project/` | Agents at that level | **Available** -- must be explicitly activated or referenced |
| `agents/` | Specific agent types | **Mapped** -- defines which skills load for which agent type |

### Agent Mapping Files (`agents/`)

Files in the `agents/` directory map skills to specific agent types. The filename encodes the agent name and tier:

- `<name>.txt` -- maps to a **subagent** of that name
- `<name>.o.txt` -- maps to an **orchestrator** of that name

File contents list skill filenames (from `default/` or `project/`) to activate for that agent type.

**Examples:**
```
# agents/coding.txt (subagent)
git-conventions.md
code-style.md

# agents/research.o.txt (orchestrator)
search-strategy.md
source-evaluation.md
```

### Scope and Precedence

- Global skills (`~/.skills/`) are available to all projects.
- Project skills (`<project>/.skills/`) are available only within that project.
- When a skill with the same name exists at both levels, **both are retained and distinguishable by scope**. References can disambiguate using a scope prefix (e.g., `global:code-style` vs `project:code-style`).
- `default/` skills at both levels stack: global defaults and project defaults are both auto-loaded.

### Loading Order

1. Global `default/` skills are loaded first
2. Project `default/` skills are loaded next
3. Agent-specific skills from `agents/` mappings are loaded (global then project)
4. Manually activated `project/` skills are loaded on demand

## LSP Integration

Agents have access to Language Server Protocol diagnostics for the project they are operating in.

### Capabilities

- **Primary use case**: Real-time compiler/linter diagnostics and errors. Agents receive ground-truth error information from the language toolchain rather than inferring errors from output or guessing.
- Agents can query the LSP for diagnostics on specific files or the entire workspace.
- Diagnostics are available as a tool that any agent with appropriate scope can invoke.

### Configuration

- **Auto-detection**: The system detects the project language(s) and starts appropriate LSP servers automatically (similar to how an IDE discovers and launches language servers).
- **Manual overrides**: A project-level config file can specify custom LSP server commands, initialization options, and settings. Manual config takes precedence over auto-detected defaults.
- LSP servers are managed as long-lived background processes, shared across agents operating on the same project.

## Filesystem and Shell Access

### General Shell Access

All agents have access to a general-purpose shell for running commands. This is not restricted to a predefined set of tools -- agents can execute arbitrary shell commands.

### Directory Permissions

- Agents may freely read and write within the **current working directory** (the project root) and its subdirectories.
- **Any access to directories outside the current working directory requires explicit user permission.** When an agent attempts to read, write, or execute in an external directory, the system prompts the user for approval.
- **Auto-allow list**: A configurable list of directories that are pre-approved for access without prompting. Defined in the project or global config.

```
# Example config
permissions:
  auto_allow:
    - /tmp
    - ~/.config/dispatch
    - /usr/local/share/data
```

- Permission prompts include: the agent requesting access, the target path, and the operation (read/write/execute).
- Permissions can be granted per-request, per-session, or permanently (added to auto-allow).

## Session Management

### Chat Forking

The user can fork the current dispatch conversation at any point, creating a new branch from that moment in the chat history. Forking applies to the **dispatch-level conversation only** -- active orchestrators and subagents are not duplicated into the fork. The original session continues unaffected.

### Model Switching

The user can switch the LLM model for **any active agent** in the hierarchy mid-session:
- Switch the dispatch agent's model during a conversation
- Switch an orchestrator's or subagent's model while it is running
- The agent continues with its existing context under the new model

Model switches take effect immediately. Prior context is preserved and passed to the new model.

### Chat History and Resumption

All dispatch-level conversations are persisted and can be loaded later to continue where the user left off. Loading an old chat restores the **conversation history only** -- background orchestrators and subagents from the original session are not resumed.

Loaded chats can be:
- Continued with new messages
- Forked from any point in the history
- Searched/filtered by date, topic, or content

## Human-in-the-Loop

The system supports **configurable checkpoints** where execution pauses for human approval. Examples:

- Approve a generated plan before implementation begins
- Review proposed code changes before they are written
- Confirm destructive operations (file deletions, large refactors)

Checkpoints are configurable per orchestrator type. They can be enabled, disabled, or set to auto-approve with a timeout.

## State Persistence

The system persists state across sessions:

- **Plans**: Generated plans are saved and can be resumed
- **Research artifacts**: Research findings are stored for reuse
- **Session state**: Interrupted orchestrators can be resumed from their last checkpoint
- **History**: Past dispatches and their outcomes are queryable

## Observability

Basic logging is required:
- Agent activity logs (what each agent did and when)
- Error reporting with context
- Optional: token usage tracking, cost estimates, decision traces

Observability is a secondary concern -- basic logging is sufficient initially, with hooks for richer tracing later.

## LLM Provider

The system is **provider-agnostic**. It defines an abstract LLM interface that can be backed by any provider (Anthropic, OpenAI, local models, OpenRouter, etc.). Provider selection is configurable per agent or globally.

### Key and Model Hierarchy

Multiple API keys and models can be configured with a **fallback hierarchy**. When a key's quota or budget is exhausted, the system automatically falls through to the next key or model in the hierarchy.

**Fallback triggers:**
- API key quota or budget exhausted (daily, monthly, or total spend limits)

**Configuration:**
- Each API key has a configurable budget/quota limit. When reached, the system moves to the next key in the fallback chain.
- Fallback chains are ordered lists: the system tries the first key/model, and on exhaustion moves to the second, and so on.
- Fallback can cross providers (e.g., exhaust an Anthropic key, fall back to an OpenAI key).

### Model Groups and Tags

Models are organized into **groups** using tags. Tags allow orchestrators and subagents to request a model by capability rather than by name.

**Built-in group tiers:**
- `heavy` -- largest, most capable models (e.g., Claude Opus, GPT-4.5)
- `medium` -- balanced capability/cost (e.g., Claude Sonnet, GPT-4o)
- `light` -- fast, cheap models for simple tasks (e.g., Claude Haiku, GPT-4o-mini)

**Task-specific tags:**
- `coding` -- models best suited for code generation and editing
- `review` -- models suited for code review and analysis
- `research` -- models suited for search and synthesis
- Custom tags can be defined freely in config

**Resolution:** A model can have multiple tags (e.g., a model tagged `heavy, coding`). When an agent requests a tag, the system resolves it to the best available model matching that tag, respecting the key fallback hierarchy.

```
# Example config
models:
  keys:
    - provider: anthropic
      key: ${ANTHROPIC_KEY_1}
      budget: $50/month
      models:
        claude-opus-4:
          tags: [heavy, coding, review]
        claude-sonnet-4:
          tags: [medium, coding, research]
    - provider: openai
      key: ${OPENAI_KEY_1}
      budget: $30/month
      models:
        gpt-4.5:
          tags: [heavy, coding]
        gpt-4o:
          tags: [medium, research]
        gpt-4o-mini:
          tags: [light]

  fallback_order:
    - ${ANTHROPIC_KEY_1}
    - ${OPENAI_KEY_1}
```

### Key Exhaustion Behavior

When all configured keys for an agent's task are exhausted, the agent **does not fail**. Instead it enters a **wait state**, polling until any of its configured keys become available again, then resumes automatically from where it left off.

**Behavior:**
- Keys are used in priority order (highest priority first)
- When the active key is exhausted, the system immediately falls through to the next key
- When ALL configured keys are exhausted, the agent sleeps and polls for the first key to refresh
- Whichever key refreshes first is used to resume -- priority order applies again from that point
- Waiting is **per-agent**: other agents in the tree that still have available keys continue running unaffected
- The agent's context and state are preserved across the wait -- resumption is seamless

**Use case:** A complex overnight task drains all keys. The system sleeps until a rate window resets (e.g., a 5-hour cooldown expires), then picks up automatically. The user wakes up to a completed task.

## Interface

The system is **API-first** (HTTP + WebSocket) with an HTML frontend built alongside the backend from day one. The frontend is the primary testing and interaction surface.

The core exposes a programmatic API that additional interfaces can be built on top of later:
- Interactive CLI (REPL)
- Command-based CLI
- TUI
- Desktop app

## Language/Runtime

**TypeScript / Node.js.** Chosen for:
- Rich LLM SDK ecosystem (Vercel AI SDK, pi-ai, cline/llms)
- Strong async/streaming support
- Large pool of AI tooling libraries
- Same language for backend and frontend

**Library strategy:** Use existing battle-tested libraries heavily (Vercel AI SDK for LLM, etc.). Focus custom work on the novel parts -- hierarchy, orchestration, skills, permissions.

## Key Design Principles

1. **Emergent hierarchy** -- Agents are a single primitive. "Orchestrators" and "workers" emerge from the permissions and skills given at spawn time
2. **Composability** -- Agent templates and skills are building blocks, combined via config
3. **Parallelism** -- Subagents run concurrently by default; parent agents manage fan-out/fan-in
4. **Isolation** -- Each agent operates in a scoped context with scoped tools and permissions
5. **Resumability** -- Work can be interrupted and resumed, including across key exhaustion waits
6. **Extensibility** -- New agent types, tool sets, and providers added via config, not code changes
