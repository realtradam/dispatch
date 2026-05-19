# Subagent Report: Multi-Agent Role-Playing Frameworks (MetaGPT, ChatDev, CAMEL)

## Research summary

This report evaluates three open-source multi-agent simulation/role-playing frameworks — **MetaGPT**, **ChatDev**, and **CAMEL** — against 15 specific AI agent harness requirements. MetaGPT is the most mature for software-development workflows (68.1k stars) but has a flat role-based architecture, not a deep hierarchy. ChatDev 2.0 (released Jan 2026) has pivoted to a zero-code YAML-driven DAG orchestration platform with strong config-driven design and parallel execution. CAMEL is the most general-purpose research framework (17k stars, 210+ releases) with the broadest model provider support and excellent tooling abstractions, but lacks strict hierarchy enforcement and production-oriented features like session management or shell permissions. None of the three frameworks fully satisfy all 15 requirements; each has distinct gaps in hierarchy depth, user-to-agent messaging, LSP integration, and shell permission controls.

---

## Findings

### 1. MetaGPT

#### Core Architecture

MetaGPT is a Python-based multi-agent framework designed to simulate a software company. Its core philosophy is `Code = SOP(Team)` — Standard Operating Procedures materialized into a team of LLM-based agents. The architecture has three main abstractions:

- **Role**: An agent with specific actions, memory, and watch/observe patterns
- **Action**: A discrete unit of work (LLM-powered or code-only)
- **Team**: A collection of roles operating within an Environment

Agents communicate by publishing messages to the Environment, which other agents observe. The communication model is a publish-subscribe pattern (agents publish to the environment, others observe based on watched Action types).

**Key metrics**: 68.1k stars, 8.7k forks, 6,367 commits, Python 3.9+ (Python 97.5%). Latest release v0.8.1 (April 2024). The project has been relatively quiet in terms of releases since April 2024, though the repo continues to receive commits. The team has shifted focus to MGX ([mgx.dev](https://mgx.dev/)) — a commercial natural language programming product.

[Source: GitHub README](https://github.com/geekan/MetaGPT)

#### Hierarchy Depth

MetaGPT supports a **flat role pool** within a single Team/Environment. Agents are peers — there is no orchestrator/subagent distinction. The `Team` class manages a set of roles, but it does not support recursive nesting (a sub-team within a team). Communication is broadcast-based: all messages go to the Environment, and roles subscribe to specific message types via `_watch()`. There is no built-in three-layer hierarchy.

[Source: MultiAgent 101](https://docs.deepwisdom.ai/main/en/guide/tutorials/multi_agent_101.html)

#### Config System

MetaGPT has a YAML config file (`~/.metagpt/config2.yaml`) that supports:
- LLM provider settings (api_type, base_url, api_key, model)
- Per-role LLM overrides
- Search, browser, Redis, S3 configurations
- Experience pool and memory settings

However, orchestrator types, agent behaviors, and workflow logic are **defined in Python code**, not in configuration files. The config covers infrastructure and LLM settings but not orchestration logic.

[Source: config2.example.yaml](https://github.com/geekan/MetaGPT/blob/main/config/config2.example.yaml)

#### Parallel Execution

MetaGPT's `Team` executes roles **sequentially in a round-robin fashion**. The `n_round` parameter controls how many rounds of interaction occur. There is no built-in parallel subagent execution — agents take turns within each round. The async implementation (`asyncio`) exists in the codebase but is used for single-agent action execution, not parallel multi-agent execution.

[Source: MultiAgent 101](https://docs.deepwisdom.ai/main/en/guide/tutorials/multi_agent_101.html)

#### Communication Restrictions

MetaGPT uses a **broadcast-based** communication model. When a Role publishes a message, it goes to all agents via the Environment. There is a `send_to` field on messages, but the default sends to `["<all>"]`. There is no built-in mechanism to enforce that subagents only talk to their parent orchestrator — all agents observe all messages.

[Source: Agent communication](https://docs.deepwisdom.ai/main/en/guide/in_depth_guides/agent_communication.html)

#### User-to-Agent Messaging Mid-Execution

MetaGPT supports **human engagement** via setting `is_human=True` on a Role. This causes the terminal to prompt for user input when it's that role's turn. However, this is a **replacement** of an agent role with a human, not arbitrary message injection to any running agent at any time. The human takes over a specific role in the SOP.

[Source: Human Engagement](https://docs.deepwisdom.ai/main/en/guide/tutorials/human_engagement.html)

#### Conflict Prevention (File Scopes)

MetaGPT has **no built-in mechanism** for assigning non-overlapping file scopes to parallel agents. The generated code is written to a shared workspace directory. There is no file-locking, scope assignment, or conflict detection.

#### Role-Scoped Tooling

MetaGPT supports **per-role tool assignment** through the `Role` class and its `set_actions()` method. Each role can be equipped with different actions (tools). The config file supports per-role LLM configuration. However, tool configuration is done in Python code, not via config files.

[Source: Agent 101](https://docs.deepwisdom.ai/main/en/guide/tutorials/agent_101.html)

#### Skills System

MetaGPT does **not** have a directory-based skills system with markdown/text instructions per agent type. It has an "experience pool" (`exp_pool`) feature that stores past experiences, but this is not a skills directory system with global + project-level organization.

[Source: config2.example.yaml](https://github.com/geekan/MetaGPT/blob/main/config/config2.example.yaml)

#### LSP Integration

MetaGPT has **no LSP integration**. Generated code is written to disk, but there is no built-in Language Server Protocol client for compiler diagnostics or code validation.

#### Shell Access with Directory Permissions

MetaGPT's `SimpleRunCode` action executes Python code via `subprocess.run()`. There is **no permission control system** — no auto-allow lists, no prompt-for-out-of-scope directories. Code execution is unrestricted within the subprocess.

[Source: Agent 101 - SimpleRunCode](https://docs.deepwisdom.ai/main/en/guide/tutorials/agent_101.html)

#### Session Management

MetaGPT supports **serialization and breakpoint recovery** via `--recover_path`. It serializes team state (roles, memories, actions) to a JSON file and can resume execution. However, there is **no support for chat forking, model switching mid-conversation, or loading/resuming old chats** as separate sessions.

[Source: Serialization & Breakpoint Recovery](https://docs.deepwisdom.ai/main/en/guide/in_depth_guides/breakpoint_recovery.html)

#### Human-in-the-Loop Checkpoints

MetaGPT has **no configurable checkpoint system** for pausing execution at predefined points. The human engagement feature (`is_human=True`) pauses at each role turn, but this replaces the agent rather than providing a checkpoint/approval mechanism. There are no approval gates or pause/resume hooks.

#### State Persistence

Yes — MetaGPT serializes team, environment, roles, and actions to JSON files in a `./workspace/storage` directory. This enables recovery after crashes or Ctrl-C. The serialization captures memory, role state, action progress, and environment history.

[Source: Serialization & Breakpoint Recovery](https://docs.deepwisdom.ai/main/en/guide/in_depth_guides/breakpoint_recovery.html)

#### Provider-Agnostic LLM

Yes — MetaGPT supports multiple LLM providers via a configurable `api_type` field. Options include OpenAI, Azure, Ollama, Groq, Gemini, and others. Each role can have a different LLM provider.

[Source: Config example](https://github.com/geekan/MetaGPT/blob/main/config/config2.example.yaml)

#### Multiple Interfaces

MetaGPT supports:
- **CLI**: `metagpt "Create a 2048 game"` command
- **Python library**: Import and use as a Python package
- No dedicated TUI or API mode

[Source: README](https://github.com/geekan/MetaGPT)

---

### 2. ChatDev (2.0 / DevAll)

#### Core Architecture

ChatDev has undergone a major transformation. **ChatDev 2.0 (DevAll)** — released Jan 7, 2026 — is a **zero-code multi-agent orchestration platform**. It is no longer focused solely on software development but positions itself as a platform for "Developing Everything" through configurable DAG-based workflows.

The architecture is:
- **YAML-defined workflows** describing DAGs of agent nodes
- **Node types**: `agent` (LLM), `python`, `human`, `subgraph`, `passthrough`, `literal`, `loop_counter`, `loop_timer`
- **Web UI** (Vue 3) for visual workflow design + execution dashboard
- **Python SDK / PyPI package** (`chatdev`) for programmatic execution
- **FastAPI backend** for the server component

**Key metrics**: 33.1k stars, 4.1k forks, Python 68.7% / Vue 28.5%. Latest release v2.2.0 (March 23, 2026). Very active development — 190 commits on main branch for 2.0. The legacy ChatDev 1.x is preserved on the `chatdev1.0` branch.

[Source: ChatDev README](https://github.com/OpenBMB/ChatDev)

#### Hierarchy Depth

ChatDev 2.0 supports **multi-level nesting** through its `subgraph` node type. A workflow can reference another workflow file or inline graph, enabling recursive hierarchy. Additionally, its "Tree Mode" (in dynamic execution) provides a natural fan-out/reduce pattern. The DAG structure with start/end nodes enables clear orchestration flows. However, this is a **directed acyclic graph** structure, not a strict three-level dispatch->orchestrator->subagent tree. The hierarchy is defined by edge topology, not by enforced levels.

[Source: Workflow Authoring Guide](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Config-Driven Orchestrators

**Yes** — this is ChatDev 2.0's core strength. Entire workflows, including agent types, models, prompts, tools, edge conditions, and execution logic, are defined in YAML configuration files under `yaml_instance/`. No Python code changes are needed to create new orchestrator types. The `DesignConfig` structure with `version`, `vars`, and `graph` keys provides a clean configuration schema.

[Source: Workflow Authoring Guide](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Parallel Subagent Execution

**Yes** — ChatDev 2.0 supports parallel execution through its **dynamic execution** feature. Both **Map Mode** (`type: map`, fan-out) and **Tree Mode** (`type: tree`, fan-out with recursive reduce) are supported. The `max_parallel` parameter controls concurrency limits. This enables true parallel subagent execution.

[Source: Workflow Authoring Guide - Dynamic Execution](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Strict Hierarchy Communication

ChatDev 2.0's DAG-based execution **enforces communication along defined edges**. Nodes only receive messages from their upstream nodes and send to downstream nodes. However, there is no parent-child trust boundary — all nodes within a workflow are at the same trust level. The `subgraph` node type provides some isolation (child graph has its own nodes), but there is no mechanism to enforce that sub-nodes can _only_ communicate with their parent orchestrator.

**Partial support** — edges define communication paths, but strict hierarchical communication with parent-only routing is not enforced.

[Source: Workflow Authoring Guide - Edges](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### User-to-Agent Messaging Mid-Execution

ChatDev 2.0 supports this via the **`human` node type**. When execution reaches a `human` node, the workflow pauses and waits for user input in the Web UI. However, messaging is constrained to the node level — the user interacts at predefined points in the DAG, not with arbitrary running agents at any time. The `human` node must be explicitly placed in the workflow DAG.

**Partial support** — user can inject messages at designated human nodes, but not to any arbitrary agent mid-execution.

[Source: Workflow Authoring Guide - Node Types](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Conflict Prevention

ChatDev 2.0 has **no built-in conflict prevention** mechanism for non-overlapping file scopes. The system does not assign or track file write scopes. The `python` node type executes scripts sharing a `code_workspace/` directory, but there is no file-locking or scope isolation.

#### Role-Scoped Tooling

**Yes** — the `AgentConfig.tooling` field lets different agent nodes have different tool sets. Tools are configured per-node in the YAML workflow. The MCP (Model Context Protocol) is also supported for tool integration. Tooling is defined at the node level, providing role-scoped access.

[Source: Workflow Authoring Guide - Agent Node Advanced Features](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Skills System

ChatDev 2.0 has a **`.agents/skills`** directory with a directory-based skill organization. Currently contains `greeting-demo`, `python-scratchpad`, and `rest-api-caller` skills. The skills system is designed for injectable markdown/text instructions per agent type, with both global and project-level organization. However, the documentation does not detail how skills are loaded/scoped to specific agent nodes.

[Source: .agents/skills directory](https://github.com/OpenBMB/ChatDev/tree/main/.agents/skills)

#### LSP Integration

ChatDev has **no LSP integration** documented. The platform focuses on workflow orchestration and multi-agent collaboration, not on providing compiler diagnostics or language server features.

#### Shell Access with Directory Permissions

ChatDev 2.0 has **no documented shell permission controls**. The `python` node type executes scripts, and Docker support is available for safe execution (noted in legacy 1.x), but there is no auto-allow list, prompt-for-scope, or directory-based permission system in the current documentation.

#### Session Management

ChatDev 2.0 supports **session management** through the Web UI — workflows can be launched, monitored, and inspected. Context snapshots are saved to `WareHouse/<session>/context.json`. There is HTTP API support (`POST /api/workflow/execute`) and CLI execution (`python run.py`). However, there is **no support for chat forking, model switching mid-conversation, or loading/resuming old chats** in the documented features.

[Source: Workflow Authoring Guide - CLI/API Execution Paths](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Human-in-the-Loop Checkpoints

**Yes** — the `human` node type provides explicit checkpoints where the workflow pauses for user input. Conditions on edges (e.g., `keyword` condition checking for "ACCEPT") can create approval gates. The workflow only continues when the user provides the expected input.

[Source: Workflow Authoring Guide - Conditions](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### State Persistence

ChatDev 2.0 saves workflow session data to `WareHouse/` directories, including context snapshots. The SQLite database (`sync` command) stores workflow definitions. However, there is **no documented mechanism for full state persistence across restarts** that would allow resuming a workflow from where it left off after a crash (like MetaGPT's breakpoint recovery).

**Partial support** — artifacts and logs persist, but workflow execution state recovery is not documented.

[Source: Workflow Authoring Guide - Debugging Tips](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Provider-Agnostic LLM

**Yes** — ChatDev 2.0 supports multiple LLM providers configured per-node via `provider` field (e.g., `openai`, `gemini`, etc.). The config uses `${VAR}` syntax for API keys and base URLs. The `globals.default_provider` sets a fallback. Providers can be mixed within a single workflow.

[Source: Workflow Authoring Guide - Providers](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md)

#### Multiple Interfaces

ChatDev 2.0 supports:
- **Web UI / TUI**: Vue 3 frontend at port 5173 with visual workflow canvas and execution dashboard
- **CLI**: `python run.py --path yaml_instance/demo.yaml --name test_run`
- **HTTP API**: `POST /api/workflow/execute` with session management
- **Python SDK**: `chatdev` PyPI package for programmatic execution

[Source: ChatDev README](https://github.com/OpenBMB/ChatDev)

---

### 3. CAMEL

#### Core Architecture

CAMEL is a Python-based research framework focused on "finding the scaling laws of agents." It is the most general-purpose and academically oriented of the three frameworks. The architecture includes:

- **ChatAgent**: Core agent abstraction with LLM, tools, and memory
- **Agent Societies**: Coordination layers including `RolePlaying`, `BabyAGI`, and `Workforce`
- **Workforce**: A hierarchical agent orchestration system with task decomposition and worker assignment
- **ModelFactory**: Abstract LLM interface supporting 45+ model platforms
- **Toolkits**: 70+ tool integrations (search, browser, code execution, MCP, etc.)
- **Memory & Storage**: Persistent state management
- **Interpreters**: Code/command execution backends
- **Human-in-the-Loop**: Tool approval and interactive components

**Key metrics**: 17k stars, 1.9k forks, 2,208 commits, Python 95.9% / TypeScript 2.1%. Latest release v0.2.90 (March 22, 2026). Extremely active — 210 releases and very frequent commits. Large community with Discord, WeChat, and Reddit presence. Backed by Eigen AI research collective with 100+ researchers.

[Source: CAMEL README](https://github.com/camel-ai/camel)

#### Hierarchy Depth

CAMEL's **Workforce** module provides a hierarchical multi-agent system. The `Workforce` class acts as an orchestrator that receives a task, decomposes it into subtasks, assigns workers (single agents or role-playing pairs), and aggregates results. The workforce supports **multiple levels** — a worker can itself be a `Workforce` (recursive nesting), enabling arbitrary hierarchy depth. The `RolePlaying` society creates two-agent task-solving pairs. However, workforce configuration is done via Python code, not config files, and the hierarchy is defined programmatically.

[Source: CAMEL societies/workforce](https://github.com/camel-ai/camel/tree/master/camel/societies/workforce)

#### Config-Driven Orchestrators

CAMEL is **primarily Python-code-driven**. The `ModelFactory.create()` method accepts programmatic configuration. While `create_from_yaml()` and `create_from_json()` methods exist for model configuration, the orchestration logic (workforce setup, task decomposition, worker assignment) is **defined in Python code**. There is no YAML-based workflow definition system like ChatDev 2.0.

**Partial support** — model config can be loaded from YAML/JSON files, but orchestration logic cannot.

[Source: model_factory.py](https://github.com/camel-ai/camel/blob/master/camel/models/model_factory.py)

#### Parallel Subagent Execution

CAMEL's Workforce **does not appear to have built-in parallel execution** of subagents. The workforce processes tasks sequentially through its worker pool. While individual agents can make async LLM calls, the workforce orchestration itself is not designed for parallel fan-out execution. The documentation emphasizes scalability to "millions of agents" as a design principle but does not describe current parallel execution in the workforce implementation.

**Not supported** in the current documented and released architecture.

[Source: CAMEL societies/workforce](https://github.com/camel-ai/camel/tree/master/camel/societies/workforce)

#### Strict Hierarchy Communication

CAMEL's Workforce uses a **centralized orchestration** pattern — the workforce assigns tasks to workers and collects results. Workers do not communicate directly with each other; they receive tasks from and return results to the workforce. The `RolePlaying` society, however, involves direct agent-to-agent communication. The framework does not explicitly enforce a "subagents only talk to parent" policy — the architecture enables this pattern through the workforce abstraction by design, but there is no system-level enforcement mechanism.

**Partial support** — Workforce architecture naturally restricts communication to parent-child, but no formal enforcement mechanism exists.

[Source: CAMEL Workforce codebase](https://github.com/camel-ai/camel/tree/master/camel/societies/workforce)

#### User-to-Agent Messaging Mid-Execution

CAMEL has a **Human toolkit** (`human_toolkit.py`) and documented **Human-in-the-Loop** features including tool approval. The framework supports interactive components for human oversight and intervention. However, these are primarily **tool approval** mechanisms (approving tool calls before execution), not free-form message injection into any running agent at any time. The messaging pattern requires explicit setup in code.

**Partial support** — human-in-the-loop tool approval exists, but mid-execution arbitrary message injection is not a built-in feature.

[Source: CAMEL README - Human-in-the-Loop](https://github.com/camel-ai/camel)

#### Conflict Prevention

CAMEL has **no built-in conflict prevention** mechanism for non-overlapping file scopes. The framework provides code execution via `Interpreters` and toolkits like `code_execution.py`, but there is no file-locking, scope assignment, or conflict detection for parallel agents writing to the same filesystem.

#### Role-Scoped Tooling

**Yes** — CAMEL has an extensive toolkit system with **70+ toolkits** (search, browser, code execution, GitHub, Gmail, Slack, MCP, etc.). Tools are assigned to individual agents at creation time via the `tools` parameter of `ChatAgent`. Different agents can have completely different tool sets. The skill system also provides role-scoped capabilities.

[Source: CAMEL toolkits directory](https://github.com/camel-ai/camel/tree/master/camel/toolkits)

#### Skills System

CAMEL has a **`.camel/skills`** directory with a directory-based skill organization. Currently contains `docs-incremental-update` and `skill-creator` skills. The `skill_toolkit.py` provides programmatic access to skills. Skills can be loaded and assigned to agents. However, the system does not appear to support both global and project-level skill directories — the skills are in a single project-level `.camel/skills` directory.

[Source: .camel/skills directory](https://github.com/camel-ai/camel/tree/master/.camel/skills)

#### LSP Integration

CAMEL has **no LSP integration** documented. The framework focuses on multi-agent research and task automation, not on providing compiler diagnostics or language server features.

#### Shell Access with Directory Permissions

CAMEL provides shell access through its `TerminalToolkit` (`terminal_toolkit/`), `CodeExecution` toolkit, and `Interpreters`. However, there is **no documented permission control system** — no auto-allow lists, no prompt-for-out-of-scope directories, no directory-based sandboxing.

[Source: CAMEL toolkits - terminal_toolkit](https://github.com/camel-ai/camel/tree/master/camel/toolkits/terminal_toolkit)

#### Session Management

CAMEL supports **session and conversation management** through its `Memory` module and `Storage` module, which provide persistent context layers for chat history and tool outputs. The framework logs model request/response to JSON files when `CAMEL_MODEL_LOG_ENABLED=true`. However, there is **no support for chat forking, model switching mid-conversation, or loading/resuming old chats** as a built-in feature.

[Source: CAMEL README - Model Logging](https://github.com/camel-ai/camel)

#### Human-in-the-Loop Checkpoints

CAMEL supports **Human-in-the-Loop** features including tool approval (approving tool calls before execution) and interactive components. The `human_toolkit.py` provides human interaction capabilities. However, there is **no checkpoint system** for pausing execution at configurable predefined points — the human involvement is primarily about tool-call approval, not workflow-level pause/resume.

**Partial support** — tool approval exists, but configurable execution checkpoints do not.

[Source: CAMEL README - Human-in-the-Loop](https://github.com/camel-ai/camel)

#### State Persistence

CAMEL provides **stateful memory** as a core design principle. Agents maintain stateful memory enabling multi-step interactions. The `Memory` and `Storage` modules provide persistent context. However, there is **no documented mechanism for full workflow/execution state persistence across restarts** (like MetaGPT's breakpoint recovery). The logging system captures request/response data, but this is not a recovery mechanism.

**Partial support** — agent memory persists within a session, but full execution state recovery across restarts is not documented.

[Source: CAMEL README - Statefulness](https://github.com/camel-ai/camel)

#### Provider-Agnostic LLM

**Yes** — this is CAMEL's strongest area. The `ModelFactory` supports **45+ model platforms** including OpenAI, Azure, Anthropic, Gemini, Mistral, Cohere, Ollama, vLLM, SGLang, Groq, DeepSeek, Qwen, and many more. The `ModelFactory.create()` method provides a clean abstract interface, and models can also be created from YAML/JSON config files via `create_from_yaml()` and `create_from_json()`.

[Source: model_factory.py](https://github.com/camel-ai/camel/blob/master/camel/models/model_factory.py)

#### Multiple Interfaces

CAMEL supports:
- **Python library**: Primary interface as a Python package (`pip install camel-ai`)
- **CLI**: Via environment variable configuration and example scripts
- **API/Server**: Apps directory contains server applications (FastAPI-based)
- No dedicated TUI or web UI (unlike ChatDev's Vue 3 frontend)

[Source: CAMEL README](https://github.com/camel-ai/camel)

---

## Comparison Table

| Requirement | MetaGPT | ChatDev 2.0 | CAMEL |
|---|---|---|---|
| **1. Three-layer hierarchy** | Not supported (flat role pool) | Partial (DAG + subgraph nesting) | Partial (recursive Workforce, code-configured) |
| **2. Config-driven orchestrators** | Partial (infra config only, logic in code) | **Yes** (full YAML workflow definitions) | Partial (model config from YAML, logic in code) |
| **3. Parallel subagent execution** | Not supported (sequential rounds) | **Yes** (Map/Tree modes, max_parallel) | Not supported (sequential workforce) |
| **4. Strict hierarchy communication** | Not supported (broadcast) | Partial (edge-routed but no parent-only enforcement) | Partial (Workforce centralizes but no enforcement) |
| **5. User-to-agent messaging mid-execution** | Partial (is_human role replacement) | Partial (human nodes in DAG) | Partial (tool approval, not free injection) |
| **6. Conflict prevention** | Not supported | Not supported | Not supported |
| **7. Role-scoped tooling** | **Yes** (per-role actions in code) | **Yes** (per-node tooling in YAML) | **Yes** (per-agent toolkits) |
| **8. Skills system (markdown dirs)** | Not supported | Partial (.agents/skills dir exists) | Partial (.camel/skills dir exists) |
| **9. LSP integration** | Not supported | Not supported | Not supported |
| **10. Shell access with permissions** | Not supported (unrestricted subprocess) | Not supported (Docker for safety only) | Not supported (no permission system) |
| **11. Session management** | Partial (breakpoint recovery) | Partial (context snapshots) | Partial (memory storage) |
| **12. Human-in-the-loop checkpoints** | Not supported | **Yes** (human nodes + edge conditions) | Partial (tool approval only) |
| **13. State persistence** | **Yes** (JSON serialization + recovery) | Partial (artifacts persist, no recovery) | Partial (memory/storage, no recovery) |
| **14. Provider-agnostic LLM** | **Yes** (multiple providers via config) | **Yes** (per-node provider config) | **Yes** (45+ platforms, broadest support) |
| **15. Multiple interfaces** | Partial (CLI + Python lib) | **Yes** (Web UI, CLI, HTTP API, Python SDK) | Partial (Python lib + server apps) |

---

## Source list

| # | Source | Type |
|---|--------|------|
| 1 | [MetaGPT GitHub](https://github.com/geekan/MetaGPT) | GitHub |
| 2 | [MetaGPT Documentation - Concepts](https://docs.deepwisdom.ai/main/en/guide/tutorials/concepts.html) | Official docs |
| 3 | [MetaGPT Documentation - Agent 101](https://docs.deepwisdom.ai/main/en/guide/tutorials/agent_101.html) | Official docs |
| 4 | [MetaGPT Documentation - MultiAgent 101](https://docs.deepwisdom.ai/main/en/guide/tutorials/multi_agent_101.html) | Official docs |
| 5 | [MetaGPT Documentation - Human Engagement](https://docs.deepwisdom.ai/main/en/guide/tutorials/human_engagement.html) | Official docs |
| 6 | [MetaGPT Documentation - Breakpoint Recovery](https://docs.deepwisdom.ai/main/en/guide/in_depth_guides/breakpoint_recovery.html) | Official docs |
| 7 | [MetaGPT config2.example.yaml](https://github.com/geekan/MetaGPT/blob/main/config/config2.example.yaml) | GitHub source |
| 8 | [ChatDev GitHub](https://github.com/OpenBMB/ChatDev) | GitHub |
| 9 | [ChatDev Workflow Authoring Guide](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/workflow_authoring.md) | Official docs |
| 10 | [ChatDev .agents/skills](https://github.com/OpenBMB/ChatDev/tree/main/.agents/skills) | GitHub source |
| 11 | [CAMEL GitHub](https://github.com/camel-ai/camel) | GitHub |
| 12 | [CAMEL model_factory.py](https://github.com/camel-ai/camel/blob/master/camel/models/model_factory.py) | GitHub source |
| 13 | [CAMEL societies/workforce](https://github.com/camel-ai/camel/tree/master/camel/societies/workforce) | GitHub source |
| 14 | [CAMEL .camel/skills](https://github.com/camel-ai/camel/tree/master/.camel/skills) | GitHub source |
| 15 | [CAMEL toolkits directory](https://github.com/camel-ai/camel/tree/master/camel/toolkits) | GitHub source |
| 16 | [CAMEL Documentation](https://docs.camel-ai.org/) | Official docs |

---

## Verbatim quotes

- "MetaGPT takes a one line requirement as input and outputs user stories / competitive analysis / requirements / data structures / APIs / documents" — [Source 1](https://github.com/geekan/MetaGPT)
- "Code = SOP(Team) is the core philosophy. We materialize SOP and apply it to teams composed of LLMs." — [Source 1](https://github.com/geekan/MetaGPT)
- "ChatDev has evolved from a specialized software development multi-agent system into a comprehensive multi-agent orchestration platform." — [Source 8](https://github.com/OpenBMB/ChatDev)
- "ChatDev 2.0 (DevAll) is a Zero-Code Multi-Agent Platform for 'Developing Everything'. It empowers users to rapidly build and customize multi-agent systems through simple configuration. No coding is required." — [Source 8](https://github.com/OpenBMB/ChatDev)
- "CAMEL is an open-source community dedicated to finding the scaling laws of agents." — [Source 11](https://github.com/camel-ai/camel)
- "The framework enables multi-agent systems to continuously evolve by generating data and interacting with environments." — [Source 11](https://github.com/camel-ai/camel) (Evolvability principle)
- "The framework is designed to support systems with millions of agents, ensuring efficient coordination, communication, and resource management at scale." — [Source 11](https://github.com/camel-ai/camel) (Scalability principle)

---

## Source quality flags

- Source 5 (MetaGPT Human Engagement): mentions that the current interaction is "through terminal input, which is inconvenient for multi-line or structured writeup" — the feature is acknowledged as limited by maintainers
- Source 8 (ChatDev GitHub): marketing language in the README — "World's first AI agent development team", "Zero-Code Multi-Agent Platform" — these are product positioning claims
- Source 11 (CAMEL GitHub): marketing language — "the first and the best multi-agent framework" — this is self-promotion, not an objective claim

---

## Confidence: Medium

The information is drawn directly from GitHub repositories, official documentation, and source code. Confidence is medium because some features (especially those related to hierarchy depth, parallel execution, and session management) required interpretation of architecture and code structure rather than explicit documentation. ChatDev 2.0 is very new (released Jan 2026) and its documentation is still evolving, so some features may be present but undocumented.

---

## Gaps and open questions

1. **Hierarchy depth**: None of the three frameworks explicitly implements a three-layer dispatch->orchestrator->subagent architecture. ChatDev's subgraph nesting comes closest but is DAG-based, not tree-based. CAMEL's recursive Workforce is close but configured in code. A follow-up investigation should assess whether any framework could be extended to support this pattern without major refactoring.
2. **Conflict prevention**: No framework addresses file-scope conflict prevention. This would likely require custom implementation regardless of framework choice.
3. **LSP integration**: No framework has LSP support. This would be a novel feature to add.
4. **Shell permissions**: No framework has directory-based shell permission controls. This is a significant gap for any production deployment that needs sandboxing.
5. **MetaGPT release cadence**: The latest release (v0.8.1) is from April 2024 — over 13 months old. The project may be entering maintenance mode as the team focuses on MGX. This should be verified.
6. **ChatDev 2.0 maturity**: ChatDev 2.0 was released in January 2026 and the documentation is still being written. Several module documentation pages (e.g., skills, tooling) are marked as "Chinese for now" or return 404. The framework's long-term stability is unproven.
7. **CAMEL's parallel execution**: The workforce module's parallel execution capabilities need deeper investigation. The design principles mention scalability to "millions of agents" but current implementation appears sequential.


