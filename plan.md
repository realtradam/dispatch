# Dispatch — Build Plan

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | TypeScript / Node.js | Rich LLM ecosystem, strong async, same language front+back |
| LLM | Vercel AI SDK (`ai`) | Provider-agnostic, streaming, tool calling, 15+ providers |
| API | Hono or Fastify | Lightweight, WebSocket support |
| Persistence | better-sqlite3 + drizzle-orm | Embedded, no external DB dependency |
| Config/Skills | gray-matter + yaml + chokidar | YAML frontmatter parsing, hot-reload on file changes |
| Frontend | HTML/CSS/JS | Lightweight for MVP, no heavy framework |
| Process mgmt | child_process + tree-kill | Subagent lifecycle management |
| LSP (Phase 6) | vscode-languageserver-protocol | Standard LSP client library |

## Project Structure

```
dispatch/
  packages/
    core/              # Agent runtime, LLM, tools, permissions, config
    api/               # HTTP + WebSocket server
    frontend/          # HTML/CSS/JS client
  .skills/             # Project-level skills (dogfooding)
  dispatch.yaml        # Project config (dogfooding)
```

---

## Phase 1: Single Agent + Basic UI

**Goal:** Chat with one agent in a browser, watch it read and write files.

**Effort:** 2-3 weeks

### Backend

- [ ] Project scaffolding (monorepo with packages/core, packages/api, packages/frontend)
- [ ] Agent runtime: message -> LLM -> tool call -> result -> repeat loop
- [ ] Vercel AI SDK integration with streaming responses
- [ ] Single provider config (one API key, one model — hardcoded or env vars for now)
- [ ] Basic tools:
  - `read_file` — read file contents
  - `write_file` — write/overwrite a file
  - `list_files` — glob/list directory contents
- [ ] HTTP API:
  - `POST /chat` — send a message, get streaming response
  - `GET /status` — agent status (idle, running, etc.)
- [ ] WebSocket: stream agent output tokens and tool calls in real-time

### Frontend

- [ ] Single chat panel — text input field, send button
- [ ] Streamed response rendering (tokens appear as they arrive)
- [ ] Tool call display (collapsible: show tool name, arguments, result)
- [ ] Model/provider indicator in header
- [ ] Basic layout: chat takes full screen, clean and minimal

### Done When

Open a browser, type "read the contents of package.json and summarize it," see the agent call `read_file`, stream back a summary. Ask it to create a new file — it calls `write_file` and confirms.

---

## Phase 2: Shell Permissions + UI

**Goal:** Agent can run shell commands with directory-scoped permission controls. Usable on real projects.

**Effort:** 1-2 weeks

### Backend

- [ ] Shell tool:
  - `run_shell` — execute arbitrary commands, capture stdout/stderr/exit code
  - Streaming output for long-running commands
  - Working directory parameter (defaults to project root)
- [ ] Directory permission system:
  - Current working directory + subdirectories: always allowed (read, write, execute)
  - Auto-allow list loaded from config file
  - All other directories: prompt user for permission before access
- [ ] Permission grant types:
  - Per-request — allow this one operation
  - Per-session — allow this directory for the rest of the session
  - Permanent — add to auto-allow list in config
- [ ] Permission prompt flow:
  - Agent calls a tool that touches an out-of-scope directory
  - API holds the request open (agent pauses)
  - WebSocket pushes a permission prompt to the frontend
  - User responds (approve/deny/always-allow)
  - API resolves, agent continues or gets a denial message
- [ ] Basic config file loading (`dispatch.yaml`) for auto-allow list:
  ```yaml
  permissions:
    auto_allow:
      - /tmp
      - ~/.config/dispatch
  ```
- [ ] Apply permission checks to existing file tools (`read_file`, `write_file`) as well

### Frontend

- [ ] Permission prompt modal:
  - Agent name
  - Target path
  - Operation type (read / write / execute)
  - Buttons: Approve / Deny / Always Allow
- [ ] Permission log panel: scrollable history of grants and denials
- [ ] Shell output display in chat: stdout/stderr with monospace formatting, exit code indicator
- [ ] Visual distinction between tool calls (file ops vs shell commands)

### Done When

Ask the agent to "run the test suite." It executes `npm test` in the project dir (allowed). Then ask it to "check what's in /etc/hosts." Permission prompt appears. You approve. It reads the file and reports back. Next time it tries `/etc/`, it remembers your per-session grant.

---

## Phase 3: Config + Skills + Model Groups

**Goal:** YAML-driven agent templates, skills auto-loading from directory structure, multi-provider model groups with key budgets, fallback chains, and wait-on-exhaustion.

**Effort:** 2-3 weeks

### Backend — Config System

- [ ] Full `dispatch.yaml` config loader:
  - Agent templates: name, description, system prompt, tools, permissions, model group
  - Model definitions with tags
  - Key definitions with budget limits
  - Fallback order
  - Permission auto-allow list (already from Phase 2, now in full config)
- [ ] Config validation on load (clear errors for missing fields, bad references)
- [ ] Hot-reload: watch `dispatch.yaml` for changes, apply without restart

### Backend — Model Groups + Key Management

- [ ] Model tag system: each model has a list of tags (`heavy`, `medium`, `light`, `coding`, `review`, etc.)
- [ ] Tag resolution: agent requests a tag -> system finds the best available model matching that tag, respecting fallback order
- [ ] Key budget tracking:
  - Track token usage and/or cost per key
  - Configurable budget limits (per-month, per-day, or total)
- [ ] Key fallback chain:
  - Use highest-priority key first
  - On exhaustion, switch to next key in chain
  - Log the switch
- [ ] Key exhaustion wait:
  - When ALL keys for an agent are exhausted, agent enters wait state
  - Poll for key availability on configurable interval
  - Resume with whichever key refreshes first
  - Per-agent: other agents with available keys continue running
  - Preserve full agent context across the wait
- [ ] API endpoints:
  - `GET /config` — current config state
  - `GET /models` — available models, tags, key status, budget remaining
  - `GET /models/resolve?tag=heavy` — which model would be selected for a tag right now

### Backend — Skills System

- [ ] Skills directory loader (both levels):
  ```
  ~/.skills/
    default/        # Auto-loaded for all agents globally
    agents/         # Agent-type mappings
    project/        # Available to any project, manually activated

  <project>/.skills/
    default/        # Auto-loaded for agents in this project
    agents/         # Agent-type mappings for this project
    project/        # Available in this project, manually activated
  ```
- [ ] Markdown skill files with YAML frontmatter (name, description, tags)
- [ ] Agent mapping files in `agents/`:
  - `<name>.txt` — maps skills to a subagent type
  - `<name>.o.txt` — maps skills to an orchestrator type
  - File contents: list of skill filenames to activate
- [ ] Loading order:
  1. Global `default/` skills
  2. Project `default/` skills
  3. Agent-specific skills from `agents/` mappings (global then project)
  4. Manually activated `project/` skills on demand
- [ ] Scope disambiguation: `global:skill-name` vs `project:skill-name` when both exist
- [ ] Hot-reload: watch skills directories for changes via chokidar
- [ ] API endpoints:
  - `GET /skills` — all loaded skills, organized by scope and directory
  - `GET /skills/:name` — skill content

### Backend — Task List Tool

- [ ] `task_list` tool available to all agents:
  - `add(title, description)` — returns task ID
  - `update(task_id, status)` — status: pending, in_progress, done, blocked
  - `list()` — returns current task state
  - `get(task_id)` — returns task details
- [ ] Task list persists with agent state (survives context compaction and key exhaustion waits)
- [ ] Parent agents can read child agent task lists

### Frontend

- [ ] Config viewer panel:
  - Agent templates: name, description, model group, permissions
  - Model groups: which models have which tags
  - Key status: active / exhausted / waiting, budget used / remaining
- [ ] Key/model status visualization:
  - Per-key budget bar (used / remaining)
  - Current fallback position indicator
  - "Waiting for refresh" state with estimated time if known
- [ ] Skills browser:
  - Tree view organized by scope (global / project) and directory (default / agents / project)
  - Click a skill to see its content
  - Show which skills are mapped to which agent types
- [ ] Hot-reload indicator: visual flash when config or skills change on disk
- [ ] Task list view: show current agent's task list with status indicators

### Done When

You have a `dispatch.yaml` with two API keys (Anthropic + OpenAI), model groups tagged `heavy` and `light`, and a $5 budget on each key. Skills are loading from `.skills/default/`. You chat with the agent — it uses the Anthropic key until the budget drains, switches to OpenAI, drains that, then shows "waiting for key refresh" in the UI. You leave it overnight. In the morning, the key has refreshed and the task completed.

---

## Phase 4: Agent Spawning + Tree UI

**Goal:** Agents can spawn child agents with defined context, model, and permissions. Full hierarchy visible in real-time. User can message any agent.

**Effort:** 2-3 weeks

### Backend

- [ ] `summon_agent` tool:
  - Parameters: task description, context (text and/or skill names), model tag or specific model, permission set, `detached` flag
  - Returns an agent handle (ID, status)
  - Parent can summon multiple children concurrently
  - Child inherits project working directory but gets its own conversation context
  - **Detached mode** (`detached: true`):
    - Child agent gets a direct user-facing conversation channel
    - It can ask the user questions, request clarification, and wait for input
    - Child may spawn its own subagents (leaf workers, not further detached)
    - Child reports results back to parent when its task is complete
    - Parent continues running while detached child is active
    - User sees detached child as a separate conversation thread in the UI
- [ ] Permission enforcement:
  - Agent can only use `summon_agent` if it has `summon_subagents` permission
  - Child agent's permissions cannot exceed parent's permissions
  - Parent defines child's permissions explicitly at spawn time
- [ ] Agent tree data structure:
  - Parent-child relationships
  - Per-agent: status (running / waiting / done / error / waiting_for_key), model, permissions, task list
  - Tree updates broadcast via WebSocket
- [ ] Parent-child communication:
  - Child results flow back to parent as tool call results
  - Parent can read child's task list for progress without consuming full conversation
  - Parent waits for child completion (or can check status asynchronously)
- [ ] User-to-agent messaging:
  - `POST /agents/:id/message` — queue a message for a specific agent
  - Message delivered at the agent's next tool boundary
  - Agent acknowledges and incorporates the message
- [ ] Agent lifecycle management:
  - Running: actively processing
  - Waiting: blocked on child agents or user input
  - Waiting for key: all keys exhausted, polling for refresh
  - Done: completed, results available to parent
  - Error: failed, error details available
  - Cleanup: terminate child processes on completion or error
- [ ] Conflict prevention:
  - Not enforced by the system — this is the orchestrator agent's responsibility
  - Orchestrator skills should instruct the agent to assign non-overlapping file scopes to children
  - The system provides the tools; the skills provide the discipline

### Frontend

- [ ] Agent tree panel (sidebar or split view):
  - Collapsible tree showing full hierarchy
  - Per-agent: name/task summary, status icon, model badge
  - Real-time updates (new agent appears, status changes, agent completes)
  - Click any agent to view its chat stream
- [ ] Agent detail view:
  - Chat/output stream for the selected agent
  - Metadata: model, permissions, parent agent, loaded skills, detached status
  - Task list for this agent
  - "Send message" input for user-to-agent injection (always available for detached agents, available for any agent via message routing)
- [ ] Detached orchestrator support:
  - Detached agents appear as separate conversation threads alongside the main dispatch thread
  - User can switch between the dispatch conversation and any active detached orchestrator
  - Notifications when a detached orchestrator is waiting for user input
  - When a detached orchestrator completes, results flow back to the parent and the thread becomes read-only
- [ ] Permission prompts now show which specific agent is requesting access
- [ ] Tree-level status summary: total agents, running, waiting, done, errors
- [ ] Visual indicators for key exhaustion: which agents are waiting for keys vs actively running

### Done When

You tell the dispatch agent: "Plan the authentication system for this project." The dispatch agent spawns a planning orchestrator in **detached** mode. The orchestrator opens its own conversation thread in the UI. It asks you: "Should this support OAuth, JWT, or both?" You answer. It asks about session duration. You clarify. Once it has enough input, it writes the plan, reports back to the dispatch agent, and its thread becomes read-only. Meanwhile you were still chatting with the dispatch agent about other things.

You tell the dispatch agent: "Research how authentication works in this codebase and write a summary." The agent (given orchestration skills) spawns a research subagent to search the code and a writing subagent to draft the summary. You see both appear in the tree panel. Click into the research agent — watch it grep files. Click into the writer — it's waiting for the researcher to finish. Researcher completes, results flow to the orchestrator, orchestrator hands context to the writer, writer produces the summary, orchestrator delivers it back to you. Send a message to the writer mid-task: "focus on OAuth specifically." It acknowledges and adjusts.

---

## Phase 5: Session Management

**Goal:** Full session persistence. Close the browser, come back tomorrow, pick up where you left off. Fork conversations to try different approaches.

**Effort:** 1-2 weeks

### Backend

- [ ] SQLite schema:
  - Sessions: id, project path, created_at, updated_at, metadata
  - Messages: session_id, agent_id, role, content, tool_calls, timestamp
  - Agent snapshots: session_id, agent_id, parent_id, config, status, task_list
- [ ] Auto-save: persist every message and tool result as it happens
- [ ] Resume: load a session, restore conversation context for the dispatch agent
  - Note: child agents are NOT resumed (they completed or were terminated)
  - Conversation history is restored so the agent has full context
- [ ] Fork: create a new session branching from any message in an existing session
  - Copies conversation up to the fork point
  - New session diverges from there
- [ ] Model switching: change the model for any agent mid-session
  - Context preserved, next LLM call uses the new model
- [ ] Session search: query by date range, project, content keywords
- [ ] API endpoints:
  - `GET /sessions` — list sessions with metadata
  - `GET /sessions/:id` — full session data
  - `POST /sessions/:id/resume` — resume a session
  - `POST /sessions/:id/fork?at=message_id` — fork from a point
  - `PATCH /agents/:id/model` — switch model for an agent
  - `GET /sessions/search?q=...` — search sessions

### Frontend

- [ ] Session sidebar:
  - List of past sessions with metadata (date, project, message count, cost)
  - Search/filter bar
  - "New session" button
- [ ] Resume: click a past session to load and continue
- [ ] Fork: right-click or button on any message -> "Fork from here"
  - Opens a new session tab branching from that point
- [ ] Model switcher: dropdown per agent to change models
- [ ] Session cost summary: total tokens, estimated cost, breakdown by key/provider
- [ ] Active session indicator: which session you're currently in

### Done When

You've been working on a task for an hour. Close the browser tab. Open it again. Click the session in the sidebar — full conversation loads, you continue from where you left off. Go back to message #5, click "Fork," try a completely different approach without losing the original.

---

## Phase 6: LSP Integration

**Goal:** Agents can access real compiler/linter diagnostics via Language Server Protocol.

**Effort:** 1-2 weeks

### Backend

- [ ] LSP client manager:
  - Spawn language server processes (e.g., `typescript-language-server --stdio`)
  - Manage lifecycle: start, initialize, monitor, restart on crash
  - One server per language per project, shared across all agents
- [ ] Auto-detection: inspect project files to determine language(s)
  - `tsconfig.json` / `package.json` -> TypeScript
  - `pyproject.toml` / `setup.py` -> Python
  - `go.mod` -> Go
  - etc.
- [ ] Manual config overrides in `dispatch.yaml`:
  ```yaml
  lsp:
    servers:
      typescript:
        command: typescript-language-server
        args: [--stdio]
      python:
        command: pylsp
  ```
- [ ] `diagnostics` tool for agents:
  - `get_diagnostics(file?)` — returns current errors/warnings, optionally filtered to a file
  - `get_diagnostics_summary()` — count of errors/warnings across workspace
- [ ] File sync: notify LSP when agents modify files (via `textDocument/didChange` or `textDocument/didOpen`)
- [ ] API endpoints:
  - `GET /lsp/status` — which servers are running
  - `GET /lsp/diagnostics` — current diagnostics

### Frontend

- [ ] Diagnostics panel:
  - List of current errors/warnings grouped by file
  - Severity indicators (error / warning / info)
  - Click to see full diagnostic message
- [ ] Per-agent diagnostic context: show which errors an agent was given to work on
- [ ] LSP server status: indicator showing which language servers are running/healthy

### Done When

An agent edits a TypeScript file and introduces a type error. You see the error appear in the diagnostics panel. Another agent (or the same one) calls `get_diagnostics()` and gets the error. It fixes the issue. The diagnostic disappears.

---

## Summary

| Phase | Scope | Effort | Cumulative |
|---|---|---|---|
| 1. Single Agent + UI | One agent, chat in browser | 2-3w | 2-3w |
| 2. Shell Permissions | Safe shell access, permission prompts | 1-2w | 3-5w |
| 3. Config + Skills + Models | YAML config, skills dirs, model groups, key fallback | 2-3w | 5-8w |
| 4. Spawning + Tree | Multi-agent hierarchy, tree UI, user messaging | 2-3w | 7-11w |
| 5. Sessions | Persistence, fork, resume, model switch | 1-2w | 8-13w |
| 6. LSP | Compiler diagnostics for agents | 1-2w | 9-15w |

After Phase 2: usable on real projects.
After Phase 4: full vision working.
After Phase 6: feature-complete MVP.
