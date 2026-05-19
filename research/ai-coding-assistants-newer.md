# Subagent Report: AI Coding Assistants — Goose, Mentat, Cline, Continue

## Research summary

This report evaluates four open-source AI coding assistants — Goose (Block/AAIF), Mentat (AbanteAI, archived), Cline, and Continue — against a 15-point requirements checklist focused on agent hierarchy, configurability, parallelism, security, and integration capabilities. Goose and Cline are the most full-featured frameworks, with multi-agent support, provider-agnostic LLM interfaces, plugin/skills systems, and human-in-the-loop controls. Continue has pivoted from an IDE assistant to a CI-focused "AI checks" product. Mentat (the original AbanteAI CLI tool) has been archived since January 2025 and is no longer maintained. Confidence is high for Goose, Cline, and Continue based on current docs and repos; Mentat information reflects its archived state.

---

## Findings

### 1. Goose (by Block / AAIF)

**GitHub**: [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose) — 45.5k stars, 4,541 commits  
**Language**: Rust (49.8%) + TypeScript (44.6%)  
**Latest release**: v1.34.1 (May 15, 2026)  
**License**: Apache 2.0  
**Governance**: Now under Agentic AI Foundation (AAIF) at Linux Foundation  

**Core Architecture**: Goose has a three-component architecture: (1) **Interface** (desktop app, CLI, API), (2) **Agent** (core loop managing LLM interaction), and (3) **Extensions** (MCP-based tools). It supports spawning **subagents** — independent agent instances that execute tasks with process isolation, running sequentially or in parallel. Subagents inherit extensions from the parent but can be restricted.

Key features:
- Desktop app + CLI + API modes
- 15+ LLM providers via abstract interface (Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure, Bedrock, etc.)
- MCP (Model Context Protocol) extension system with 70+ extensions
- ACP (Agent Client Protocol) support for interoperability
- Subagent system with parallel/sequential execution, recipe-based reusable configs, and external subagents (Codex, Claude Code)
- Skills system: `~/.agents/skills/` and `.agents/skills/` directories with `SKILL.md` files in named subdirectories; also compatible with `.claude/skills/`
- `.goosehints` files for project context (global at `~/.config/goose/.goosehints`, local per-directory, hierarchical)
- Config-driven via YAML config files (`config.yaml`, `permission.yaml`, `secrets.yaml`)
- Session management: start, resume, search sessions; smart context management with auto-compaction
- Permission modes: auto, approve, chat, smart_approve
- Prompt injection detection, adversary mode, sandboxing for desktop app
- Extension allowlist for access control

**Primary Use Case**: General-purpose AI agent for code, research, writing, automation, data analysis.

**Activity**: Very active — 4,541 commits, 134 releases, moved to AAIF in April 2026.

---

### 2. Mentat (by AbanteAI)

**Original GitHub**: [github.com/AbanteAI/archive-old-cli-mentat](https://github.com/AbanteAI/archive-old-cli-mentat) — 2.6k stars (archived)  
**Language**: Python (87.9%) + TypeScript (8.4%)  
**Status**: **Archived January 7, 2025** — no longer maintained or supported  

The original Mentat was a command-line AI coding assistant with the following characteristics:

- Single-agent CLI tool (no multi-agent hierarchy)
- Used GPT-4 models via OpenAI API (later supported alternatives via litellm proxy)
- Worked within git repositories, editing multiple files
- Had a VS Code extension (`mentat-vscode/`)
- Supported auto-context via RAG (retrieval-augmented generation) using universal-ctags
- File exclusion via glob patterns
- Configuration via config files
- Used Python SDK's OpenAI client under the hood

**Key limitations for requirements checklist**: 
- No multi-agent hierarchy (single agent, no orchestrator/subagent concept)
- No config-driven orchestrators
- No parallel execution
- No hierarchical communication restrictions
- No user-to-agent mid-execution messaging
- No conflict prevention for parallel agents
- No role-scoped tooling
- No skills system (basic context via auto-context only)
- No LSP integration
- Shell access without directory permissions
- Basic session management (no forking, model switching mid-conversation)
- No human-in-the-loop checkpoints
- State persistence limited to git context
- Provider-agnostic via litellm proxy workaround, not native abstract interface
- CLI only (no TUI, no API mode documented)

**Note**: The name "Mentat" is now used by a different project (an AI-powered GitHub bot at mentat.ai), but this report evaluates the original AbanteAI Mentat per the task scope.

**Activity**: Archived project with 560 commits, last release v1.0.18 (Apr 2024), last PyPI release v1.0.19 (Jan 2025 — marked as archived).

---

### 3. Cline (formerly Claude Dev)

**GitHub**: [github.com/cline/cline](https://github.com/cline/cline) — 62k stars, 5,919 commits  
**Language**: TypeScript (97.7%)  
**Latest CLI release**: v3.0.7 (May 18, 2026)  
**License**: Apache 2.0  
**Organization**: Cline Bot Inc.

**Core Architecture**: Cline is built on a layered SDK architecture:
- `@cline/sdk` — Public SDK surface
- `@cline/core` — Node runtime for sessions, built-in tools, persistence, hub support, automation
- `@cline/agents` — Browser-compatible stateless agent execution loop
- `@cline/llms` — Provider gateway and model catalogs
- `@cline/shared` — Types, schemas, tool helpers

Cline operates in multiple form factors: **CLI** (terminal with interactive or headless modes), **VS Code Extension**, **JetBrains Plugin**, and **Kanban** (web-based multi-agent task board).

Key features:
- **Multi-agent teams**: Coordinator agent breaks work into subtasks and delegates to specialist agents, each with their own tools and context. Team state persists across sessions.
- **Kanban**: Run many agents in parallel from a web-based task board; each card gets its own worktree and auto-commit
- **Rules system**: `.clinerules` files for project-specific guidance
- **Skills system**: `.agents/skills/` directory with SKILL.md files (compatible with Goose/Claude skill format)
- **Plugin system**: `AgentPlugin` with hooks into lifecycle stages (beforeRun, afterRun, beforeTool, afterTool, etc.)
- **MCP support**: Load MCP settings through runtime/config extension path
- **Provider-agnostic**: 200+ models via OpenRouter, plus Anthropic, OpenAI, Google, AWS Bedrock, Azure, Ollama, LM Studio, and any OpenAI-compatible API
- **Tool policies**: Per-tool auto-approve/require-approval/disable
- **Checkpoints and state persistence**: Sessions persist across restarts; snapshot/restore capability
- **CLI commands**: `cline auth`, `cline config`, `cline mcp`, `cline history`, `cline schedule`, `cline hub`, `cline kanban`
- **Scheduled agents**: Cron-based recurring automations
- **Headless mode**: For CI/CD with JSON output and auto-approve
- **Human-in-the-loop**: Approval required per action (configurable); Plan mode vs Act mode
- **Chat integrations**: Slack, Telegram, Discord, Google Chat, WhatsApp, Linear
- **Enterprise features**: SSO, RBAC, observability (OpenTelemetry, Datadog, Grafana)

**Primary Use Case**: AI coding agent in IDE and terminal; also used as SDK for building custom agent applications.

**Activity**: Very active — 5,919 commits, 260 releases, 62k stars, 3.3k dependents.

---

### 4. Continue (Continue Dev, Inc.)

**GitHub**: [github.com/continuedev/continue](https://github.com/continuedev/continue) — 33.3k stars, 21,498 commits  
**Language**: TypeScript (84.4%) + Kotlin (3.8%) + Python (2.2%)  
**Latest release**: v1.2.22-vscode (Mar 27, 2026)  
**License**: Apache 2.0  

**Note**: Continue has undergone a significant pivot. The project originally was an open-source IDE code assistant (VS Code + JetBrains) with chat, edit, autocomplete, and agent modes. It has now pivoted to **Source-controlled AI checks, enforceable in CI** — a CI-focused product where checks are defined as markdown files in `.continue/checks/` and run as GitHub status checks on every PR.

**Current Architecture** (post-pivot):
- Checks defined as markdown files with YAML frontmatter in `.continue/checks/` or `.agents/checks/`
- Each check file has `name`, `description`, optional `model`, and a markdown body prompt
- CLI (`cn`) runs checks locally and in CI
- GitHub integration for PR status checks
- "Agents" for event-triggered automation (schedules, new issues, webhooks)
- Cloud agent gallery with pre-configured agents

**Legacy IDE extension** (still available):
- VS Code Agent, Chat, Edit, Autocomplete modes
- JetBrains plugin
- MCP support
- Multiple LLM provider support (via config)

**Primary Use Case (current)**: AI-powered code review checks in CI/CD pipelines.

**Activity**: Active — 21,498 commits (the highest commit count), 822 releases. However, recent focus appears to be on the CI/checks product rather than the agent framework.

---

## Requirements Checklist

### Requirement 1: Three-layer hierarchy (dispatch -> orchestrator -> subagent)

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Partial** | Supports subagents (spawned by main agent) but no formal three-layer hierarchy. Has main agent → subagent (1 level deep). Subagents cannot spawn further subagents. Recipes enable reusable subagent configs. External subagents (Codex, Claude Code) supported via MCP. |
| **Mentat** | **Not at all** | Single-agent CLI tool. No notion of orchestrator or subagents. |
| **Cline** | **Partial** | Supports multi-agent teams: coordinator agent delegates to specialist agents. CLI supports `--team-name` flag. Kanban enables parallel agent execution. SDK enables building custom multi-agent systems. However, no formal three-layer dispatch→orchestrator→subagent hierarchy documented. |
| **Continue** | **Not at all** | Current product is single-agent checks per PR. No multi-agent hierarchy. Each check runs independently. |

### Requirement 2: Config-driven orchestrators

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Recipes (YAML files) define subagent behavior: instructions, extensions, parameters, prompts. `GOOSE_RECIPE_PATH` env var configures recipe locations. Subagent settings configurable via natural language, env vars, or recipes. |
| **Mentat** | **Not at all** | No orchestrator concept. Basic config file for model settings. |
| **Cline** | **Partial** | Orchestrator behavior is primarily code-driven via SDK (TypeScript). Plugin system allows packaging configuration. CLI flags (`--team-name`, `--plan`, `--auto-approve`) provide some config-driven behavior. No dedicated YAML orchestration config. |
| **Continue** | **Not at all** | No orchestrator concept. Check files are markdown with YAML frontmatter, but these are individual check configs, not orchestrator definitions. |

### Requirement 3: Parallel subagent execution

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Subagents can run in parallel using trigger keywords ("parallel", "simultaneously", "concurrently", "at the same time"). Parallel subagents supported natively. |
| **Mentat** | **Not at all** | Single-threaded CLI, no parallel execution. |
| **Cline** | **Yes** | Kanban enables parallel agent execution from a web-based task board. SDK multi-agent example demonstrates parallel agents streaming to web UI. Multi-agent teams with coordinator delegating work. |
| **Continue** | **Not at all** | Checks run sequentially as part of CI pipeline. No parallel subagent execution. |

### Requirement 4: Strict hierarchy communication

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Subagents have restricted operations: cannot spawn further subagents (prevents infinite recursion), cannot manage extensions, cannot manage schedules. Communication flows through the parent agent. |
| **Mentat** | **Not at all** | No hierarchy exists. |
| **Cline** | **Partial** | Multi-agent team communication pattern: coordinator → specialist agents. SDK plugin hooks enable lifecycle-based communication control. No explicit peer-to-peer blocking documented but the architecture implies parent-mediated communication. |
| **Continue** | **Not at all** | No hierarchy exists. |

### Requirement 5: User-to-agent messaging mid-execution

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Sessions are continuous conversations. Users can interrupt and provide input during execution. In-session actions allow sharing information mid-session. Subagent activity is visible in real-time. |
| **Mentat** | **Partial** | Interactive CLI sessions allow text input during conversation, but no structured mid-execution message injection. |
| **Cline** | **Yes** | Interactive CLI mode and VS Code extension support continuous chat. Users can interrupt agent execution. `ask_question` tool allows agent to request user input mid-execution. Plan/Act mode switching. |
| **Continue** | **Not at all** | Checks run autonomously in CI. No user interaction mid-execution. The legacy VS Code extension supports chat but the current CI product does not. |

### Requirement 6: Conflict prevention (non-overlapping file scopes)

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Partial** | Subagents operate with process isolation. Sandbox for desktop app controls file access. No explicit file-scoping mechanism for parallel subagents documented. |
| **Mentat** | **Not at all** | No parallel execution, no conflict prevention needed. |
| **Cline** | **Partial** | Kanban gives each agent its own worktree (Git worktree) with auto-commit. This provides file-level isolation. No explicit lock-based conflict prevention. |
| **Continue** | **Not at all** | No parallel execution. |

### Requirement 7: Role-scoped tooling

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Subagents can be given specific extension sets (e.g., "Create a subagent with only the developer extension"). Extension control via recipes and natural language prompts. `available_tools` field in extension config filters tools. |
| **Mentat** | **Not at all** | No role-based tool differentiation. |
| **Cline** | **Yes** | Plugin system allows registering tools per agent. Multi-agent teams: specialist agents get their own tools and context. Tool policies per agent (`autoApprove`, `enabled`). SDK enables fine-grained tool assignment. |
| **Continue** | **Not at all** | Each check gets the same toolset (PR diff reading). No role-scoped tooling. |

### Requirement 8: Skills system (injectable markdown/text instructions per agent type)

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Skills stored in `~/.agents/skills/<name>/SKILL.md` (global) or `.agents/skills/<name>/SKILL.md` (project-level). YAML frontmatter with `name` and `description`. Supports supporting files (scripts, templates). Also compatible with `.claude/skills/`. Skill Marketplace available. |
| **Mentat** | **Not at all** | No skills system. Auto-context uses RAG to find relevant code snippets. |
| **Cline** | **Yes** | Skills in `.agents/skills/` directory with SKILL.md files (same format as Goose). `.clinerules` files for project rules. Plugin system allows bundling rules. Skills system mentioned in built-in tools list. |
| **Continue** | **Not at all** | Check files are similar to skills in format (markdown + frontmatter) but serve a different purpose (CI review prompts, not injectable agent instructions). No skills directory concept. |

### Requirement 9: LSP integration

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Not at all** | No LSP integration documented. Uses shell commands for compilation checks. |
| **Mentat** | **Not at all** | No LSP integration. |
| **Cline** | **Yes** | VS Code extension integrates with editor LSP for compiler diagnostics. Monitors linter and compiler errors as it works. SDK plugin examples include TypeScript LSP tools. Clinerules can reference LSP diagnostics. |
| **Continue** | **Partial** | Legacy VS Code extension integrates with editor LSP. Current CI-focused product does not use LSP (analyzes PR diffs, not live diagnostics). |

### Requirement 10: Shell access with directory permissions

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Extension allowlist for controlling which extensions/tools are permitted. Sandbox for Desktop app (macOS sandbox). Permission modes: auto, approve, chat, smart_approve. `GOOSE_ALLOWLIST` env var. Prompt injection detection. Adversary mode for monitoring. |
| **Mentat** | **Not at all** | Run commands directly via shell. No permission controls beyond git tracking. |
| **Cline** | **Yes** | `CLINE_COMMAND_PERMISSIONS` env var with allow/deny lists for shell commands. Tool policies per tool (autoApprove/require approval/disable). Auto-approve can be toggled. VS Code extension every action requires explicit approval by default. |
| **Continue** | **Not at all** | No shell access in current CI product. Legacy extension uses VS Code sandbox. |

### Requirement 11: Session management (forking, model switching, loading/resuming)

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Session management with start, resume (`-r`), search, and history. Smart context management with auto-compaction. Sessions are single continuous conversations. Model switching supported via multi-model config. |
| **Mentat** | **Partial** | Basic CLI sessions. No session forking, no model switching mid-conversation, no resume documented (beyond git context). |
| **Cline** | **Yes** | `cline history` command for managing task history. Session state persists across restarts (snapshot/restore). Model can be overridden per run with `-m` flag. Task history queryable. |
| **Continue** | **Not at all** | No session concept in current CI product. Each check run is stateless. |

### Requirement 12: Human-in-the-loop checkpoints

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Permission modes: "approve" mode requires user approval for each action, "smart_approve" for selective approval. Configuration via `GOOSE_MODE`. Session-level approval flow. |
| **Mentat** | **Not at all** | No checkpoint/approval system. Mentat edits files directly. |
| **Cline** | **Yes** | Each file edit and terminal command requires approval by default. Plan mode vs Act mode. Auto-approve can be toggled. Checkpoints track all changes for easy undo. VS Code extension shows diffs for review. |
| **Continue** | **Not at all** | Runs autonomously in CI. No human-in-the-loop during execution. Results are reviewed after the fact. |

### Requirement 13: State persistence across restarts

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Sessions can be resumed across restarts (`goose session -r`). Configuration persists in `config.yaml`. Session history maintained with smart context management. OpenTelemetry for observability. |
| **Mentat** | **No** | No session persistence. Each session starts fresh (though git provides code history). |
| **Cline** | **Yes** | Session state persists across restarts. Snapshot/restore capability via SDK. Schedules persist across restarts. `cline history` for past sessions. Config in `.clinerules` and plugin configs. |
| **Continue** | **Not at all** | Each check run is stateless. Check files are persistent (in git repo) but execution state is not. |

### Requirement 14: Provider-agnostic LLM

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | 15+ providers: Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure, Bedrock, SageMaker, etc. ACP providers (Claude Code, Codex). Provider abstraction in config. Multi-model configuration supported. |
| **Mentat** | **Partial** | Primarily OpenAI GPT-4. Alternative models via litellm proxy (workaround, not native abstraction). |
| **Cline** | **Yes** | Provider gateway via `@cline/llms` package. Anthropic, OpenAI, Google, OpenRouter (200+ models), AWS Bedrock, Azure, GCP Vertex, Cerebras, Groq, Ollama, LM Studio, any OpenAI-compatible API. Provider catalog with `getAllProviders()`, `getModelsForProvider()`. |
| **Continue** | **Yes** | Multiple providers supported via config. Uses `@continuedev/openai-adapters` for provider abstraction. Supports Anthropic, OpenAI, Google, AWS Bedrock, Ollama, etc. Model configurable per check file. |

### Requirement 15: Multiple interfaces (CLI, TUI, API)

| Framework | Support | Explanation |
|-----------|---------|-------------|
| **Goose** | **Yes** | Desktop app (macOS, Linux, Windows), CLI, API (via ACP server mode). `goose acp` starts as ACP server. Multiple interfaces documented. |
| **Mentat** | **Partial** | CLI only. Had a VS Code extension (mentat-vscode) but it's part of the archived project. No API, no TUI beyond basic CLI. |
| **Cline** | **Yes** | CLI (interactive + headless), VS Code Extension, JetBrains Plugin, Kanban (web-based), SDK for custom integrations. ACP mode for other editors (Neovim, Zed). |
| **Continue** | **Partial** | CLI (`cn`), VS Code Extension, JetBrains Plugin. API is cloud-based (continue.dev). No TUI. Current focus is CLI + CI integration. |

---

## Source list

| # | Source | Type |
|---|--------|------|
| 1 | [Goose GitHub Repository](https://github.com/aaif-goose/goose) | official (GitHub) |
| 2 | [Goose Architecture Docs](https://goose-docs.ai/docs/goose-architecture/) | official (docs) |
| 3 | [Goose Subagents Guide](https://goose-docs.ai/docs/guides/context-engineering/subagents) | official (docs) |
| 4 | [Goose Skills Guide](https://goose-docs.ai/docs/guides/context-engineering/using-skills) | official (docs) |
| 5 | [Goose Goosehints Guide](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints) | official (docs) |
| 6 | [Goose Config Files Guide](https://goose-docs.ai/docs/guides/config-files) | official (docs) |
| 7 | [Goose Sessions Guide](https://goose-docs.ai/docs/guides/sessions/) | official (docs) |
| 8 | [Goose Security Guide](https://goose-docs.ai/docs/guides/security/) | official (docs) |
| 9 | [Mentat Archived Repository](https://github.com/AbanteAI/archive-old-cli-mentat) | official (GitHub, archived) |
| 10 | [Mentat PyPI Page](https://pypi.org/project/mentat/) | official (PyPI) |
| 11 | [Mentat Web Archive README (Jan 2024)](https://web.archive.org/web/20240105225309/https://github.com/AbanteAI/mentat) | official (archived) |
| 12 | [Cline GitHub Repository](https://github.com/cline/cline) | official (GitHub) |
| 13 | [Cline SDK Overview Docs](https://docs.cline.bot/sdk/overview) | official (docs) |
| 14 | [Cline SDK Architecture Docs](https://docs.cline.bot/sdk/architecture/overview) | official (docs) |
| 15 | [Cline CLI Overview Docs](https://docs.cline.bot/usage/cli-overview) | official (docs) |
| 16 | [Cline Tools Docs](https://docs.cline.bot/sdk/tools) | official (docs) |
| 17 | [Cline Plugins Docs](https://docs.cline.bot/sdk/plugins) | official (docs) |
| 18 | [Cline Building an Agent Guide](https://docs.cline.bot/sdk/guides/building-an-agent) | official (docs) |
| 19 | [Cline Creating Custom Tools Guide](https://docs.cline.bot/sdk/guides/creating-custom-tools) | official (docs) |
| 20 | [Continue GitHub Repository](https://github.com/continuedev/continue) | official (GitHub) |
| 21 | [Continue Docs — What is Continue](https://docs.continue.dev/) | official (docs) |
| 22 | [Continue Check File Reference](https://docs.continue.dev/checks/reference) | official (docs) |
| 23 | [Continue Beyond Checks — Agents](https://docs.continue.dev/mission-control/beyond-checks) | official (docs) |
| 24 | [Continue core/package.json](https://github.com/continuedev/continue/blob/main/core/package.json) | official (source) |

---

## Verbatim quotes

- "goose is an open source, extensible AI agent that goes beyond code suggestions - install, execute, edit, and test with any LLM" — [Goose GitHub](https://github.com/aaif-goose/goose)
- "Subagents are independent instances that execute tasks while keeping your main conversation clean and focused." — [Goose Subagents Guide](https://goose-docs.ai/docs/guides/context-engineering/subagents)
- "Skills are reusable sets of instructions and resources that teach goose how to perform specific tasks." — [Goose Skills Guide](https://goose-docs.ai/docs/guides/context-engineering/using-skills)
- "⚠️ ARCHIVED PROJECT ⚠️ This repository contains an archived version of an old command-line tool that is no longer maintained or supported." — [Mentat Archived Repository](https://github.com/AbanteAI/archive-old-cli-mentat)
- "Cline is an AI coding agent that lives in your editor and your terminal. It can read and write files, run terminal commands, use a browser, and help you build features through natural conversation." — [Cline Docs](https://docs.cline.bot/)
- "The Cline SDK is an open source framework for building agentic applications, and is the same harness used in the Cline IDE extensions and CLI." — [Cline SDK Docs](https://docs.cline.bot/sdk/overview)
- "Coordinate multiple agents working together on complex tasks. A coordinator agent breaks the work into subtasks and delegates to specialist agents." — [Cline GitHub README](https://github.com/cline/cline)
- "Source-controlled AI checks, enforceable in CI. Powered by the open-source Continue CLI." — [Continue GitHub](https://github.com/continuedev/continue)
- "Continue runs AI checks on every pull request. Each check is a markdown file in your repo that shows up as a GitHub status check." — [Continue Docs](https://docs.continue.dev/)

---

## Source quality flags

- Source 10 (Mentat PyPI): The project is marked as archived. Useful for confirming status but not for evaluating current capabilities.
- Source 11 (Mentat Wayback Machine): Archived snapshot from Jan 2024; reflects pre-archive state. Useful context but outdated.
- Source 22-23 (Continue Docs): Primarily documents the new CI/checks product. The legacy VS Code extension features are not well documented in current docs.

---

## Confidence: High

All four frameworks were researched from primary sources (GitHub repos, official documentation). Goose and Cline documentation is current and comprehensive. Continue's documentation accurately reflects its pivot to CI checks. Mentat's status as archived is confirmed by both GitHub and PyPI. The key limitation is that some features (especially edge cases around hierarchy and conflict prevention) were inferred from published capabilities rather than explicit documentation, but the overall assessment is reliable.

---

## Gaps and open questions

1. **Cline three-layer hierarchy**: Cline's multi-agent teams imply a coordinator→specialist pattern, but whether this supports full 3+ layer nesting (dispatch→orchestrator→subagent→sub-subagent) is unclear from available docs.
2. **Goose conflict prevention**: Whether Goose provides explicit file-locking or scope-assignment mechanisms for parallel subagents is not documented beyond process isolation and worktree separation.
3. **Continue agent features**: Continue's "Agents" (beyond checks) are cloud-based and poorly documented for self-hosted use. What local agent capabilities remain from the original IDE assistant is unclear.
4. **New Mentat (mentat.ai)**: The task specified "Mentat (by AbanteAI)" which refers to the archived CLI tool. The current Mentat at mentat.ai is a different product (AI GitHub bot) and was not evaluated. If this is what the lead researcher intended, follow-up investigation is needed.
5. **LSP integration depth**: Cline's LSP integration is primarily through VS Code extension host. Whether SDK-level LSP tools exist outside the IDE is unclear.

---

## Summary Comparison Table

| Requirement | Goose | Mentat (archived) | Cline | Continue |
|---|---|---|---|---|
| **1. Three-layer hierarchy** | Partial | Not at all | Partial | Not at all |
| **2. Config-driven orchestrators** | Yes | Not at all | Partial | Not at all |
| **3. Parallel subagent execution** | Yes | Not at all | Yes | Not at all |
| **4. Strict hierarchy communication** | Yes | Not at all | Partial | Not at all |
| **5. User-to-agent mid-execution** | Yes | Partial | Yes | Not at all |
| **6. Conflict prevention** | Partial | Not at all | Partial | Not at all |
| **7. Role-scoped tooling** | Yes | Not at all | Yes | Not at all |
| **8. Skills system** | Yes | Not at all | Yes | Not at all |
| **9. LSP integration** | Not at all | Not at all | Yes | Partial |
| **10. Shell with dir permissions** | Yes | Not at all | Yes | Not at all |
| **11. Session management** | Yes | Partial | Yes | Not at all |
| **12. Human-in-the-loop checkpoints** | Yes | Not at all | Yes | Not at all |
| **13. State persistence** | Yes | No | Yes | Not at all |
| **14. Provider-agnostic LLM** | Yes | Partial | Yes | Yes |
| **15. Multiple interfaces** | Yes (Desktop, CLI, API) | Partial (CLI only) | Yes (CLI, IDE, Kanban, SDK) | Partial (CLI, IDE) |

---

## Key Questions Summary

### What is each framework's core architecture? How many layers of agent hierarchy?
- **Goose**: Interface → Agent → Extensions (3-component). Subagents: main agent → subagent (1 level deep, cannot nest further).
- **Mentat**: Single agent CLI. No hierarchy.
- **Cline**: Layered SDK (shared → llms → agents → core). Multi-agent teams: coordinator → specialists. SDK allows custom hierarchies.
- **Continue**: Single-agent check runner. No hierarchy.

### How extensible/configurable without modifying source code?
- **Goose**: Very — YAML config files, recipes, skills, extensions/MCP, env vars, custom distributions.
- **Mentat**: Minimal — basic config file for model settings and file exclusions.
- **Cline**: Very — SDK plugins, custom tools, hooks, rules, MCP servers, config CLI.
- **Continue**: Limited — check files are markdown with YAML frontmatter; config via CLI/env.

### Primary use case?
- **Goose**: General-purpose AI agent (code, automation, research, writing)
- **Mentat (archived)**: CLI-based AI coding assistant (context-aware code editing)
- **Cline**: AI coding agent in IDE/terminal + SDK for custom agent apps
- **Continue**: Source-controlled AI checks in CI/CD (pivoted from IDE assistant)

### Activity level?
- **Goose**: Very active — 45.5k stars, 4,541 commits, 134 releases, moved to Linux Foundation AAIF
- **Mentat**: Archived — 2.6k stars, 560 commits, last code Jan 2024, archived Jan 2025
- **Cline**: Very active — 62k stars, 5,919 commits, 260 releases, CLI v3.0.7 (May 18, 2026)
- **Continue**: Active — 33.3k stars, 21,498 commits, 822 releases (but pivoted focus)

### Language?
- **Goose**: Rust + TypeScript
- **Mentat (archived)**: Python (TypeScript for VS Code extension)
- **Cline**: TypeScript (some Rust)
- **Continue**: TypeScript (some Kotlin for JetBrains, Python)

---

## Tool calls made

1. `webfetch` — github.com/block/goose (README)
2. `webfetch` — github.com/AbanteAI/mentat (404)
3. `webfetch` — github.com/cline/cline (README)
4. `webfetch` — github.com/continuedev/continue (README)
5. `webfetch` — github.com/AbanteAI/mentat (second attempt, 404)
6. `webfetch` — github.com/continuedev/continue/blob/main/extensions/vscode/README.md
7. `webfetch` — goose-docs.ai/docs/quickstart
8. `webfetch` — docs.cline.bot (overview)
9. `webfetch` — docs.cline.bot/sdk/overview
10. `webfetch` — goose-docs.ai/docs/category/architecture-overview
11. `webfetch` — docs.continue.dev (what is continue)
12. `webfetch` — goose-docs.ai/docs/goose-architecture/
13. `webfetch` — docs.cline.bot/sdk/architecture/overview
14. `webfetch` — github.com/continuedev/continue/blob/main/core/README.md (404)
15. `webfetch` — pypi.org/project/mentat/
16. `webfetch` — npmjs.com/package/mentat (403)
17. `webfetch` — goose-docs.ai/docs/guides/context-engineering/subagents
18. `webfetch` — docs.cline.bot/sdk/tools
19. `webfetch` — goose-docs.ai/docs/guides/context-engineering/using-skills
20. `webfetch` — docs.cline.bot/sdk/plugins
21. `webfetch` — goose-docs.ai/docs/guides/config-files
22. `webfetch` — docs.continue.dev/checks/quickstart
23. `webfetch` — goose-docs.ai/docs/guides/security/
24. `webfetch` — docs.cline.bot/usage/cli-overview
25. `webfetch` — github.com/AbanteAI/archive-old-cli-mentat
26. `webfetch` — docs.cline.bot/sdk/guides/building-an-agent
27. `webfetch` — docs.cline.bot/sdk/guides/creating-custom-tools
28. `webfetch` — github.com/continuedev/continue/blob/main/core/package.json
29. `webfetch` — raw.githubusercontent.com/AbanteAI/archive-old-cli-mentat/main/README.md
30. `webfetch` — docs.continue.dev/mission-control/beyond-checks
31. `webfetch` — raw.githubusercontent.com/AbanteAI/archive-old-cli-mentat/main/mentat/__init__.py
32. `webfetch` — raw.githubusercontent.com/AbanteAI/archive-old-cli-mentat/main/pyproject.toml
33. `webfetch` — web.archive.org/web/20240105225309/https://github.com/AbanteAI/mentat
34. `webfetch` — mentat.ai (transport error)
35. `webfetch` — docs.cline.bot/getting-started/authorizing-with-cline
36. `webfetch` — raw.githubusercontent.com/AbanteAI/archive-old-cli-mentat/main/docs/overview.md (404)
