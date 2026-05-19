# Subagent Report: Established AI Coding Assistants (Aider, OpenHands, SWE-agent)

## Research Summary

This report evaluates three open-source AI coding assistants — **Aider**, **OpenHands** (formerly OpenDevin), and **SWE-agent** — against the Dispatch agent harness requirements. Aider is a mature, single-agent CLI tool focused on AI pair programming within git repos. OpenHands is a comprehensive SDK and platform for building coding agents, offering the richest feature set (skills system, security policies, state persistence, provider abstraction). SWE-agent is an academic research tool optimized for autonomous GitHub issue resolution on SWE-bench, now superseded by mini-SWE-agent. None of the three frameworks natively support the three-layer dispatch->orchestrator->subagent hierarchy that Dispatch requires, but OpenHands' SDK architecture provides the most extensible foundation for building such a system.

---

## Findings

## 1. Aider

### Core Architecture

Aider is a **single-agent** AI pair programming tool that operates as an interactive CLI. It supports no multi-agent hierarchy — the user talks to one instance, which uses one LLM (or two in architect mode). Its architecture consists of a `Coder` class that manages file editing, a `Model` class for LLM interaction, and an `InputOutput` class for user I/O. Aider runs in the user's terminal connected to their local git repository.

- Language: **Python** (80%), with CSS, Shell, Tree-sitter Query, JavaScript, HTML
- GitHub: **45k stars**, 4.4k forks, **13,135 commits**, 93 releases (latest v0.86.0, Aug 9, 2025)
- Primary use case: AI pair programming in the terminal — edit code through natural language conversations
- Architect mode: Uses a two-model sequential pipeline (architect proposes changes, editor applies them), but this is not a hierarchy — it's a sequential two-step within a single session
- [Source: Aider GitHub repo](https://github.com/Aider-AI/aider)

### Key Features Identified

- **Provider-agnostic LLM**: Supports OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama, local models, and 15+ more through model aliases and `--model` flag
- **Git integration**: Automatically commits all AI changes with sensible commit messages, supports `/undo`
- **Repository map**: Builds a compressed map of the codebase for better context in larger projects
- **Lint/test integration**: Runs linters (per-language configurable via `--lint-cmd`) and tests after edits; automatically fixes detected errors
- **Chat modes**: `code`, `ask`, `architect`, `help`, `context` modes for different interaction styles
- **In-chat commands**: 30+ slash commands including `/model`, `/editor-model`, `/add`, `/drop`, `/clear`, `/reset`, `/run`, `/test`, `/save`
- **IDE integration**: `--watch-files` mode watches for AI-prefixed comments in any editor
- **Conventions system**: Markdown files loaded as read-only context (e.g., `CONVENTIONS.md`) to guide LLM behavior
- **Scripting**: Python API via `Coder.create()` + `coder.run()` and CLI with `--message` flag
- **Model switching mid-conversation**: `/model` and `/editor-model` commands allow switching LLMs mid-session

### Checklist Evaluation

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | **Three-layer hierarchy** | Not supported | Aider is a single-agent system. Architect mode uses 2 models sequentially, not as a hierarchy. No dispatch/orchestrator/subagent layers exist. |
| 2 | **Config-driven orchestrators** | Not supported | Orchestrators do not exist. Configuration (`.aider.conf.yml`) is for tool-level settings, not agent type definitions. |
| 3 | **Parallel subagent execution** | Not supported | Single agent, single-threaded. No concept of subagents or parallel execution. |
| 4 | **Strict hierarchy communication** | Not supported | No hierarchy exists. Communication is user<->aider only. |
| 5 | **User-to-agent messaging mid-execution** | Partial | The user can interrupt with Ctrl-C and send new messages, but cannot route messages to specific agents in a hierarchy (no hierarchy exists). Messages are delivered immediately to the single active agent. |
| 6 | **Conflict prevention** | Not supported | Single-agent design — no parallel agents to conflict with. |
| 7 | **Role-scoped tooling** | Not supported | All agents (single instance) have the same tool set. No role-based tool differentiation. |
| 8 | **Skills system** | Partial | Conventions files (`CONVENTIONS.md`) provide markdown instructions loaded into context, but there is no formal directory-based organizational system (no `~/.skills/` or `<project>/.skills/` structure). Skills are manual file references. |
| 9 | **LSP integration** | Partial | Aider has linting via `--lint-cmd` (per-language linters) but this is shell-based linting, not LSP protocol integration. No Language Server Protocol support for real-time diagnostics. [Source: Linting and testing docs](https://aider.chat/docs/usage/lint-test.html) |
| 10 | **Shell access with directory permissions** | Not supported | `/run` command provides shell access but with no directory-level permission controls. No auto-allow lists or out-of-scope prompts. |
| 11 | **Session management** | Partial | `/model` and `/editor-model` allow model switching mid-conversation. `/save` saves file list. But no chat forking, no loading/resuming old chats. History is ephemeral per session. |
| 12 | **Human-in-the-loop checkpoints** | Partial | `--yes` flag auto-accepts all confirmation. `/undo` reverts changes. But no configurable checkpoints (e.g., "pause after planning for approval"). |
| 13 | **State persistence** | Not supported | Git commits persist code changes. But session state, conversation history, and plans are NOT persisted across restarts. |
| 14 | **Provider-agnostic LLM** | Full | Supports OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama, 15+ others via `--model` flag and model aliases. Abstract model interface. [Source: LLMs docs](https://aider.chat/docs/llms.html) |
| 15 | **Multiple interfaces** | Partial | CLI only. Can be scripted via Python API and `--message` flag for non-interactive use, but no API server, no TUI (beyond the terminal prompt), no web UI. |

### Key Quotes

> "Aider lets you pair program with LLMs to start a new project or build on your existing codebase." [Source: Aider README](https://github.com/Aider-AI/aider)

> "Aider can connect to almost any LLM, including local models." [Source: Aider README](https://github.com/Aider-AI/aider)

---

## 2. OpenHands (formerly OpenDevin)

### Core Architecture

OpenHands has evolved from a monolithic application into a **four-package SDK architecture**. The Software Agent SDK (`openhands.sdk`) is the foundation, providing core agent framework, LLM abstraction, tool system, workspace management, conversation state, skills system, and security analysis. On top of this sit the OpenHands CLI, GUI (React), Cloud, and Enterprise offerings.

The architecture is: User Interface (CLI/GUI/Cloud) -> Conversation -> Agent (reasoning-action loop) -> Tools/LLM. The system is **stateless and event-driven**, with each agent step being atomic and interruptible.

- Language: **Python (62.3%)** + TypeScript (35.9%) for frontend
- GitHub: **74.1k stars**, 9.4k forks, **6,737 commits**, 102 releases (latest v1.7.0, May 1, 2026)
- Primary use case: AI-driven development platform for building and running coding agents at scale
- Four packages: `openhands.sdk` (core), `openhands.tools` (pre-built tools), `openhands.workspace` (Docker/remote exec), `openhands.agent_server` (FastAPI + WebSocket server)
- Two deployment modes: Local (in-process) and Production (containerized with agent-server)
- [Source: OpenHands GitHub repo](https://github.com/OpenHands/OpenHands)
- [Source: SDK Architecture docs](https://docs.openhands.dev/sdk/arch/overview)

### Key Features Identified

- **Skills system**: Sophisticated three-type system — Repository skills (always-active, from `AGENTS.md`), Knowledge skills (keyword-triggered), Task skills (triggered with structured inputs). Supports MCP tool integration and dynamic content via inline shell commands. Skills are markdown files with YAML frontmatter. [Source: Skill docs](https://docs.openhands.dev/sdk/arch/skill)
- **Provider-agnostic LLM**: Via LiteLLM, supporting 100+ providers. Configurable via environment variables, JSON, or programmatic. Supports both Chat Completions and OpenAI Responses API. [Source: LLM docs](https://docs.openhands.dev/sdk/arch/llm)
- **Security system**: Pluggable security analyzers (NoOp or LLM-based) with risk levels (LOW/MEDIUM/HIGH/UNKNOWN) and configurable confirmation policies (AlwaysConfirm, NeverConfirm, ConfirmRisky). Actions can be blocked, require confirmation, or auto-execute based on risk. [Source: Security docs](https://docs.openhands.dev/sdk/arch/security)
- **Custom tools**: Typed Action/Observation/Executor pattern for creating custom tools. Factory functions support shared executors across tools. [Source: Custom Tools docs](https://docs.openhands.dev/sdk/guides/custom-tools)
- **State persistence**: Auto-save and resume with debounced writes and incremental events. [Source: Conversation docs](https://docs.openhands.dev/sdk/arch/conversation)
- **Conversation management**: Two conversation types — LocalConversation (in-process) and RemoteConversation (via HTTP/WebSocket). Factory pattern auto-selects based on workspace type.
- **Event-driven architecture**: Typed event framework with ActionEvent, ObservationEvent, MessageEvent, StateUpdateEvent. Immutable append-only event log.
- **Context management**: Condenser system for compressing conversation history when token limits are approached.
- **MCP integration**: Model Context Protocol servers can be spawned and managed through repository skills.

### Checklist Evaluation

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | **Three-layer hierarchy** | Not supported | OpenHands has a single Conversation->Agent->Tool pipeline, not a dispatch->orchestrator->subagent hierarchy. The README mentions "Major tasks that involve multiple agents, like refactors and rewrites" as a use case, but this must be built manually using the SDK — it is not a native framework feature. |
| 2 | **Config-driven orchestrators** | Partial | Agents are defined programmatically in Python via the SDK (code-driven, not config-driven). However, the config template file (`config.template.toml`) provides some structure. Orchestrators as config-defined entities do not exist. |
| 3 | **Parallel subagent execution** | Not supported | The SDK executes one agent step at a time per conversation. No native mechanism for spawning parallel subagents. Would need to be built on top of the SDK. |
| 4 | **Strict hierarchy communication** | Not supported | No hierarchy enforced. The SDK's event system could be used to build one, but it's not a native constraint. |
| 5 | **User-to-agent messaging mid-execution** | Full | The Conversation system supports `send_message()` at any time. In the GUI, users can inject messages mid-execution. The RemoteConversation uses WebSocket for real-time communication. The agent's step() loop checks for pending messages on each iteration. [Source: Agent architecture](https://docs.openhands.dev/sdk/arch/agent) |
| 6 | **Conflict prevention** | Not supported | No native mechanism for assigning non-overlapping file scopes to parallel agents. Would need custom implementation. |
| 7 | **Role-scoped tooling** | Full | Each agent instance is created with its own tool set (`Agent(llm=llm, tools=[...])`). Different agents can have entirely different tools. Factory functions and shared executors support complex tool topologies. [Source: Custom Tools docs](https://docs.openhands.dev/sdk/guides/custom-tools) |
| 8 | **Skills system** | Full | Rich skills system with three skill types (Repository/Knowledge/Task), YAML frontmatter in markdown files, keyword triggers, dynamic content execution, MCP integration. Supports `AGENTS.md`, `.cursorrules`, and `.agents/skills/*.md` formats. However, the directory structure (`~/.skills/`, `<project>/.skills/`) differs from the Dispatch spec — OpenHands uses `AGENTS.md` at repo root and `.agents/skills/` directory. [Source: Skill docs](https://docs.openhands.dev/sdk/arch/skill) |
| 9 | **LSP integration** | Not supported | No LSP integration found in the SDK documentation. The tools package includes `FileEditorTool` and `BashTool` but no LSP-based diagnostic tools. |
| 10 | **Shell access with directory permissions** | Partial | Full shell access via `BashTool` and `TerminalTool`. SecurityAnalyzer provides risk-based action validation (LOW/MEDIUM/HIGH risk levels with configurable confirmation thresholds). However, this is a general action risk system, NOT a directory-based permission system (no auto-allow lists for specific paths, no prompting for out-of-scope directories). [Source: Security docs](https://docs.openhands.dev/sdk/arch/security) |
| 11 | **Session management** | Partial | State persistence with auto-save and resume exists. Model switching is configurable at agent creation but there is no `/model` command for mid-conversation switching. No chat forking feature documented. |
| 12 | **Human-in-the-loop checkpoints** | Full | ConfirmationPolicy supports AlwaysConfirm, NeverConfirm, and ConfirmRisky modes. The Agent step() loop checks for pending confirmations before executing actions. SecurityAnalyzer provides risk assessment for each action. Configurable thresholds. [Source: Agent architecture](https://docs.openhands.dev/sdk/arch/agent) |
| 13 | **State persistence** | Full | Persistence service with auto-save and resume. Debounced writes, incremental events. Conversation state, event history, and workspace state are persisted. [Source: Conversation docs](https://docs.openhands.dev/sdk/arch/conversation) |
| 14 | **Provider-agnostic LLM** | Full | Via LiteLLM backend supporting 100+ providers. LLM class with environment variable, JSON, and programmatic configuration. Dual API support (Chat Completions + Responses API). Telemetry and cost tracking. [Source: LLM docs](https://docs.openhands.dev/sdk/arch/llm) |
| 15 | **Multiple interfaces** | Full | CLI (OpenHands CLI), GUI (React single-page app), Cloud (hosted deployment), Enterprise (self-hosted VPC), SDK (Python + REST API via agent-server). WebSocket support for real-time communication. [Source: OpenHands README](https://github.com/OpenHands/OpenHands) |

### Key Quotes

> "The SDK is a composable Python library that contains all of our agentic tech. It's the engine that powers everything else below." [Source: OpenHands README](https://github.com/OpenHands/OpenHands)

> "You can use the OpenHands Software Agent SDK for: ... Major tasks that involve multiple agents, like refactors and rewrites." [Source: SDK docs](https://docs.openhands.dev/sdk)

> "The Software Agent SDK serves as the source of truth for agents in OpenHands." [Source: SDK Architecture docs](https://docs.openhands.dev/sdk/arch/overview)

---

## 3. SWE-agent

### Core Architecture

SWE-agent is a **single-agent** system designed for autonomous resolution of GitHub issues. Its architecture: `sweagent` CLI -> `Agent` (reasoning loop with LLM) + `SWEEnv` (environment manager wrapping SWE-ReX). SWE-ReX manages a Docker container running a shell session with custom tool implementations. The agent prompts an LLM, the LLM outputs tool calls, which are parsed and executed in the Docker sandbox.

The tool system is organized as "tool bundles" — directories containing executable scripts, a `config.yaml`, and an `install.sh`. Tools are configured via YAML config files.

- Language: **Python (94.8%)**
- GitHub: **19.2k stars**, 2.1k forks, **2,158 commits**, 10 releases (latest v1.1.0, May 22, 2025)
- Primary use case: Academic research benchmark for autonomous SWE-bench issue resolution
- **Superseded**: The project now recommends mini-SWE-agent (65% on SWE-bench verified in 100 lines of Python)
- [Source: SWE-agent GitHub repo](https://github.com/SWE-agent/SWE-agent)
- [Source: Architecture docs](https://swe-agent.com/latest/background/architecture/)

### Key Features Identified

- **YAML-driven configuration**: Single config file defines tools, prompts, history processors, model settings, environment. Multiple config files can be merged with `--config`.
- **Tool bundles**: Extensible tool system. Tools are executables in a `bin/` directory with a `config.yaml` defining signatures, arguments, and docstrings. State commands return JSON after each action.
- **History processors**: Plugable context compression, including `cache_control` (last N messages) and `image_parsing` for multimodal support.
- **Batch mode**: `sweagent run-batch` with `--num_workers` for parallel execution across multiple instances. Supports SWE-bench, HuggingFace, file-based, and expert instance sources.
- **Multimodal support**: Config for processing images from GitHub issues, extended observation lengths, web browsing tools.
- **Demonstrations**: Pre-recorded trajectories can guide agent behavior.
- **Template system**: Three template types — system_template (initial prompt), instance_template (per-task context), next_step_template (per-turn prompt). Templates use Jinja-like syntax.
- **SWE-ReX integration**: Separate package for managing remote execution environments (Docker, Modal, AWS).

### Checklist Evaluation

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | **Three-layer hierarchy** | Not supported | Single agent resolving one issue at a time. No dispatch/orchestrator/subagent layers. |
| 2 | **Config-driven orchestrators** | Not supported | SWE-agent is configured via YAML but configures a single agent type. Orchestrators as dispatch-defined entities do not exist. |
| 3 | **Parallel subagent execution** | Partial | Batch mode (`sweagent run-batch --num_workers N`) runs multiple independent agent instances in parallel on separate issues. This is horizontal parallelism of independent tasks, NOT hierarchical subagent parallelism. [Source: Batch mode docs](https://swe-agent.com/latest/usage/batch_mode/) |
| 4 | **Strict hierarchy communication** | Not supported | No hierarchy exists. Each agent operates independently in its own Docker container. |
| 5 | **User-to-agent messaging mid-execution** | Not supported | SWE-agent is designed for autonomous execution. No mechanism for injecting user messages to a running agent mid-task. |
| 6 | **Conflict prevention** | Not supported | Single agent per task. Batch mode tasks are independent (different GitHub issues), so no file conflicts. |
| 7 | **Role-scoped tooling** | Not supported | Single agent type per config file. All agents in a batch use the same tool set. |
| 8 | **Skills system** | Partial | Template system supports system prompts, instance prompts, and next-step prompts defined in YAML config. Demonstrations provide trajectory-based guidance. However, there is NO directory-based markdown skills system with auto-loading (no `~/.skills/` or `<project>/.skills/`). [Source: Templates docs](https://swe-agent.com/latest/config/templates/) |
| 9 | **LSP integration** | Not supported | No LSP integration found. Tools are shell-based (file viewer, editor, bash). No compiler diagnostic integration. |
| 10 | **Shell access with directory permissions** | Not supported | Full shell access inside Docker container via bash tool. No directory-level permission system. Docker provides container-level isolation but not fine-grained directory permissions. |
| 11 | **Session management** | Not supported | No chat forking, no model switching mid-conversation, no loading/resuming old conversations. Trajectories are saved as output files for post-hoc analysis. |
| 12 | **Human-in-the-loop checkpoints** | Not supported | Designed for fully autonomous execution. No configurable checkpoints for user approval. |
| 13 | **State persistence** | Partial | Trajectories and predictions are saved to files (`preds.json`, trajectory files). But no formal state persistence for resuming interrupted sessions. The `sweagent merge-preds` utility can recover partial batch results. |
| 14 | **Provider-agnostic LLM** | Full | Model configured in YAML (`agent.model.name`). Supports any LM via config. Model config includes per-instance cost limits, temperature, and other parameters. [Source: Config docs](https://swe-agent.com/latest/config/config/) |
| 15 | **Multiple interfaces** | Partial | CLI only (`sweagent run`, `sweagent run-batch`, `sweagent merge-preds`). No API, no TUI, no web UI. |

### Key Quotes

> "SWE-agent takes a GitHub issue and tries to automatically fix it, using your LM of choice." [Source: SWE-agent README](https://github.com/SWE-agent/SWE-agent)

> "Most of our current development effort is on mini-swe-agent, which has superseded SWE-agent." [Source: SWE-agent README](https://github.com/SWE-agent/SWE-agent)

> "Configurable & fully documented: Governed by a single yaml file." [Source: SWE-agent README](https://github.com/SWE-agent/SWE-agent)

---

## Key Questions

### 1. What is each framework's core architecture? How many layers of agent hierarchy does it support?

- **Aider**: Single-layer (User <-> Agent). No hierarchy. The "architect mode" uses two models sequentially but is still a single-agent session.
- **OpenHands**: Single-layer (Conversation -> Agent -> Tools). The SDK can be used to build multi-agent systems programmatically, but no hierarchy is natively enforced. The four-package architecture provides building blocks.
- **SWE-agent**: Single-layer (CLI -> Agent + Environment). One agent per instance. Batch mode runs independent agents in parallel but no hierarchy.

### 2. How extensible/configurable is each framework without modifying source code?

- **Aider**: Modular via command-line flags, YAML config file, environment variables, and `.env` files. Can be scripted via Python API. Adding new LLM providers requires no code changes (model aliases). No plugin system for tools or new behaviors.
- **OpenHands**: Highly extensible via the SDK. Custom tools (typed Action/Observation/Executor pattern), custom agents, custom security analyzers, MCP server integration, workspace implementations. Requires Python code for configuration but has clean extension points. Config template file provides some non-code configuration.
- **SWE-agent**: Extensible via YAML config files (tools, prompts, models, environments, history processors). Custom tools are executables in tool bundles with a config YAML. Adding tools requires creating executable scripts but no modification of core source code. Now in maintenance-only mode.

### 3. What is the primary use case each framework was designed for?

- **Aider**: Interactive AI pair programming — a developer chatting with an LLM to edit code in a git repository.
- **OpenHands**: General-purpose AI-driven development platform — from simple one-off tasks to complex multi-agent workflows, with CLI, GUI, Cloud, and Enterprise deployments.
- **SWE-agent**: Academic research benchmark for autonomous SWE-bench issue resolution. Designed to evaluate LLMs on real-world GitHub issues.

### 4. How active is each project?

| Metric | Aider | OpenHands | SWE-agent |
|--------|-------|-----------|-----------|
| GitHub Stars | 45k | 74.1k | 19.2k |
| Forks | 4.4k | 9.4k | 2.1k |
| Commits | 13,135 | 6,737 | 2,158 |
| Releases | 93 | 102 | 10 |
| Latest Release | v0.86.0 (Aug 2025) | v1.7.0 (May 2026) | v1.1.0 (May 2025) |
| Status | **Active development** | **Active development** | **Maintenance-only** (superseded by mini-SWE-agent) |

### 5. What language is each framework written in?

- **Aider**: Python (80%), CSS, Shell, Tree-sitter Query, JavaScript, HTML
- **OpenHands**: Python (62.3%), TypeScript (35.9%), Go Template, Jinja, Makefile, CSS
- **SWE-agent**: Python (94.8%), JavaScript, CSS, Shell, C++, Perl

---

## Summary Comparison Table

| # | Requirement | Aider | OpenHands | SWE-agent |
|---|-------------|-------|-----------|-----------|
| 1 | Three-layer hierarchy | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 2 | Config-driven orchestrators | ❌ Not supported | ⚠️ Partial (SDK is code-driven) | ❌ Not supported |
| 3 | Parallel subagent execution | ❌ Not supported | ❌ Not supported | ⚠️ Partial (batch mode parallelism) |
| 4 | Strict hierarchy communication | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 5 | User-to-agent messaging mid-execution | ⚠️ Partial (single agent) | ✅ Full (WebSocket, send_message) | ❌ Not supported |
| 6 | Conflict prevention | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 7 | Role-scoped tooling | ❌ Not supported | ✅ Full (per-agent tool sets) | ❌ Not supported |
| 8 | Skills system | ⚠️ Partial (conventions files) | ✅ Full (3 skill types, triggers, MCP) | ⚠️ Partial (templates + demonstrations) |
| 9 | LSP integration | ⚠️ Partial (shell linting) | ❌ Not supported | ❌ Not supported |
| 10 | Shell access w/ directory permissions | ❌ Not supported | ⚠️ Partial (risk-based security) | ❌ Not supported |
| 11 | Session management | ⚠️ Partial (/model, /save) | ⚠️ Partial (persistence, no forking) | ❌ Not supported |
| 12 | Human-in-the-loop checkpoints | ⚠️ Partial (--yes, /undo) | ✅ Full (ConfirmationPolicy) | ❌ Not supported |
| 13 | State persistence | ❌ Not supported | ✅ Full (auto-save & resume) | ⚠️ Partial (trajectory files) |
| 14 | Provider-agnostic LLM | ✅ Full (15+ providers) | ✅ Full (100+ via LiteLLM) | ✅ Full (model config in YAML) |
| 15 | Multiple interfaces | ⚠️ Partial (CLI + Python API) | ✅ Full (CLI, GUI, Cloud, API) | ⚠️ Partial (CLI only) |

**Scoring:**
- **Aider**: 0 Full / 5 Partial / 10 Not supported
- **OpenHands**: 7 Full / 4 Partial / 4 Not supported
- **SWE-agent**: 1 Full / 4 Partial / 10 Not supported

---

## Source List

| # | Source | Type |
|---|--------|------|
| 1 | [Aider GitHub Repository](https://github.com/Aider-AI/aider) | GitHub |
| 2 | [Aider Configuration Docs](https://aider.chat/docs/config.html) | Official docs |
| 3 | [Aider Chat Modes Docs](https://aider.chat/docs/usage/modes.html) | Official docs |
| 4 | [Aider In-Chat Commands](https://aider.chat/docs/usage/commands.html) | Official docs |
| 5 | [Aider Linting and Testing](https://aider.chat/docs/usage/lint-test.html) | Official docs |
| 6 | [Aider IDE Integration](https://aider.chat/docs/usage/watch.html) | Official docs |
| 7 | [Aider Scripting API](https://aider.chat/docs/scripting.html) | Official docs |
| 8 | [Aider Coding Conventions](https://aider.chat/docs/usage/conventions.html) | Official docs |
| 9 | [OpenHands GitHub Repository](https://github.com/OpenHands/OpenHands) | GitHub |
| 10 | [OpenHands SDK Overview](https://docs.openhands.dev/sdk) | Official docs |
| 11 | [OpenHands SDK Architecture](https://docs.openhands.dev/sdk/arch/overview) | Official docs |
| 12 | [OpenHands Agent Architecture](https://docs.openhands.dev/sdk/arch/agent) | Official docs |
| 13 | [OpenHands Conversation Architecture](https://docs.openhands.dev/sdk/arch/conversation) | Official docs |
| 14 | [OpenHands LLM Architecture](https://docs.openhands.dev/sdk/arch/llm) | Official docs |
| 15 | [OpenHands Skill System](https://docs.openhands.dev/sdk/arch/skill) | Official docs |
| 16 | [OpenHands Security System](https://docs.openhands.dev/sdk/arch/security) | Official docs |
| 17 | [OpenHands Custom Tools Guide](https://docs.openhands.dev/sdk/guides/custom-tools) | Official docs |
| 18 | [OpenHands Hello World](https://docs.openhands.dev/sdk/guides/hello-world) | Official docs |
| 19 | [SWE-agent GitHub Repository](https://github.com/SWE-agent/SWE-agent) | GitHub |
| 20 | [SWE-agent Architecture](https://swe-agent.com/latest/background/architecture/) | Official docs |
| 21 | [SWE-agent Config Files](https://swe-agent.com/latest/config/config/) | Official docs |
| 22 | [SWE-agent Templates](https://swe-agent.com/latest/config/templates/) | Official docs |
| 23 | [SWE-agent Tools](https://swe-agent.com/latest/config/tools/) | Official docs |
| 24 | [SWE-agent Batch Mode](https://swe-agent.com/latest/usage/batch_mode/) | Official docs |

---

## Verbatim Quotes

- "aider is AI pair programming in your terminal" — [Source: Aider README](https://github.com/Aider-AI/aider)
- "Aider can connect to almost any LLM, including local models." — [Source: Aider README](https://github.com/Aider-AI/aider)
- "The SDK is a composable Python library that contains all of our agentic tech. It's the engine that powers everything else below." — [Source: OpenHands README](https://github.com/OpenHands/OpenHands)
- "The Software Agent SDK serves as the source of truth for agents in OpenHands." — [Source: SDK Architecture docs](https://docs.openhands.dev/sdk/arch/overview)
- "You can use the OpenHands Software Agent SDK for: ... Major tasks that involve multiple agents, like refactors and rewrites." — [Source: SDK docs](https://docs.openhands.dev/sdk)
- "SWE-agent takes a GitHub issue and tries to automatically fix it, using your LM of choice." — [Source: SWE-agent README](https://github.com/SWE-agent/SWE-agent)
- "Most of our current development effort is on mini-swe-agent, which has superseded SWE-agent." — [Source: SWE-agent README](https://github.com/SWE-agent/SWE-agent)
- "Configurable & fully documented: Governed by a single yaml file." — [Source: SWE-agent README](https://github.com/SWE-agent/SWE-agent)
- "OpenHands is also the leading open source framework for coding agents. It's MIT-licensed, and can work with any LLM." — [Source: SDK docs](https://docs.openhands.dev/sdk)
- "The agent operates through a single-step execution model where each step() call processes one reasoning cycle." — [Source: Agent Architecture](https://docs.openhands.dev/sdk/arch/agent)

---

## Source Quality Flags

- Source 5, 6, 7, 8 (Aider docs): Official documentation — high quality, maintained by project maintainers.
- Source 10-18 (OpenHands docs): Official SDK documentation — comprehensive, well-structured, with architecture diagrams and runnable code examples.
- Source 20-24 (SWE-agent docs): Official documentation — includes architecture diagrams and configuration references. However, the project is now in maintenance-only mode with recommendation to use mini-SWE-agent.

---

## Confidence: High

All information was gathered from primary sources (GitHub repositories, official documentation sites). No AI-generated summaries or marketing materials were used. The frameworks' architectures and capabilities are well-documented and verifiable.

---

## Gaps and Open Questions

1. **Multi-agent hierarchy in OpenHands**: The OpenHands SDK README mentions "Major tasks that involve multiple agents" as a use case, but the public SDK documentation does not yet show concrete multi-agent orchestration examples. The multi-agent example directory (`examples/02_multi_agent_hello_world/`) was attempted but returned a 404, suggesting it may not exist yet. A follow-up investigation should check whether multi-agent orchestration patterns exist in the SDK source code.

2. **OpenHands SDK vs Application distinction**: The OpenHands ecosystem has been restructured. The monolithic GitHub repo (`OpenHands/OpenHands`) now points to the SDK, CLI, and GUI as separate packages. The relationship between the legacy OpenDevin application repo and the new SDK was not fully explored and could affect feature availability.

3. **SWE-agent mini-SWE-agent relationship**: SWE-agent now recommends mini-SWE-agent, which achieves comparable performance in "100 lines of Python." This research covered SWE-agent 1.0, but mini-SWE-agent may have a substantially different architecture worth evaluating separately.

4. **None of the three frameworks natively support the three-layer hierarchy Dispatch requires.** The closest foundation is OpenHands' SDK, which provides the building blocks (per-agent tool scoping, event system, security policies, skills system, state persistence) but lacks the hierarchical orchestration layer. Building Dispatch on top of OpenHands SDK would require implementing the orchestrator and dispatcher layers as custom Python code.

---

## Tool Calls Made

1. `webfetch` https://github.com/Aider-AI/aider
2. `webfetch` https://github.com/All-Hands-AI/OpenHands
3. `webfetch` https://github.com/princeton-nlp/SWE-agent
4. `webfetch` https://aider.chat/docs/config.html
5. `webfetch` https://aider.chat/docs/usage.html
6. `webfetch` https://swe-agent.com/latest/
7. `webfetch` https://docs.openhands.dev/sdk
8. `webfetch` https://swe-agent.com/latest/background/architecture/
9. `webfetch` https://docs.openhands.dev/sdk/arch/overview
10. `webfetch` https://aider.chat/docs/usage/modes.html
11. `webfetch` https://swe-agent.com/latest/config/config/
12. `webfetch` https://docs.openhands.dev/sdk/arch/agent
13. `webfetch` https://docs.openhands.dev/sdk/arch/skill
14. `webfetch` https://aider.chat/docs/scripting.html
15. `webfetch` https://swe-agent.com/latest/usage/batch_mode/
16. `webfetch` https://aider.chat/docs/usage/lint-test.html
17. `webfetch` https://aider.chat/docs/usage/watch.html
18. `webfetch` https://docs.openhands.dev/sdk/arch/conversation
19. `webfetch` https://docs.openhands.dev/sdk/arch/llm
20. `webfetch` https://aider.chat/docs/usage/conventions.html
21. `webfetch` https://docs.openhands.dev/sdk/arch/security
22. `webfetch` https://swe-agent.com/latest/config/tools/
23. `webfetch` https://aider.chat/docs/usage/commands.html
24. `webfetch` https://docs.openhands.dev/sdk/guides/hello-world
25. `webfetch` https://swe-agent.com/latest/config/templates/
26. `webfetch` https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/examples/02_multi_agent_hello_world/01_multi_agent_basic.py
27. `webfetch` https://docs.openhands.dev/sdk/guides/custom-tools
28. `webfetch` https://github.com/SWE-agent/SWE-agent?tab=readme-ov-file
