# Subagent Report: General Agent Platforms (SuperAGI, Agency Swarm, Semantic Kernel)

## Research summary

This report evaluates three open-source general AI agent platforms — **SuperAGI**, **Agency Swarm**, and **Microsoft Semantic Kernel** — against 15 specific requirements for an agent harness architecture. SuperAGI is a single-agent autonomous agent framework with a GUI and tool marketplace, not designed for hierarchical multi-agent orchestration. Agency Swarm is a Python multi-agent orchestration framework built on the OpenAI Agents SDK, supporting structured communication flows with parallel execution. Microsoft Semantic Kernel is an enterprise-grade SDK (C#/Python/Java) for building AI agents and multi-agent systems, now succeeded by Microsoft Agent Framework. None of the three fully support all 15 requirements; Agency Swarm comes closest for hierarchical orchestration needs, while Semantic Kernel provides the richest SDK for plugin-extensible agent systems.

**Confidence**: High — all findings are based on official GitHub repositories, documentation sites, and framework README files.

---

## Findings

### 1. SuperAGI

#### Core Architecture

SuperAGI is a **dev-first open-source autonomous AI agent framework** written in Python. It is designed for building, managing, and running single autonomous agents with tool augmentation. The architecture uses a Celery task queue, PostgreSQL database, Redis for caching, and multiple vector store options (Pinecone, Weaviate, Chroma, Qdrant). Agents operate as independent ReAct (Reasoning + Acting) loops with goals, instructions, constraints, and tools.

- **Language**: Python
- **GitHub stars**: ~17.5k, 2,342 commits
- **Latest release**: v0.0.11 (appears stale — README states "Under Development!")
- **Primary use case**: Running individual autonomous agents with tool augmentation
- **Architecture diagrams** show a single agent workflow with tool integration, not multi-agent hierarchy

Key architectural components visible in the codebase:
- `superagi/agent/` — single-agent execution loop with prompt building, tool execution, task queue
- `config_template.yaml` — YAML-based configuration for system settings (API keys, model, DB, storage)
- `gui/` — React-based graphical user interface
- `tools.json` — tool definitions

[Source: SuperAGI GitHub README](https://github.com/TransformerOptimus/SuperAGI)
[Source: SuperAGI config_template.yaml](https://raw.githubusercontent.com/TransformerOptimus/SuperAGI/main/config_template.yaml)

#### Requirements Checklist

| # | Requirement | Status | Explanation |
|---|-------------|--------|-------------|
| 1 | **Three-layer hierarchy** | **Not supported** | SuperAGI is a single-agent framework. No orchestrator-subagent hierarchy exists. Multiple agents can run but are independent. |
| 2 | **Config-driven orchestrators** | **Not supported** | System config (API keys, model, DB) is YAML-driven, but agent definitions, tools, and workflows are defined in Python code, not config files. |
| 3 | **Parallel subagent execution** | **Partially supported** | README states "You can run concurrent agents seamlessly" but these are independent agent runs, not orchestrated subagents. No parent-child coordination of parallelism. |
| 4 | **Strict hierarchy communication** | **Not supported** | No inter-agent communication at all. Each agent is independent. |
| 5 | **User-to-agent messaging mid-execution** | **Partially supported** | "Action Console" allows user interaction by giving agents input and permissions, but this is at the GUI level, not arbitrary injection to running agents. |
| 6 | **Conflict prevention** | **Not supported** | No mechanism for assigning non-overlapping file scopes to parallel agents. |
| 7 | **Role-scoped tooling** | **Partially supported** | Agents can be configured with different toolkits from the marketplace, but this is done through the GUI/database, not through a code-level role system. |
| 8 | **Skills system (markdown instructions)** | **Partially supported** | Uses prompt templates with variable substitution (`{goals}`, `{instructions}`, `{constraints}`), but not a markdown file-based skills directory system. |
| 9 | **LSP integration** | **Not supported** | No Language Server Protocol integration. |
| 10 | **Shell access with permissions** | **Not supported** | No built-in shell tool. Tools are pre-built plugins from the marketplace. |
| 11 | **Session management** | **Partially supported** | "Agent Memory Storage" for learning/adaptation, "Performance Telemetry" for insights. No chat forking or model switching mid-conversation. |
| 12 | **Human-in-the-loop checkpoints** | **Partially supported** | Action Console provides some user input/permissions, but no configurable checkpoint mechanism. |
| 13 | **State persistence** | **Partially supported** | Uses PostgreSQL for agent state and file storage for workspace artifacts (`RESOURCES_OUTPUT_ROOT_DIR`). Sessions persist via DB. |
| 14 | **Provider-agnostic LLM** | **Supported** | Supports OpenAI, Google PaLM, Replicate, HuggingFace. Configurable via `config_template.yaml`. Local LLM support via Text Generation Web UI. |
| 15 | **Multiple interfaces** | **Supported** | Has GUI (React web interface), CLI (`cli2.py`), and REST API (via FastAPI/Postman docs). |

---

### 2. Agency Swarm

#### Core Architecture

Agency Swarm is a **Python multi-agent orchestration framework** built on the OpenAI Agents SDK. It organizes agents into structured communication flows that mirror real-world organizational structures. Agents are defined with roles, instructions (from markdown files), tools, and MCP server support. Communication flows are directional tuples that define which agents can message which.

- **Language**: Python (97.8%), some JavaScript/TypeScript for TUI
- **GitHub stars**: ~4.4k, 2,412 commits
- **Latest release**: v1.9.8 (May 6, 2026 — very active)
- **Primary use case**: Multi-agent orchestration with structured communication patterns
- **Python**: 3.12+

Key features from the documentation:
- **Communication flows**: Directional paths using `(sender, receiver)` tuples. Supports Handoff and Orchestrator-Worker patterns.
- **Parallel execution**: "the CEO can assign tasks to both Developer and Virtual Assistant, so they will run in parallel in different threads and come back with their results to the CEO"
- **Per-agent configuration**: Each agent has its own `instructions.md`, `files/`, `tools/`, `schemas/` directories
- **State persistence**: `load_threads_callback` and `save_threads_callback` for thread persistence
- **Multiple run modes**: TUI, CopilotKit/AG-UI web interface, FastAPI HTTP API, async programmatic

Key architecture code pattern:
```python
agency = Agency(
    ceo, dev,  # Entry points
    communication_flows=[
        (ceo, dev),  # Director can delegate to developer
        (ceo, va),   # Director can delegate to virtual assistant
    ],
    shared_instructions="./agency_manifesto.md",
    shared_tools=[get_current_time],
)
```

[Source: Agency Swarm GitHub README](https://github.com/VRSEN/agency-swarm)
[Source: Agency Swarm Docs - Overview](https://agency-swarm.ai/core-framework/agencies/overview)
[Source: Agency Swarm Docs - Communication Flows](https://agency-swarm.ai/core-framework/agencies/communication-flows)

#### Requirements Checklist

| # | Requirement | Status | Explanation |
|---|-------------|--------|-------------|
| 1 | **Three-layer hierarchy** | **Partially supported** | Supports 2-layer hierarchy (entry point orchestrator → workers). The Orchestrator-Worker pattern has an orchestrator delegating to workers. A 3rd layer would require nesting agencies or custom coding — not natively supported. |
| 2 | **Config-driven orchestrators** | **Not supported** | Agents and communication flows are defined in Python code. Instructions can be loaded from markdown files, but the orchestration structure itself is code-defined, not config-driven. |
| 3 | **Parallel subagent execution** | **Supported** | Explicitly supported: "the CEO can assign tasks to both Developer and Virtual Assistant, so they will run in parallel in different threads and come back with their results to the CEO." [Source](https://agency-swarm.ai/core-framework/agencies/communication-flows) |
| 4 | **Strict hierarchy communication** | **Supported** | Communication flows are directional tuples. By defining only parent→child flows and omitting peer flows, communication is restricted to parent-child only. |
| 5 | **User-to-agent messaging mid-execution** | **Partially supported** | TUI supports `@mentions` to direct messages to specific agents. FastAPI supports `recipient_agent` parameter. However, mid-execution injection to running agents is not documented. |
| 6 | **Conflict prevention** | **Not supported** | No built-in mechanism for assigning non-overlapping file scopes to parallel agents. |
| 7 | **Role-scoped tooling** | **Supported** | Each agent has its own `tools=[]`, `tools_folder`, `schemas_folder`. Tools are role-specific. Shared tools can be applied via `shared_tools`. |
| 8 | **Skills system (markdown instructions)** | **Partially supported** | Instructions can be loaded from markdown files (`instructions.md`). Shared instructions via `shared_instructions` (file path). Per-agent folder structure includes `tools/`, `files/`, `schemas/`. However, it's not a directory-based skills system with global + project level override. |
| 9 | **LSP integration** | **Not supported** | No Language Server Protocol integration. |
| 10 | **Shell access with permissions** | **Not supported** | No native shell execution tool. Relies on OpenAI function calling for tool execution. |
| 11 | **Session management** | **Partially supported** | Thread persistence via `load_threads_callback`/`save_threads_callback`. `/cost` command in TUI. No chat forking or model switching mid-conversation documented. |
| 12 | **Human-in-the-loop checkpoints** | **Partially supported** | Has input and output guardrails that can check/modify messages. No explicit configurable checkpoint mechanism for pausing execution. |
| 13 | **State persistence** | **Partially supported** | Thread state can be persisted via callbacks. User context accessible by agents. No built-in plan/artifact persistence mechanism. |
| 14 | **Provider-agnostic LLM** | **Supported** | Native OpenAI (GPT-5, GPT-4o). Via LiteLLM router: Anthropic, Google Gemini, Grok, Azure OpenAI, OpenRouter. |
| 15 | **Multiple interfaces** | **Supported** | TUI (`agency.tui()`, `npx @vrsen/agentswarm`), CopilotKit/AG-UI web interface (`agency.copilot_demo()`), FastAPI HTTP API, async/sync programmatic API. |

---

### 3. Microsoft Semantic Kernel

#### Core Architecture

Semantic Kernel is an **enterprise-grade SDK** for integrating LLMs into applications and building AI agents and multi-agent systems. It is written in C# (primary), Python, and Java. The kernel acts as a Dependency Injection container that manages AI services and plugins. The Agent Framework (within SK) provides agent types and orchestration patterns. **Important**: Semantic Kernel has been succeeded by **Microsoft Agent Framework** (MAF), which is the enterprise-ready successor at v1.0.

- **Languages**: C# (66.8%), Python (31.3%), Java
- **GitHub stars**: ~27.9k, 4,991 commits
- **Latest release**: python-1.42.0 (May 14, 2026 — very active)
- **Primary use case**: Building AI-powered applications with LLM integration, plugin extensibility, and multi-agent orchestration
- **Python**: 3.10+, .NET: .NET 10.0+, Java: JDK 17+

Key architectural components:
- **Kernel**: Central DI container holding services (AI, logging, HTTP) and plugins
- **Plugins**: Collections of functions with semantic descriptions, supporting native code, OpenAPI, and MCP
- **Agent Framework**: `ChatCompletionAgent`, `OpenAIAssistantAgent`, `AzureAIAgent`, `OpenAIResponsesAgent`
- **Orchestration Framework** (experimental): `ConcurrentOrchestration`, `SequentialOrchestration`, `HandoffOrchestration`, `GroupChatOrchestration`, `MagenticOrchestration`

[Source: Semantic Kernel GitHub README](https://github.com/microsoft/semantic-kernel)
[Source: SK Agent Framework Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/)
[Source: SK Orchestration Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)

#### Requirements Checklist

| # | Requirement | Status | Explanation |
|---|-------------|--------|-------------|
| 1 | **Three-layer hierarchy** | **Not supported** | Orchestration patterns support 2 layers (orchestrator ↔ agents). GroupChat supports collaborative patterns but not a strict 3-tier dispatch→orchestrator→subagent chain. The experimental orchestration framework is flat. |
| 2 | **Config-driven orchestrators** | **Not supported** | Semantic Kernel is code-first SDK. Orchestration patterns are instantiated via code (e.g., `ConcurrentOrchestration(members=[...])`). Prompt templates can be loaded from files but orchestration structure is not config-driven. |
| 3 | **Parallel subagent execution** | **Supported** | `ConcurrentOrchestration` runs multiple agents in parallel on the same task. Results are collected independently. [Source](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent) |
| 4 | **Strict hierarchy communication** | **Not supported** | Agents in GroupChat/Orchestration all communicate via shared history. No mechanism to restrict communication to parent-child only. |
| 5 | **User-to-agent messaging mid-execution** | **Partially supported** | Messages can be added to `ChatHistory` at any point, but not designed for injecting into a running orchestration mid-execution. |
| 6 | **Conflict prevention** | **Not supported** | No built-in file scope assignment mechanism. |
| 7 | **Role-scoped tooling** | **Supported** | Each agent can be configured with different plugins/function tools. Plugins can be per-agent using the kernel's DI system. |
| 8 | **Skills system (markdown instructions)** | **Partially supported** | Has a powerful plugin system with semantic kernel functions. Prompt templates support variable substitution. Not a markdown/text-based skills directory system with global/project override. |
| 9 | **LSP integration** | **Not supported** | No Language Server Protocol integration. |
| 10 | **Shell access with permissions** | **Not supported** | No built-in shell execution tool. Code execution would need a custom plugin. |
| 11 | **Session management** | **Not supported** | No built-in session management, chat forking, or model switching. ChatHistory is in-memory. |
| 12 | **Human-in-the-loop checkpoints** | **Partially supported** | Human-in-the-loop is mentioned for "task automation functions" but there is no explicit configurable checkpoint mechanism in the agent framework. |
| 13 | **State persistence** | **Not supported** | No built-in state persistence. ChatHistory, plans, artifacts are in-memory. Requires custom implementation for persistence. |
| 14 | **Provider-agnostic LLM** | **Supported** | Built-in support for OpenAI, Azure OpenAI, Hugging Face, NVIDIA. Local deployment with Ollama, LMStudio, ONNX. |
| 15 | **Multiple interfaces** | **Not supported** | SDK only. No CLI, TUI, or built-in API server. Must build your own interfaces. |

---

## Comparison Summary Table

| # | Requirement | SuperAGI | Agency Swarm | Semantic Kernel |
|---|-------------|----------|--------------|-----------------|
| 1 | Three-layer hierarchy | ❌ Not supported | ⚠️ Partial (2-layer) | ❌ Not supported |
| 2 | Config-driven orchestrators | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 3 | Parallel subagent execution | ⚠️ Partial (independent runs) | ✅ Supported | ✅ Supported |
| 4 | Strict hierarchy communication | ❌ Not supported | ✅ Supported | ❌ Not supported |
| 5 | User-to-agent messaging mid-execution | ⚠️ Partial (Action Console) | ⚠️ Partial (@mentions, recipient_agent) | ⚠️ Partial (ChatHistory injection) |
| 6 | Conflict prevention | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 7 | Role-scoped tooling | ⚠️ Partial (toolkit marketplace) | ✅ Supported | ✅ Supported |
| 8 | Skills system (markdown instructions) | ⚠️ Partial (prompt templates) | ⚠️ Partial (instructions.md, shared_instructions) | ⚠️ Partial (plugin system) |
| 9 | LSP integration | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 10 | Shell access with permissions | ❌ Not supported | ❌ Not supported | ❌ Not supported |
| 11 | Session management | ⚠️ Partial (memory storage, telemetry) | ⚠️ Partial (thread callbacks) | ❌ Not supported |
| 12 | Human-in-the-loop checkpoints | ⚠️ Partial (Action Console) | ⚠️ Partial (guardrails) | ⚠️ Partial (mentioned for plugins) |
| 13 | State persistence | ⚠️ Partial (PostgreSQL, file storage) | ⚠️ Partial (thread callbacks, user context) | ❌ Not supported |
| 14 | Provider-agnostic LLM | ✅ Supported | ✅ Supported | ✅ Supported |
| 15 | Multiple interfaces | ✅ Supported (GUI, CLI, API) | ✅ Supported (TUI, Web, API, programmatic) | ❌ Not supported (SDK only) |

---

## Key Questions Answered

### 1. What is each framework's core architecture? How many layers of agent hierarchy does it support?

- **SuperAGI**: Single autonomous agent architecture. No hierarchy — each agent is independent. Maximum layers: 1.
- **Agency Swarm**: Multi-agent orchestration with directional communication flows. Supports 2 layers (entry point orchestrator → worker agents). Can be stretched by nesting but not natively supported.
- **Semantic Kernel**: SDK for building AI agents with orchestration patterns. Supports 2 layers (orchestrator → participating agents). Orchestration framework is experimental.

### 2. How extensible/configurable is each framework without modifying source code?

- **SuperAGI**: System-level YAML config for API keys, models, DB. Tools via marketplace/JSON. Agent prompt templates with variable substitution. Limited config without modifying Python code.
- **Agency Swarm**: Instructions from markdown files. Tools from folder discovery. MCP server support. Communication flows via code. No config-file-based agent definition.
- **Semantic Kernel**: Plugin system via native code, OpenAPI specs, or MCP servers. Prompt templates. Everything requires code (C#, Python, Java).

### 3. What is the primary use case each framework was designed for?

- **SuperAGI**: Running individual autonomous AI agents with tool augmentation for task completion.
- **Agency Swarm**: Multi-agent collaboration with structured organizational patterns (CEO, developer, virtual assistant roles).
- **Semantic Kernel**: Integrating LLMs into enterprise .NET/Python applications with plugin extensibility and multi-agent orchestration.

### 4. How active is each project?

- **SuperAGI**: Stale. v0.0.11 release, README states "Under Development!" with 182 open issues. Community: Discord, Reddit. Creator active on Twitter.
- **Agency Swarm**: Very active. v1.9.8 (May 6, 2026). 61 releases. 2,412 commits. Active maintainer (VRSEN). Discord community. YouTube channel.
- **Semantic Kernel**: Very active. python-1.42.0 (May 14, 2026). 269 releases. 4,991 commits. Microsoft-maintained. Discord community. Note: now superseded by Microsoft Agent Framework.

### 5. What language is each framework written in?

- **SuperAGI**: Python
- **Agency Swarm**: Python (primary), JavaScript/TypeScript (TUI UI)
- **Semantic Kernel**: C# (primary, 66.8%), Python (31.3%), Java

---

## Source list

| # | Source | Type |
|---|--------|------|
| 1 | [SuperAGI GitHub Repository](https://github.com/TransformerOptimus/SuperAGI) | GitHub / code |
| 2 | [SuperAGI config_template.yaml](https://raw.githubusercontent.com/TransformerOptimus/SuperAGI/main/config_template.yaml) | Config file |
| 3 | [SuperAGI agent_prompt_builder.py](https://github.com/TransformerOptimus/SuperAGI/blob/main/superagi/agent/agent_prompt_builder.py) | Source code |
| 4 | [Agency Swarm GitHub Repository](https://github.com/VRSEN/agency-swarm) | GitHub / code |
| 5 | [Agency Swarm Docs - Overview](https://agency-swarm.ai/core-framework/agencies/overview) | Official docs |
| 6 | [Agency Swarm Docs - Communication Flows](https://agency-swarm.ai/core-framework/agencies/communication-flows) | Official docs |
| 7 | [Agency Swarm Docs - Running an Agency](https://agency-swarm.ai/core-framework/agencies/running-agency) | Official docs |
| 8 | [Agency Swarm Docs - Agents Overview](https://agency-swarm.ai/core-framework/agents/overview) | Official docs |
| 9 | [Agency Swarm Docs - Observability](https://agency-swarm.ai/additional-features/observability) | Official docs |
| 10 | [Agency Swarm Docs - FastAPI Integration](https://agency-swarm.ai/additional-features/fastapi-integration) | Official docs |
| 11 | [Semantic Kernel GitHub Repository](https://github.com/microsoft/semantic-kernel) | GitHub / code |
| 12 | [SK Agent Framework Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/) | Official docs (Microsoft Learn) |
| 13 | [SK Orchestration Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/) | Official docs (Microsoft Learn) |
| 14 | [SK Concurrent Orchestration Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent) | Official docs (Microsoft Learn) |
| 15 | [SK Kernel Concepts Docs](https://learn.microsoft.com/en-us/semantic-kernel/concepts/kernel) | Official docs (Microsoft Learn) |
| 16 | [SK Plugins Docs](https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/) | Official docs (Microsoft Learn) |

---

## Verbatim quotes

- "A dev-first open source autonomous AI agent framework enabling developers to build, manage & run useful autonomous agents. You can run concurrent agents seamlessly" — [SuperAGI GitHub README](https://github.com/TransformerOptimus/SuperAGI)
- "The CEO can assign tasks to both Developer and Virtual Assistant, so they will run in parallel in different threads and come back with their results to the CEO" — [Agency Swarm Docs - Communication Flows](https://agency-swarm.ai/core-framework/agencies/communication-flows)
- "Communication flows are defined using tuples in the communication_flows parameter: (sender, receiver) defines a directional communication path" — [Agency Swarm Docs - Communication Flows](https://agency-swarm.ai/core-framework/agencies/communication-flows)
- "Concurrent orchestration enables multiple agents to work on the same task in parallel. Each agent processes the input independently, and their results are collected and aggregated" — [SK Concurrent Orchestration Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent)
- "Semantic Kernel is now Microsoft Agent Framework! Microsoft Agent Framework (MAF) is the enterprise‑ready successor to Semantic Kernel" — [Semantic Kernel GitHub README](https://github.com/microsoft/semantic-kernel)
- "Agent Orchestration features in the Agent Framework are in the experimental stage" — [SK Orchestration Docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)

---

## Source quality flags

- Source 3 (SuperAGI agent_prompt_builder.py): source code file, high quality for understanding architecture but shows framework is single-agent focused
- Source 1 (SuperAGI README): marketing language — "dev-first", "build, manage & run useful autonomous agents" — but backed by code
- Source 2 (SuperAGI config_template.yaml): primary source showing config capabilities
- Sources 5-10 (Agency Swarm docs): official documentation, well-maintained, comprehensive
- Sources 12-16 (SK Microsoft Learn): official Microsoft documentation, high quality
- Source 11 (SK GitHub): official Microsoft repo, highly active

---

## Confidence: High

All findings are based on direct examination of official GitHub repositories, official documentation sites, source code files, and configuration files. No marketing or third-party summaries were relied upon.

---

## Gaps and open questions

1. **SuperAGI's current maintenance status**: The README says "Under Development!" and the last release tag appears to be v0.0.11, but the commit history shows recent activity. Confirming the exact current maintenance pace would require deeper investigation.
2. **Agency Swarm's 3rd layer**: Whether nesting `Agency` instances or using custom code could achieve a 3-layer dispatch→orchestrator→subagent hierarchy is not documented. This would need experimental verification.
3. **Semantic Kernel's successor relationship**: Microsoft Agent Framework (MAF) is now the recommended path. It's unclear how long Semantic Kernel will receive updates. MAF may address some gaps listed here.
4. **None of the three frameworks support**: LSP integration, shell access with directory permissions, chat forking/model switching, or explicit conflict prevention. These would need custom implementation regardless of framework choice.
5. **Config-driven orchestration**: None of the three frameworks support defining orchestrator types via config files (not code). This appears to be a gap unique to the current landscape of agent frameworks.

---

## Tool calls made

1. `webfetch` — https://github.com/TransformerOptimus/SuperAGI (GitHub README)
2. `webfetch` — https://github.com/VRSEN/agency-swarm (GitHub README)
3. `webfetch` — https://github.com/microsoft/semantic-kernel (GitHub README)
4. `webfetch` — https://superagi.com/docs/ (failed — transport error)
5. `webfetch` — https://agency-swarm.ai/core-framework/agencies/overview
6. `webfetch` — https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/
7. `webfetch` — https://agency-swarm.ai/core-framework/agencies/communication-flows
8. `webfetch` — https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/
9. `webfetch` — https://superagi.com/docs/architecture/ (failed — transport error)
10. `webfetch` — https://github.com/TransformerOptimus/SuperAGI/blob/main/README.MD
11. `webfetch` — https://agency-swarm.ai/additional-features/observability
12. `webfetch` — https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent
13. `webfetch` — https://raw.githubusercontent.com/TransformerOptimus/SuperAGI/main/config_template.yaml
14. `webfetch` — https://agency-swarm.ai/core-framework/agents/overview
15. `webfetch` — https://agency-swarm.ai/core-framework/agencies/running-agency
16. `webfetch` — https://github.com/TransformerOptimus/SuperAGI/blob/main/superagi/agent/agent_prompt_builder.py
17. `webfetch` — https://learn.microsoft.com/en-us/semantic-kernel/concepts/kernel
18. `webfetch` — https://agency-swarm.ai/additional-features/fastapi-integration
19. `webfetch` — https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/
20. `webfetch` — https://raw.githubusercontent.com/microsoft/semantic-kernel/main/FEATURE_MATRIX.md
21. `webfetch` — https://github.com/VRSEN/agency-swarm/blob/main/AGENTS.md
22. `webfetch` — https://github.com/TransformerOptimus/SuperAGI/tree/main/superagi/agent
23. `webfetch` — https://learn.microsoft.com/en-us/semantic-kernel/concepts/prompt-engineering/ (failed — 404)
