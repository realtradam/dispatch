# Subagent Report: Multi-Agent Orchestration Frameworks

## Research summary
This report evaluates three open-source multi-agent orchestration frameworks — **CrewAI**, **Microsoft AutoGen (AG2)**, and **LangGraph** — against a 15-point requirements checklist for an AI agent harness. CrewAI is the most opinionated with a built-in hierarchy and YAML-driven configuration, LangGraph is the lowest-level graph-based orchestration runtime with the most flexible persistence model, and AutoGen is a maintenance-mode framework with a layered design and no-code GUI. No framework fully satisfies all 15 requirements; each has gaps in the areas of LSP integration, shell access with directory permissions, and skills systems as defined.

---

## Findings

### 1. CrewAI

#### Core Architecture

CrewAI is an open-source Python framework for orchestrating role-based AI agents. It is built entirely from scratch — independent of LangChain. It provides two complementary paradigms: **Crews** (autonomous agent teams with role-based collaboration) and **Flows** (event-driven, stateful workflows). Version 1.14.5 (latest as of May 2026). Language: Python (99%+). Stars: ~51.7k on GitHub. Commits: ~2,414. Recent releases: 191 total, active.

**Architecture layers:**
- **Agent** — role, goal, backstory, tools, LLM config
- **Crew** — orchestrates a team of agents with a Process (sequential, hierarchical, or hybrid)
- **Flow** — higher-level orchestration with `@start`, `@listen`, `@router` decorators, state management, persistence
- **Config** — YAML files for agents and tasks (recommended approach)

**Primary use case:** General-purpose multi-agent automation for enterprise workflows. Not specifically focused on coding — more general business process automation.

**Project status:** Very active. Backed by a company (CrewAI Inc.). 100k+ certified developers in the community.

#### Requirements Checklist

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 1 | **Three-layer hierarchy** | **Partial** | CrewAI has a native hierarchical process where a manager agent coordinates sub-agents. However, it's a 2-level hierarchy (manager → agent), not 3-level (dispatch → orchestrator → subagent). Flows can chain multiple crews, achieving multi-level composition programmatically but not as a built-in dispatch architecture. |
| 2 | **Config-driven orchestrators** | **Fully** | Agents and tasks are defined in YAML (`agents.yaml`, `tasks.yaml`) loaded via `@CrewBase` decorators. This is the recommended approach. Source: CrewAI docs "YAML Configuration (Recommended)" |
| 3 | **Parallel subagent execution** | **Fully** | Tasks support `async_execution=True` for parallel execution. Multiple tasks can run concurrently when using the context mechanism for dependency management. Source: CrewAI Tasks docs on Asynchronous Execution |
| 4 | **Strict hierarchy communication** | **Partial** | The hierarchical process assigns a manager that delegates tasks and validates results, providing structured parent-child communication. However, there is no built-in mechanism to prevent peer-to-peer agent messaging when delegation is enabled (`allow_delegation`). |
| 5 | **User-to-agent messaging mid-execution** | **Partial** | CrewAI supports `@human_feedback` decorator (v1.8.0+) for human-in-the-loop in Flows, and `human_input=True` on tasks. However, this is for configured approval points, not arbitrary mid-execution injection to any running agent. |
| 6 | **Conflict prevention** | **Not at all** | No built-in mechanism for assigning non-overlapping file scopes to parallel agents. Code execution is deprecated (uses external sandboxes like E2B). |
| 7 | **Role-scoped tooling** | **Fully** | Agents can have different tool sets based on role. Tools are assigned per-agent via the `tools` parameter. Tasks can also override tools. Source: CrewAI Agents documentation on tools |
| 8 | **Skills system** | **Partial** | Supports custom system templates, prompt templates, and response templates per agent. The project template uses `agents.yaml` for defining agent behaviors. Has a "skills" feature via MCP/skills.sh for AI coding assistants, but no directory-based markdown instruction system for agent definition. |
| 9 | **LSP integration** | **Not at all** | No Language Server Protocol integration for compiler diagnostics. |
| 10 | **Shell access with directory permissions** | **Not at all** | Code execution is deprecated in favor of external sandboxes. No shell access with permission controls. |
| 11 | **Session management** | **Partial** | Flows support `@persist` decorator for state persistence across restarts using SQLite. Supports "fork" via `restore_from_state_id`. No chat forking or model switching mid-conversation in the traditional sense. |
| 12 | **Human-in-the-loop checkpoints** | **Fully** | `@human_feedback` decorator on Flow methods pauses execution and collects feedback. `human_input=True` on tasks enables human review. Source: CrewAI Flows docs on human_feedback |
| 13 | **State persistence** | **Fully** | `@persist` decorator on Flows persists state to SQLite automatically. Supports resume and fork patterns. Source: CrewAI Flows persistence docs |
| 14 | **Provider-agnostic LLM** | **Fully** | Supports OpenAI, Azure, Anthropic, Ollama, Gemini, and many more via LiteLLM integration. The `llm` parameter accepts model strings or `LLM` instances. Source: CrewAI docs "Connecting Your Crew to a Model" |
| 15 | **Multiple interfaces** | **Partial** | Has a CLI (`crewai create`, `crewai run`, `crewai flow kickoff`) and a Python API. No native TUI or API server in the open-source version (CrewAI AMP provides enterprise management console). |

---

### 2. Microsoft AutoGen (AG2)

#### Core Architecture

AutoGen is a Python framework for building multi-agent AI applications. Developed by Microsoft Research. Currently in **maintenance mode** — no new features, community-managed only. Latest release: `python-v0.7.5` (Sep 2025). Stars: ~58.2k. Forks: ~8.8k. Commits: ~3,782. Microsoft recommends migrating to **Microsoft Agent Framework** for new projects.

**Architecture layers (3-tier design):**
- **Core API** — message passing, event-driven agents, distributed runtime, cross-language (Python + .NET)
- **AgentChat API** — higher-level opinionated API for rapid prototyping with agents, teams, group chats
- **Extensions API** — model clients, tools, code execution backends

**Team patterns:** RoundRobinGroupChat, SelectorGroupChat, Swarm, MagenticOneGroupChat, GraphFlow

**Primary use case:** Conversational multi-agent AI applications, research, prototyping. Magentic-One for web/file tasks.

**Project status:** Maintenance mode. No new features. Users directed to Microsoft Agent Framework.

#### Requirements Checklist

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 1 | **Three-layer hierarchy** | **Partial** | AutoGen has a flat agent model with "teams" orchestrating agents. It supports Swarm and SelectorGroupChat for multi-agent coordination, and GraphFlow for workflows. No native 3-layer dispatch → orchestrator → subagent hierarchy exists. Subordination must be implemented manually via `AgentTool` wrapping. |
| 2 | **Config-driven orchestrators** | **Partial** | AutoGen Studio provides a no-code GUI for prototyping. The framework itself is code-first — teams, agents, and termination conditions are defined in Python code. Component serialization exists (`.dump_component()`) but is not a YAML-based config system. |
| 3 | **Parallel subagent execution** | **Partial** | The `AgentTool` pattern allows one agent to call another as a tool, but this is sequential delegation, not parallel execution. RoundRobinGroupChat is sequential (turn-based). No native parallel agent execution within a team. |
| 4 | **Strict hierarchy communication** | **Partial** | In SelectorGroupChat and Swarm, speaker selection is controlled. `AgentTool` wrapping creates a tool-call boundary. However, no strict parent-child communication restriction mechanism is built in. |
| 5 | **User-to-agent messaging mid-execution** | **Fully** | `UserProxyAgent` allows injecting user input during team execution (blocking). `ExternalTermination` can stop teams mid-execution. `HandoffTermination` enables handoff to user. Source: AutoGen Human-in-the-Loop docs |
| 6 | **Conflict prevention** | **Not at all** | No built-in mechanism for non-overlapping file scopes in parallel agents. |
| 7 | **Role-scoped tooling** | **Fully** | Each `AssistantAgent` can have its own set of tools. Agent descriptions define their role for the selector. Source: AutoGen AgentChat docs on agents and tools |
| 8 | **Skills system** | **Not at all** | No skills system for injecting markdown/text instructions per agent type. Agents are configured via `system_message` string and `description` string in code. |
| 9 | **LSP integration** | **Not at all** | No Language Server Protocol integration. |
| 10 | **Shell access with directory permissions** | **Not at all** | Code execution requires external sandboxes or MCP tools. No built-in shell access with permissions. |
| 11 | **Session management** | **Partial** | Teams support `save_state()` and `load_state()` for persisting conversation state. State can be serialized to JSON. No chat forking or model switching mid-conversation. |
| 12 | **Human-in-the-loop checkpoints** | **Fully** | `UserProxyAgent` for inline feedback, `HandoffTermination` for async feedback, `max_turns` for turn-based pausing. Source: AutoGen Human-in-the-Loop tutorial |
| 13 | **State persistence** | **Fully** | `save_state()` / `load_state()` on agents and teams. State dictionaries can be serialized to file or database. Source: AutoGen Managing State docs |
| 14 | **Provider-agnostic LLM** | **Fully** | Supports OpenAI, Azure OpenAI, Azure AI Foundry, Anthropic (experimental), Ollama (experimental), Gemini (via API), Llama API, plus Semantic Kernel adapter for even more providers. Source: AutoGen Models docs |
| 15 | **Multiple interfaces** | **Fully** | Python API, CLI (`autogenstudio ui`), AutoGen Studio (no-code GUI web app), and FastAPI/ChainLit/Streamlit integration samples. Source: AutoGen README and FastAPI sample |

---

### 3. LangGraph

#### Core Architecture

LangGraph is a low-level orchestration framework for building stateful, long-running agents. Developed by LangChain Inc. Built as a graph-based runtime inspired by Google's Pregel and Apache Beam. Latest release: `langgraph==1.2.0` (May 2026). Stars: ~32.4k. Commits: ~6,862. Active development (534 releases total).

**Architecture:**
- **StateGraph** — defines state schema (TypedDict/Pydantic), nodes (functions), edges (conditional/static)
- **Subgraphs** — graphs used as nodes in other graphs (supports multi-agent patterns)
- **Checkpointer** — persistence layer for state snapshots at every super-step
- **Store** — cross-thread memory for long-term knowledge
- **Persistence modes:** per-invocation (default), per-thread, stateless

**Primary use case:** Low-level agent orchestration for complex, stateful, long-running workflows. Used by Klarna, Replit, Elastic, Uber, J.P. Morgan. Higher-level abstraction available via Deep Agents and LangChain agents.

**Project status:** Very active. Backed by LangChain Inc with commercial LangSmith platform.

#### Requirements Checklist

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 1 | **Three-layer hierarchy** | **Fully** | LangGraph's subgraph architecture supports arbitrary nesting. A parent graph can contain subgraphs, which can contain further subgraphs. `Command(goto=..., graph=Command.PARENT)` enables navigation between levels. Each level has its own state schema. Source: LangGraph Subgraphs documentation |
| 2 | **Config-driven orchestrators** | **Not at all** | LangGraph is purely code-defined — graphs, nodes, edges, and state schemas are all Python code. No YAML or config file support for defining orchestrator types. LangSmith Studio provides a UI but generates code. |
| 3 | **Parallel subagent execution** | **Fully** | Multiple outgoing edges from a single node execute in parallel (same super-step). `Send()` API enables map-reduce patterns with dynamic fan-out. Subgraphs can run in parallel. Source: LangGraph Graph API docs on edges and Send |
| 4 | **Strict hierarchy communication** | **Fully** | Subgraphs can have private state schemas invisible to the parent graph. When a subgraph is invoked via a node function, the parent only sees what the node function returns. State isolation is achieved via separate state schemas. Source: LangGraph Subgraphs docs on different state schemas |
| 5 | **User-to-agent messaging mid-execution** | **Fully** | `interrupt()` function pauses graph execution and returns control to the caller. The caller can inspect state and resume with `Command(resume=...)`. Supports multiple simultaneous interrupts. Source: LangGraph Interrupts documentation |
| 6 | **Conflict prevention** | **Not at all** | No built-in mechanism for file scope conflict prevention. |
| 7 | **Role-scoped tooling** | **Fully** | Each agent node can have its own set of tools. In multi-agent patterns, subgraphs/agents have independent tool configurations. Tools are LangChain-compatible. |
| 8 | **Skills system** | **Not at all** | No skills system for injecting markdown instructions per agent type. No directory-based instruction organization. Agents use system prompts defined in code. |
| 9 | **LSP integration** | **Not at all** | No Language Server Protocol integration. |
| 10 | **Shell access with directory permissions** | **Not at all** | No built-in shell access. Code execution relies on external tools or LangChain tool integrations. |
| 11 | **Session management** | **Partial** | Checkpointer-based threads provide conversation history via `get_state_history()`. Time-travel debugging via replay from checkpoints. `update_state()` for editing state. No explicit chat forking or model switching mid-conversation. |
| 12 | **Human-in-the-loop checkpoints** | **Fully** | `interrupt()` function for dynamic pausing. Static breakpoints via `interrupt_before`/`interrupt_after` at compile time. Supports approval workflows, review-and-edit, and validation loops. Source: LangGraph Interrupts documentation |
| 13 | **State persistence** | **Fully** | Multiple checkpointers: InMemorySaver, SqliteSaver, PostgresSaver, Azure CosmosDB. Checkpoints at every super-step. Cross-thread memory via Store. Encryption support. Source: LangGraph Persistence documentation |
| 14 | **Provider-agnostic LLM** | **Fully** | LangGraph can use any LangChain-compatible model provider (OpenAI, Anthropic, Google, Ollama, AWS Bedrock, Azure, etc.) plus standalone models without LangChain. The `Runtime` context can pass model configuration. |
| 15 | **Multiple interfaces** | **Partial** | Python API primarily. LangSmith Studio for visual prototyping. LangGraph API for deployment. No native CLI or TUI. Deep Agents SDK provides a higher-level interface. |

---

## Summary Comparison Table

| # | Requirement | CrewAI | AutoGen (AG2) | LangGraph |
|---|------------|--------|---------------|-----------|
| 1 | **Three-layer hierarchy** | Partial (2-level natively, chaining via Flows) | Partial (flat agent teams, Swarm/GraphFlow) | **Fully** (arbitrary nesting via subgraphs) |
| 2 | **Config-driven orchestrators** | **Fully** (YAML agents.yaml/tasks.yaml) | Partial (code-first, Studio GUI, component serialization) | Not at all (purely code-defined) |
| 3 | **Parallel subagent execution** | **Fully** (async_execution tasks) | Partial (sequential team patterns, AgentTool is blocking) | **Fully** (Send API, parallel edges, map-reduce) |
| 4 | **Strict hierarchy communication** | Partial (manager delegates but no P2P prevention) | Partial (SelectorGroupChat controls turns, AgentTool boundary) | **Fully** (private state schemas, subgraph isolation) |
| 5 | **User-to-agent messaging mid-execution** | Partial (@human_feedback at configured points) | **Fully** (UserProxyAgent, ExternalTermination, HandoffTermination) | **Fully** (interrupt()/Command(resume=...) anywhere) |
| 6 | **Conflict prevention** | Not at all | Not at all | Not at all |
| 7 | **Role-scoped tooling** | **Fully** (per-agent tools, task override) | **Fully** (per-agent tools) | **Fully** (per-node tools, LangChain-compatible) |
| 8 | **Skills system** | Partial (agent templates, prompt customization) | Not at all | Not at all |
| 9 | **LSP integration** | Not at all | Not at all | Not at all |
| 10 | **Shell access with directory permissions** | Not at all | Not at all | Not at all |
| 11 | **Session management** | Partial (Flow persist/fork) | Partial (save_state/load_state, JSON serialization) | Partial (checkpointer history, time travel, update_state) |
| 12 | **Human-in-the-loop checkpoints** | **Fully** (@human_feedback, human_input on tasks) | **Fully** (UserProxyAgent, HandoffTermination, max_turns) | **Fully** (interrupt(), static breakpoints, approval patterns) |
| 13 | **State persistence** | **Fully** (@persist with SQLite, resume/fork) | **Fully** (save_state/load_state to file or DB) | **Fully** (checkpointers: Memory, SQLite, Postgres, CosmosDB) |
| 14 | **Provider-agnostic LLM** | **Fully** (many providers via LiteLLM) | **Fully** (many providers via Extensions API + SK adapter) | **Fully** (all LangChain providers, plus standalone mode) |
| 15 | **Multiple interfaces** | Partial (CLI + Python API, AMP enterprise console) | **Fully** (Python API, CLI, Studio web GUI, FastAPI/Streamlit) | Partial (Python API, LangSmith Studio, LangGraph API) |

---

## Overall Assessment

### CrewAI
**Strength:** Most opinionated framework for role-based agents with YAML-driven configuration. Excellent for enterprise automation where you want to define agents declaratively. Strong community (100k+ certified developers), active development, and a commercial offering (CrewAI AMP).

**Key Gaps for this harness:** No LSP, no shell permissions, no 3-layer dispatch hierarchy natively, limited mid-execution user injection.

### AutoGen (AG2)
**Strength:** Best GUI/studio support for prototyping. Most flexible human-in-the-loop with `UserProxyAgent` and handoff patterns. Multiple interface options (Python, CLI, Studio web app). Provider-agnostic model support with Semantic Kernel adapter.

**Key Gaps:** **Maintenance mode** — no new features, users directed to Microsoft Agent Framework. No parallel execution, no config-driven setup, flat agent model.

### LangGraph
**Strength:** Most architecturally flexible — arbitrary graph topologies, arbitrary subgraph nesting, the richest persistence model (multiple checkpointers + cross-thread store), durable execution, and the most sophisticated interrupt system. Best for complex, long-running, stateful workflows.

**Key Gaps:** Code-only configuration (no YAML), no built-in skills system, no CLI/TUI, steeper learning curve due to low-level nature. No file scope conflict prevention.

---

## Source list

| # | Source | Type |
|---|--------|------|
| 1 | [CrewAI GitHub Repository](https://github.com/crewAIInc/crewAI) | official |
| 2 | [CrewAI Documentation - Agents](https://docs.crewai.com/concepts/agents) | official |
| 3 | [CrewAI Documentation - Tasks](https://docs.crewai.com/concepts/tasks) | official |
| 4 | [CrewAI Documentation - Flows](https://docs.crewai.com/concepts/flows) | official |
| 5 | [CrewAI Documentation - Memory](https://docs.crewai.com/concepts/memory) | official |
| 6 | [CrewAI Documentation - Processes](https://docs.crewai.com/core-concepts/Processes/) | official |
| 7 | [AutoGen GitHub Repository](https://github.com/microsoft/autogen) | official |
| 8 | [AutoGen Documentation - Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html) | official |
| 9 | [AutoGen Documentation - Human-in-the-Loop](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html) | official |
| 10 | [AutoGen Documentation - Managing State](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html) | official |
| 11 | [AutoGen Documentation - Models](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/models.html) | official |
| 12 | [AutoGen Documentation - Selector Group Chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html) | official |
| 13 | [LangGraph GitHub Repository](https://github.com/langchain-ai/langgraph) | official |
| 14 | [LangGraph Documentation - Overview](https://docs.langchain.com/oss/python/langgraph/overview) | official |
| 15 | [LangGraph Documentation - Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) | official |
| 16 | [LangGraph Documentation - Subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs) | official |
| 17 | [LangGraph Documentation - Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | official |
| 18 | [LangGraph Documentation - Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | official |

---

## Verbatim quotes

- "CrewAI is a lean, lightning-fast Python framework built entirely from scratch—completely independent of LangChain or other agent frameworks." — [CrewAI GitHub README](https://github.com/crewAIInc/crewAI)
- "Using YAML configuration provides a cleaner, more maintainable way to define agents. We strongly recommend using this approach in your CrewAI projects." — [CrewAI Agents docs](https://docs.crewai.com/concepts/agents)
- "AutoGen is now in maintenance mode. It will not receive new features or enhancements and is community managed going forward." — [AutoGen GitHub README](https://github.com/microsoft/autogen)
- "New users should start with Microsoft Agent Framework. Existing users are encouraged to migrate." — [AutoGen GitHub README](https://github.com/microsoft/autogen)
- "LangGraph is a low-level orchestration framework for building, managing, and deploying long-running, stateful agents." — [LangGraph GitHub README](https://github.com/langchain-ai/langgraph)
- "Subgraphs are useful for building multi-agent systems, reusing a set of nodes in multiple graphs, and distributing development." — [LangGraph Subgraphs docs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs)
- "Interrupts allow you to pause graph execution at specific points and wait for external input before continuing." — [LangGraph Interrupts docs](https://docs.langchain.com/oss/python/langgraph/interrupts)
- "UserProxyAgent is a special built-in agent that acts as a proxy for a user to provide feedback to the team." — [AutoGen HITL docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html)

---

## Source quality flags

- No significant quality issues found. All three sources are primary (official GitHub repositories, official documentation sites).
- AutoGen's documentation is comprehensive but the project is in maintenance mode.

---

## Confidence: High

All claims are sourced from official GitHub repositories and official documentation sites for each framework (CrewAI, AutoGen, LangGraph). The information reflects the current state as of May 2026.

## Gaps and open questions

- **LSP integration**: None of the three frameworks support Language Server Protocol integration. This would need to be built as a custom extension for any chosen framework.
- **Shell access with directory permissions**: None support this natively. Shell access would require wrapping shell tools with permission checks manually in any framework.
- **Skills system**: Only CrewAI has anything close (prompt templates, agent configuration files), but none have the directory-based markdown instruction system described in the requirements.
- **Conflict prevention for file scopes**: No framework has built-in mechanisms for this. Would need to be implemented as a custom tool wrapper or middleware.
- **Session management (chat forking, model switching)**: All three have basic state persistence but not the full session management features (chat forking, model switching mid-conversation).
- **CrewAI's Allow Delegation**: When `allow_delegation=True`, agents can delegate tasks to other agents, which could include peer agents — creating implicit P2P communication. The strictness of hierarchy enforcement depends on configuration.
- **AutoGen's successor**: Microsoft Agent Framework (MAF) is the recommended successor and may address many gaps, but it was outside this research scope.

---

## Tool calls made

1. `webfetch` - 3 GitHub README pages (CrewAI, AutoGen, LangGraph)
2. `webfetch` - CrewAI Processes page, Crews page
3. `webfetch` - LangGraph overview, AutoGen tutorial, CrewAI agents, tasks
4. `webfetch` - CrewAI flows, AutoGen HITL, LangGraph interrupts, LangGraph subgraphs (404)
5. `webfetch` - LangGraph persistence, AutoGen state management, AutoGen selector chat, LangGraph graph API
6. `webfetch` - LangGraph subgraphs, CrewAI memory, AutoGen models
