# Open-Source AI Agent Harness Comparison

This report evaluates 20+ open-source AI agent frameworks against the Dispatch requirements. Frameworks are rated on a 15-point checklist covering architecture, configuration, tooling, integration, and session management. Each requirement scores 1 (fully supported), 0.5 (partial), or 0 (not supported), for a maximum of 15.

Frameworks that are archived, in maintenance mode, or clearly unsuitable (GPT-Engineer, Mentat, Sweep, Bolt.diy, SuperAGI, Semantic Kernel) are excluded from the main comparison but noted in the appendix.

---

## The Critical Gap: No Framework Has a Three-Layer Hierarchy

The single most distinctive Dispatch requirement -- a three-layer **dispatch -> orchestrator -> subagent** architecture -- does not exist natively in any open-source framework evaluated. Every framework is either:

- **Single-agent** (Aider, Crush, Plandex, Pi)
- **Two-layer** (Claude Code, Goose, Cline, Agency Swarm, CrewAI)
- **Flat pool** (AutoGen, MetaGPT, CAMEL)
- **DAG-based** (LangGraph, ChatDev 2.0) -- the closest to true hierarchy via subgraph nesting

This means **any choice involves building the hierarchical orchestration layer yourself**. The question becomes: which framework gives you the best foundation to build on?

---

## Top Contenders

### Tier 1: Highest Feature Alignment (87% match)

#### Goose (Block / AAIF) -- 13/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | Partial | Main agent -> subagents (2 layers). Cannot nest further. |
| 2. Config-driven orchestrators | **Full** | YAML recipes define subagent behavior, extensions, parameters |
| 3. Parallel subagent execution | **Full** | Native parallel subagent support via trigger keywords |
| 4. Strict hierarchy communication | **Full** | Subagents cannot spawn further subagents or manage extensions |
| 5. User-to-agent messaging | **Full** | Continuous sessions, real-time subagent visibility |
| 6. Conflict prevention | Partial | Process isolation; no explicit file-scope assignment |
| 7. Role-scoped tooling | **Full** | Per-subagent extension sets via recipes |
| 8. Skills system | **Full** | `~/.agents/skills/` and `.agents/skills/` with SKILL.md |
| 9. LSP integration | **None** | No LSP support |
| 10. Shell + directory perms | **Full** | Permission modes (auto/approve/smart_approve), allowlists |
| 11. Session management | **Full** | Start, resume, search, model switching |
| 12. HITL checkpoints | **Full** | Permission modes, per-action approval |
| 13. State persistence | **Full** | Session persistence across restarts |
| 14. Provider-agnostic LLM | **Full** | 15+ providers |
| 15. Multiple interfaces | **Full** | Desktop app, CLI, API (ACP server) |

**Language**: Rust + TypeScript. **Stars**: 45.5k. **Status**: Very active, moved to Linux Foundation AAIF (Apr 2026). Apache 2.0 license.

**Strengths**: Closest to Dispatch's architecture out of the box. Config-driven recipes, parallel subagents, strict hierarchy enforcement, skills system, permission model, and multi-interface support all map directly to requirements. The MCP extension ecosystem (70+ extensions) provides broad tool coverage.

**Weaknesses**: Only 2 layers of hierarchy (no recursive nesting). No LSP. Written in Rust, which makes deep architectural modification harder than Python/TypeScript. Subagents cannot spawn sub-subagents.

**Extensibility verdict**: Adding a third layer would mean building an orchestrator abstraction that manages multiple Goose agent instances, each of which manages its own subagents. The recipe system could potentially be extended to define orchestrator types.

---

#### Cline -- 13/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | Partial | Coordinator -> specialist agents (2 layers via SDK) |
| 2. Config-driven orchestrators | Partial | Code-driven SDK; CLI flags provide some config |
| 3. Parallel subagent execution | **Full** | Kanban enables parallel agents with separate worktrees |
| 4. Strict hierarchy communication | Partial | Coordinator pattern implies parent-mediated, not enforced |
| 5. User-to-agent messaging | **Full** | Interactive CLI, `ask_question` tool |
| 6. Conflict prevention | Partial | Kanban uses Git worktrees for isolation |
| 7. Role-scoped tooling | **Full** | Per-agent tool sets via plugin system |
| 8. Skills system | **Full** | `.agents/skills/` with SKILL.md files |
| 9. LSP integration | **Full** | VS Code extension integrates with editor LSP |
| 10. Shell + directory perms | **Full** | Command permission allow/deny lists |
| 11. Session management | **Full** | History, persistence, model override per run |
| 12. HITL checkpoints | **Full** | Plan/Act modes, per-action approval, auto-approve toggle |
| 13. State persistence | **Full** | Sessions persist across restarts, snapshot/restore |
| 14. Provider-agnostic LLM | **Full** | 200+ models via OpenRouter, plus direct providers |
| 15. Multiple interfaces | **Full** | CLI, VS Code, JetBrains, Kanban web, SDK |

**Language**: TypeScript. **Stars**: 62k. **Status**: Very active (v3.0.7, May 2026). Apache 2.0 license.

**Strengths**: The only framework with real LSP integration (through VS Code). Broadest interface coverage (IDE extensions, CLI, web Kanban, SDK). Git worktree isolation in Kanban is a creative approach to conflict prevention. The SDK (`@cline/core`, `@cline/agents`, `@cline/llms`) is well-layered and embeddable.

**Weaknesses**: Orchestration is code-driven, not config-driven -- no YAML orchestrator definitions. LSP integration is tied to the VS Code extension host; unclear if it works outside IDE context. Hierarchy enforcement is not strict. TypeScript-only.

**Extensibility verdict**: The layered SDK architecture is a strong foundation. You could build the dispatch and orchestrator layers on top of `@cline/core` and `@cline/agents`. The plugin system (`AgentPlugin`) provides lifecycle hooks. However, adding config-driven orchestrator definitions would require custom work.

---

#### Claude Code (Anthropic) -- 13/15 (NOT fully open source)

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | Partial | Main agent -> subagents (2 layers). Agent teams add peer coordination |
| 2. Config-driven orchestrators | Partial | Subagents defined via YAML frontmatter in .md files |
| 3. Parallel subagent execution | **Full** | Multiple concurrent subagents + agent teams |
| 4. Strict hierarchy communication | **Full** | Subagents report to parent only |
| 5. User-to-agent messaging | **Full** | Shift+Down for in-process subagent messaging |
| 6. Conflict prevention | Partial | Git worktrees, file locking in agent teams |
| 7. Role-scoped tooling | **Full** | `tools` and `disallowedTools` in subagent YAML frontmatter |
| 8. Skills system | **Full** | Full Agent Skills standard, YAML frontmatter, multi-scope |
| 9. LSP integration | **Full** | Through IDE integrations (VS Code, JetBrains) |
| 10. Shell + directory perms | **Full** | allow/ask/deny rules, wildcard matching, sandboxing |
| 11. Session management | **Full** | Resume, fork (`/fork`), model switch (`/model`), persistence |
| 12. HITL checkpoints | **Full** | Permission modes, plan mode, hooks for custom approval |
| 13. State persistence | **Full** | Full session persistence in `~/.claude/projects/` |
| 14. Provider-agnostic LLM | Partial | Primarily Claude; Bedrock/Vertex/Azure as backends |
| 15. Multiple interfaces | **Full** | CLI, VS Code, JetBrains, Desktop, Web, Slack, SDKs |

**Language**: Proprietary core (distributed as npm binary); Shell/Python/TypeScript for installer, plugins, examples. **Stars**: 125k. **Status**: Very active. **License**: Partially open source -- core engine is proprietary.

**Strengths**: Highest overall feature coverage. Best permission system. Best skills system. Chat forking built-in. Agent SDK available in Python and TypeScript. Hooks system (PreToolUse, PostToolUse, SubagentStart/Stop) provides excellent lifecycle control.

**Weaknesses**: **Core engine is proprietary.** You cannot fork or modify the agent loop. Primarily Claude-only for models. Building on top means depending on Anthropic's closed binary. This is a dealbreaker if full ownership of the codebase is required.

**Extensibility verdict**: If you're comfortable depending on a proprietary core, Claude Code's Agent SDK is probably the fastest path to a Dispatch-like system. But you'd be building on a dependency you cannot modify or audit internally.

---

### Tier 2: Strong Architectural Foundation (53-60% match)

#### LangGraph -- 9/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | **Full** | Arbitrary subgraph nesting with private state schemas |
| 2. Config-driven orchestrators | **None** | Purely code-defined (Python) |
| 3. Parallel subagent execution | **Full** | Parallel edges, `Send()` for map-reduce fan-out |
| 4. Strict hierarchy communication | **Full** | Subgraph state isolation via separate schemas |
| 5. User-to-agent messaging | **Full** | `interrupt()` / `Command(resume=...)` anywhere |
| 6. Conflict prevention | **None** | No file-scope mechanisms |
| 7. Role-scoped tooling | **Full** | Per-node tool sets |
| 8. Skills system | **None** | No skills/instruction injection system |
| 9. LSP integration | **None** | No LSP |
| 10. Shell + directory perms | **None** | No built-in shell or permissions |
| 11. Session management | Partial | Checkpointer history, time travel, `update_state()` |
| 12. HITL checkpoints | **Full** | `interrupt()`, static breakpoints, approval patterns |
| 13. State persistence | **Full** | Multiple checkpointers (SQLite, Postgres, CosmosDB) |
| 14. Provider-agnostic LLM | **Full** | All LangChain providers + standalone |
| 15. Multiple interfaces | Partial | Python API, LangSmith Studio, LangGraph API |

**Language**: Python. **Stars**: 32.4k. **Status**: Very active (v1.2.0, May 2026).

**Key insight**: LangGraph is the **only framework that natively supports arbitrary hierarchy depth** via subgraph nesting. This is the single most important Dispatch requirement. The trade-off: it has zero application-layer features (no skills, no shell, no LSP, no session management in the user-facing sense). It's a low-level orchestration runtime, not an end-user tool.

**Extensibility verdict**: LangGraph provides the best orchestration primitives but you'd need to build everything else on top -- the CLI, the skills system, the shell with permissions, the LSP integration, session management UI. It's essentially a graph execution engine, not an agent harness.

---

#### CrewAI -- 9/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | Partial | Manager -> agents (2 layers); Flows chain crews |
| 2. Config-driven orchestrators | **Full** | YAML `agents.yaml`, `tasks.yaml` |
| 3. Parallel subagent execution | **Full** | `async_execution=True` on tasks |
| 4. Strict hierarchy communication | Partial | Manager delegates but `allow_delegation` enables P2P |
| 5. User-to-agent messaging | Partial | `@human_feedback` at configured points only |
| 6. Conflict prevention | **None** | No file-scope mechanisms |
| 7. Role-scoped tooling | **Full** | Per-agent tools, task tool overrides |
| 8. Skills system | Partial | Agent templates, prompt customization |
| 9. LSP integration | **None** | No LSP |
| 10. Shell + directory perms | **None** | Code execution deprecated |
| 11. Session management | Partial | Flow persist/fork via `@persist` |
| 12. HITL checkpoints | **Full** | `@human_feedback`, `human_input=True` |
| 13. State persistence | **Full** | `@persist` with SQLite |
| 14. Provider-agnostic LLM | **Full** | Many providers via LiteLLM |
| 15. Multiple interfaces | Partial | CLI + Python API |

**Language**: Python. **Stars**: 51.7k. **Status**: Very active, backed by CrewAI Inc.

**Extensibility verdict**: Best config-driven agent/task definitions. The YAML approach maps well to Dispatch's config-driven orchestrators. However, no shell access, no LSP, no skills directory system. Better suited for general automation than coding-specific workflows.

---

#### ChatDev 2.0 -- 9/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | Partial | DAG + subgraph nesting, not strict tree |
| 2. Config-driven orchestrators | **Full** | Full YAML workflow definitions |
| 3. Parallel subagent execution | **Full** | Map/Tree modes with `max_parallel` |
| 4. Strict hierarchy communication | Partial | Edge-routed but no parent-only enforcement |
| 5. User-to-agent messaging | Partial | Human nodes in DAG at predefined points |
| 6. Conflict prevention | **None** | No file-scope mechanisms |
| 7. Role-scoped tooling | **Full** | Per-node tooling in YAML |
| 8. Skills system | Partial | `.agents/skills` directory exists |
| 9. LSP integration | **None** | No LSP |
| 10. Shell + directory perms | **None** | No permission system |
| 11. Session management | Partial | Context snapshots, no forking/resume |
| 12. HITL checkpoints | **Full** | Human nodes + edge conditions |
| 13. State persistence | Partial | Artifacts persist, no execution recovery |
| 14. Provider-agnostic LLM | **Full** | Per-node provider config |
| 15. Multiple interfaces | **Full** | Web UI, CLI, HTTP API, Python SDK |

**Language**: Python + Vue.js. **Stars**: 33.1k. **Status**: Active (v2.2.0, Mar 2026). Very new (released Jan 2026).

**Extensibility verdict**: Best zero-code workflow definition system. YAML DAGs with subgraphs, parallel execution, and multiple interfaces. The main risk is maturity -- ChatDev 2.0 is only months old and documentation is still evolving.

---

#### OpenHands -- 8.5/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | **None** | Single Conversation -> Agent -> Tools pipeline |
| 2. Config-driven orchestrators | Partial | SDK is code-driven, config template exists |
| 3. Parallel subagent execution | **None** | One agent step at a time per conversation |
| 4. Strict hierarchy communication | **None** | No hierarchy enforced |
| 5. User-to-agent messaging | **Full** | `send_message()` at any time via WebSocket |
| 6. Conflict prevention | **None** | No scope assignment |
| 7. Role-scoped tooling | **Full** | Per-agent tool sets via typed Action/Observation |
| 8. Skills system | **Full** | Three skill types, YAML frontmatter, MCP integration |
| 9. LSP integration | **None** | No LSP |
| 10. Shell + directory perms | Partial | Risk-based security (LOW/MEDIUM/HIGH), not directory-based |
| 11. Session management | Partial | Persistence + resume, no forking or model switching |
| 12. HITL checkpoints | **Full** | ConfirmationPolicy with configurable thresholds |
| 13. State persistence | **Full** | Auto-save, resume, incremental events |
| 14. Provider-agnostic LLM | **Full** | 100+ providers via LiteLLM |
| 15. Multiple interfaces | **Full** | CLI, React GUI, Cloud, Enterprise, SDK, REST API |

**Language**: Python + TypeScript. **Stars**: 74.1k. **Status**: Very active (v1.7.0, May 2026). MIT license.

**Extensibility verdict**: The four-package SDK architecture (`openhands.sdk`, `openhands.tools`, `openhands.workspace`, `openhands.agent_server`) is clean and composable. The event-driven design provides good extension points. However, no native multi-agent hierarchy -- you'd build the orchestration layer from scratch using the SDK primitives. Best choice if you want a battle-tested single-agent SDK with excellent security and skills, and are willing to build hierarchy on top.

---

#### Crush (OpenCode successor) -- 8/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | **None** | Single-agent with `agent` tool for sub-tasks |
| 2. Config-driven orchestrators | **None** | No orchestrator concept |
| 3. Parallel subagent execution | **None** | Sub-agent tool is sequential |
| 4. Strict hierarchy communication | Partial | Agent tool returns results; no P2P |
| 5. User-to-agent messaging | **None** | User types at main session only |
| 6. Conflict prevention | **None** | No scope assignment |
| 7. Role-scoped tooling | **Full** | Different agents can have different tool sets via config |
| 8. Skills system | **Full** | Agent Skills standard, reads `.crush/`, `.claude/`, `.agents/` |
| 9. LSP integration | **Full** | Built-in LSP with configurable language servers |
| 10. Shell + directory perms | Partial | `allowed_tools` allowlist, no directory scoping |
| 11. Session management | **Full** | Save/load/switch, model switching, SQLite persistence |
| 12. HITL checkpoints | **None** | No checkpoint system |
| 13. State persistence | **Full** | SQLite-based session persistence |
| 14. Provider-agnostic LLM | **Full** | 15+ providers |
| 15. Multiple interfaces | **Full** | Interactive TUI, CLI, scripting |

**Language**: Go. **Stars**: 24.4k. **Status**: Very active (v0.70.0, May 2026). MIT license.

**Key insight**: The only CLI-native framework with built-in LSP integration for compiler diagnostics. If LSP is a hard requirement, Crush is one of only two options (the other being Cline's VS Code extension). However, it has no multi-agent architecture at all.

---

#### Pi.dev -- 6.5/15

| Requirement | Rating | Notes |
|---|---|---|
| 1. Three-layer hierarchy | **None** | Single-agent. Subagent extension is a bash demo. |
| 2. Config-driven orchestrators | **None** | No orchestrator concept |
| 3. Parallel subagent execution | **None** | Subagent extension demo: 8 tasks, 4 concurrent, via bash |
| 4. Strict hierarchy communication | **None** | No agent communication framework |
| 5. User-to-agent messaging | **Full** | Built-in steer/follow-up message queuing |
| 6. Conflict prevention | **None** | "YOLO mode" by design |
| 7. Role-scoped tooling | Partial | `--tools` flag restricts globally, no role system |
| 8. Skills system | Partial | Agent Skills standard, but no `default/agents/project/` dirs |
| 9. LSP integration | **None** | No LSP |
| 10. Shell + directory perms | **None** | Full unrestricted access by design |
| 11. Session management | **Full** | Tree-structured, fork, clone, resume, model switch |
| 12. HITL checkpoints | Partial | `tool_call` event can block; no built-in checkpoint system |
| 13. State persistence | **Full** | JSONL auto-save, sessions survive restarts |
| 14. Provider-agnostic LLM | **Full** | 15+ providers, cross-provider context handoff |
| 15. Multiple interfaces | **Full** | TUI, CLI, JSON, RPC, SDK, web UI package |

**Language**: TypeScript. **Stars**: 51.4k. **Status**: Very active (v0.75.3, May 2026). MIT license.

**Key insight**: Pi has the best session management (tree-structured branching with fork/clone/resume) and the most powerful extension system (30+ lifecycle events, full tool registration, UI components). The `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` packages are clean, well-documented TypeScript libraries. However, the maintainer explicitly rejects multi-agent patterns ("sub-agents are an anti-pattern"). Building Dispatch on Pi means fighting its philosophy.

**Best use**: Harvest `pi-ai` (LLM abstraction) and `pi-agent-core` (agent runtime) as libraries in a custom system, rather than extending the Pi CLI.

---

### Eliminated Frameworks

| Framework | Score | Reason for Elimination |
|---|---|---|
| AutoGen (AG2) | 8.5/15 | **Maintenance mode.** Microsoft recommends migrating to Agent Framework. No new features. |
| Agency Swarm | 8/15 | 2-layer only, code-defined, no LSP/shell/sessions. Active but smaller community (4.4k stars). |
| CAMEL | 6.5/15 | Research-oriented. Sequential workforce. No production features (sessions, perms). |
| Plandex | 6/15 | Single-agent. Strong for plan-then-execute but no hierarchy or multi-agent. |
| MetaGPT | 5/15 | Flat role pool, sequential, broadcast communication. Team pivoting to commercial MGX. |
| Aider | 5/15 | Single-agent pair programmer. No hierarchy, no subagents, no persistence. |
| Semantic Kernel | 4.5/15 | SDK-only, no interfaces, experimental orchestration. Being superseded by MS Agent Framework. |
| SuperAGI | 5.5/15 | Stale (v0.0.11). Single-agent. No hierarchy. |
| SWE-agent | 5/15 | Maintenance mode, superseded by mini-SWE-agent. Academic benchmarking tool. |
| GPT-Engineer | N/A | Archived April 2026. |
| Mentat | N/A | Archived January 2025. |
| Sweep | N/A | Pivoted to JetBrains plugin. |
| Bolt.diy | N/A | Web app builder, not an agent harness. |
| Continue | N/A | Pivoted to CI/CD checks product. |

---

## Summary: Ratings at a Glance

| Rank | Framework | Score | % | Language | Stars | Key Strength | Key Gap |
|---|---|---|---|---|---|---|---|
| 1 | **Goose** | 13/15 | 87% | Rust/TS | 45.5k | Closest architecture match (recipes, subagents, permissions) | No LSP, no 3rd layer |
| 1 | **Cline** | 13/15 | 87% | TypeScript | 62k | Only framework with LSP + parallel agents + SDK | Config-driven orchestration is weak |
| 1 | **Claude Code** | 13/15 | 87% | Proprietary | 125k | Most complete feature set, best permissions/skills | **Not fully open source** |
| 4 | **LangGraph** | 9/15 | 60% | Python | 32.4k | Only native arbitrary-depth hierarchy | Zero application features (no shell, skills, UI) |
| 4 | **CrewAI** | 9/15 | 60% | Python | 51.7k | Best config-driven agents (YAML) | No shell, no LSP, no skills dirs |
| 4 | **ChatDev 2.0** | 9/15 | 60% | Python/Vue | 33.1k | Best zero-code YAML workflows | Very new (Jan 2026), immature |
| 7 | **OpenHands** | 8.5/15 | 57% | Python/TS | 74.1k | Best SDK architecture, 100+ LLM providers | No hierarchy, no parallel agents |
| 8 | **Crush** | 8/15 | 53% | Go | 24.4k | Only CLI with built-in LSP | No multi-agent anything |
| 9 | **Pi.dev** | 6.5/15 | 43% | TypeScript | 51.4k | Best session management + extension system | Anti-multi-agent philosophy |

---

## Recommendation: Build vs. Extend

No existing framework is a drop-in match. The choice depends on which gaps you're most willing to fill:

### Option A: Extend Goose
**Best if**: You want the most features out of the box and are comfortable with Rust/TypeScript.
- **Already have**: Subagents, parallel execution, config recipes, skills, permissions, session management, multi-interface
- **Must build**: Third orchestrator layer, LSP integration, custom directory permissions, skills directory restructuring
- **Risk**: Rust codebase makes deep architectural changes harder. Goose's subagent model may resist being generalized into a full orchestrator pattern.

### Option B: Build on Cline SDK
**Best if**: You want LSP and a well-layered TypeScript SDK.
- **Already have**: LSP, parallel agents (Kanban), skills, permissions, sessions, plugins, IDE integration
- **Must build**: Config-driven orchestrator definitions, third dispatch layer, strict hierarchy enforcement
- **Risk**: Cline is IDE-first; extracting the SDK for standalone use may have rough edges.

### Option C: Build on LangGraph
**Best if**: You prioritize getting the hierarchy right and are comfortable building everything else.
- **Already have**: Arbitrary hierarchy depth, parallel execution, interrupts, state persistence, provider support
- **Must build**: Skills system, shell + permissions, LSP, session management UI, CLI/TUI, config-driven orchestrator definitions
- **Risk**: Enormous amount of application-layer work. LangGraph is an execution engine, not an end-user tool.

### Option D: Build from Scratch, Harvest Libraries
**Best if**: You want full architectural control and no framework fights.
- **Harvest from Pi.dev**: `@earendil-works/pi-ai` (LLM abstraction), `@earendil-works/pi-agent-core` (agent runtime)
- **Harvest from Cline**: `@cline/llms` (provider gateway), `@cline/agents` (stateless agent loop)
- **Harvest from Crush**: LSP integration patterns (Go)
- **Must build**: Everything else -- dispatch layer, orchestrator management, hierarchy enforcement, skills system, permissions, session management
- **Risk**: Highest initial effort, but cleanest architecture alignment.

---

## Sources

- [Goose GitHub](https://github.com/aaif-goose/goose) -- Architecture, subagents, skills, security docs
- [Goose Documentation](https://goose-docs.ai/) -- Subagents, recipes, config, sessions, security guides
- [Cline GitHub](https://github.com/cline/cline) -- SDK, multi-agent, Kanban, plugins
- [Cline Documentation](https://docs.cline.bot/) -- SDK architecture, tools, CLI, building agents
- [Claude Code GitHub](https://github.com/anthropics/claude-code) -- Installer, plugins, examples
- [Claude Code Documentation](https://code.claude.com/docs/en/overview) -- Subagents, skills, permissions, hooks, agent teams, SDK
- [LangGraph GitHub](https://github.com/langchain-ai/langgraph) -- Graph API, subgraphs, interrupts, persistence
- [LangGraph Documentation](https://docs.langchain.com/oss/python/langgraph/) -- Overview, subgraphs, interrupts, persistence
- [CrewAI GitHub](https://github.com/crewAIInc/crewAI) -- YAML config, agents, tasks, flows
- [CrewAI Documentation](https://docs.crewai.com/) -- Agents, tasks, flows, processes, memory
- [ChatDev GitHub](https://github.com/OpenBMB/ChatDev) -- Workflow authoring guide, YAML definitions
- [OpenHands GitHub](https://github.com/OpenHands/OpenHands) -- SDK overview
- [OpenHands SDK Docs](https://docs.openhands.dev/sdk) -- Architecture, agent, conversation, LLM, skills, security
- [Crush GitHub](https://github.com/charmbracelet/crush) -- LSP, sessions, skills, providers
- [Pi.dev GitHub](https://github.com/earendil-works/pi) -- Extensions, skills, SDK, sessions
- [Pi.dev Extensions Docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) -- Event lifecycle, tool registration
- [Pi.dev Blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) -- Design philosophy
- [Agency Swarm GitHub](https://github.com/VRSEN/agency-swarm) -- Communication flows, agents
- [Agency Swarm Docs](https://agency-swarm.ai/) -- Agencies, agents, running
- [AutoGen GitHub](https://github.com/microsoft/autogen) -- Maintenance mode notice, teams, HITL
- [CAMEL GitHub](https://github.com/camel-ai/camel) -- Workforce, toolkits, model factory
- [MetaGPT GitHub](https://github.com/geekan/MetaGPT) -- Roles, teams, serialization
- [Plandex GitHub](https://github.com/plandex-ai/plandex) -- Plan-execute workflow, diff sandbox
- [Aider GitHub](https://github.com/Aider-AI/aider) -- Conventions, modes, LLM support
- [SWE-agent GitHub](https://github.com/SWE-agent/SWE-agent) -- Architecture, tools, batch mode
