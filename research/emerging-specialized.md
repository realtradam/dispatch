# Subagent Report: Emerging & Specialized AI Agent Harnesses

## Research summary

This report evaluates **OpenCode** (now **Crush**), **Plandex**, **GPT-Engineer**, **Claude Code**, and several other notable open-source AI coding agents against a 15-point requirements checklist for a multi-layered agent orchestration harness. Of all frameworks evaluated, **Claude Code** comes closest to the full requirements but is not fully open source and lacks a native three-layer dispatch->orchestrator->subagent hierarchy. **Plandex** is strong for large-scale plan-then-execute workflows but is single-agent. **Crush** (OpenCode's successor) is a well-architected terminal agent with LSP/MCP/skills but lacks hierarchy. **GPT-Engineer** is archived and unsuitable. **Bolt.diy** is a web app builder, not an agent harness. **Sweep** has pivoted to a JetBrains plugin.

---

## Findings

### 1. OpenCode (archived) → Crush (successor)

**GitHub**: [opencode-ai/opencode](https://github.com/opencode-ai/opencode) (archived Sep 18, 2025) → [charmbracelet/crush](https://github.com/charmbracelet/crush) (24.4k stars, active)

**Language**: Go

**Architecture**: OpenCode was a Go-based CLI/TUI coding agent built with Charm's Bubble Tea framework. It was archived in September 2025 and the project continued as **Crush** by the Charm team. Crush is actively maintained (v0.70.0, May 18, 2026) with 3,380+ commits.

Crush's architecture is a **single-agent loop** with tool-calling capabilities. It supports spawning sub-tasks via the `agent` tool but does not have a built-in multi-layer hierarchy. It provides:

- Interactive TUI + CLI + non-interactive prompt mode
- Multi-provider LLM support (Anthropic, OpenAI, Google, Groq, OpenRouter, AWS Bedrock, Azure, local models)
- LSP integration with configurable language server support
- MCP protocol support (stdio, http, sse)
- Skills via the Agent Skills open standard
- Session management (save/load/switch sessions, SQLite-backed)
- Plugin system through MCP and skills
- Hooks (preliminary support)
- Configurable permissions (`allowed_tools`, tool allow/deny)
- Desktop notifications
- Provider auto-updates from Catwalk database

**Notable features for Dispatch comparison**: Crush reads `.claude/skills/` and `.cursor/skills/` directories for compatibility with Claude Code skills. It supports `.crushignore` files. It has `initialize_as` option to create AGENTS.md/CRUSH.md context files.

**Confidence**: High — well-documented, active project, extensive README.

---

### 2. Plandex

**GitHub**: [plandex-ai/plandex](https://github.com/plandex-ai/plandex) (15.4k stars, active, 1,483 commits)

**Language**: Go (93.4%)

**Architecture**: Plandex is a terminal-based AI development tool with a **plan-and-execute** workflow. It is a single-agent system with a cumulative diff review sandbox. Its architecture is:

- **Plan branch**: AI proposes changes in a sandbox, kept separate from project files
- **Apply phase**: User reviews and applies the cumulative diff
- **Autonomous loop**: Can auto-execute commands, detect failures, debug, and retry

Plandex handles up to 2M tokens of effective context via selective loading. It uses tree-sitter for project map generation (30+ languages). It has built-in version control for plans (branches, diffs). It integrates with git for commit message generation.

**Key details**:
- CLI + REPL with fuzzy auto-complete
- Multi-provider: Anthropic, OpenAI, Google, OpenRouter, open source models
- Context caching for all major providers
- Configurable autonomy levels (full auto → step-by-step review)
- Automated debugging of terminal commands and browser apps
- Cloud hosted mode is winding down; self-hosted/local Docker mode is primary
- No API mode, no TUI (terminal REPL only)

**Confidence**: High — well-documented, active community, recent releases.

---

### 3. GPT-Engineer

**GitHub**: [AntonOsika/gpt-engineer](https://github.com/AntonOsika/gpt-engineer) (55.2k stars, **archived** Apr 22, 2026)

**Language**: Python (98.8%)

**Architecture**: GPT-Engineer was a CLI platform for code generation experimentation. It used a simple single-agent prompt→generate loop. The project was archived in April 2026 and the last release was v0.3.1 (June 6, 2024). The README explicitly directs users to "aider" for a well-maintained CLI or "lovable.dev" for the commercial evolution.

**Capabilities**:
- Single-agent, one-shot code generation from natural language prompts
- Support for OpenAI, Anthropic, and open source models
- Benchmark support (APPS, MBPP)
- Pre-prompt overrides for agent identity
- Vision support via image inputs
- Docker support

**Confidence**: High — project is archived, low relevance for a new harness build.

---

### 4. Claude Code (Anthropic)

**GitHub**: [anthropics/claude-code](https://github.com/anthropics/claude-code) (125k stars, very active, 627 commits)

**Language**: Shell 47.1%, Python 29.2%, TypeScript 17.7% (Note: this repo contains the installer, plugins, examples, and documentation; the **core agent engine is proprietary** and not fully open source.)

**Architecture**: Claude Code is a sophisticated agentic coding tool with a layered architecture:

1. **Main session**: The primary agent loop that the user interacts with
2. **Subagents**: Specialized agents spawned from the main session, each with:
   - Its own context window
   - Custom system prompts via YAML frontmatter in Markdown files
   - Restricted/permissions-scoped tool sets
   - Configurable models (sonnet/opus/haiku or full model IDs)
   - Independent permission modes (default, acceptEdits, auto, dontAsk, bypassPermissions, plan)
   - Persistent memory (user/project/local scope)
   - Preloaded skills
   - Optional git worktree isolation
3. **Agent teams** (experimental, behind feature flag): Multiple full Claude Code sessions that coordinate via a shared task list, with peer-to-peer messaging via mailbox system

**Surface area**: Terminal CLI, VS Code extension, JetBrains plugin, Desktop app, Web (claude.ai/code), Slack integration, GitHub Actions, GitLab CI/CD, iOS app

**Key subsystems**:
- **Skills system**: Full Agent Skills open standard support, directory-based (`.claude/skills/`), personal/project/plugin/managed scopes, YAML frontmatter with description/tools/context/agent fields, dynamic context injection via `` !`command` ``, argument substitution
- **Memory system**: CLAUDE.md files (project/user/managed/org scopes), `.claude/rules/` for path-scoped instructions, auto memory (Claude writes learnings across sessions)
- **Hooks**: PreToolUse, PostToolUse, SubagentStart/Stop, TeammateIdle, TaskCreated, TaskCompleted — shell commands at lifecycle events
- **Permissions**: Tiered system (allow/ask/deny rules), wildcard matching, Bash/Read/Edit/WebFetch/MCP scoping, sandboxing (OS-level isolation), auto mode (ML classifier)
- **MCP**: Model Context Protocol for external tool integration
- **Agent SDK**: Python and TypeScript SDKs for building custom agents with Claude Code's tools and agent loop

**Provider support**: Primarily uses Claude models but supports Amazon Bedrock, Google Vertex AI, Microsoft Azure AI Foundry as third-party backends.

---

### 5. Bolt.new / Bolt.diy

**GitHub**: [stackblitz/bolt.new](https://github.com/stackblitz/bolt.new) (16.4k stars) / [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy) (19.4k stars)

**Language**: TypeScript

**Architecture**: Bolt.new is a web-based AI-powered full-stack application generator using StackBlitz's WebContainers. bolt.diy is the community fork that supports any LLM. Both are **web application builders**, not agent harnesses or orchestrators.

- Single-agent prompt→generate→preview loop
- No agent hierarchy
- No orchestrator or subagent concepts
- Primarily browser-based (with Electron desktop app)
- Supports 19+ LLM providers in bolt.diy
- File locking system to prevent conflicts
- Git integration for clone/import/deploy
- MCP support
- Diff view for AI changes

**Confidence**: High — well-documented, but not applicable as an agent harness.

---

### 6. Sweep

**GitHub**: [sweepai/sweep](https://github.com/sweepai/sweep) (7.7k stars)

**Language**: Python, Jupyter Notebook, TypeScript

**Note**: Sweep was originally a GitHub app for automated PR creation from issues. It has since pivoted to an AI coding assistant for JetBrains IDEs. The open source repo is largely dormant. Not applicable as a general agent harness.

---

### 7. Other Notable Frameworks Not Found

**Kortix Suna**: Could not locate an active GitHub repository under sunaify/suna or similar names.

**Devon (entelligence-ai/devon)**: Could not locate — the GitHub org/user was not found (404).

---

## Requirements Checklist

### 1. Three-layer hierarchy (dispatch → orchestrator → subagent)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ❌ Not supported | Single-agent loop; has `agent` tool for sub-tasks but no orchestrator layer |
| **Plandex** | ❌ Not supported | Single-agent plan→execute loop |
| **GPT-Engineer** | ❌ Not supported | Single-agent prompt→generate |
| **Claude Code** | ⚠️ Partial | 2 layers: main agent → subagents. Agent teams (experimental) add peer coordination but not 3-tier hierarchy |
| **Bolt.diy** | ❌ Not supported | Single-agent web app builder |
| **Sweep** | ❌ Not supported | Single-agent GitHub PR generator (now JetBrains plugin) |

### 2. Config-driven orchestrators

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ❌ Not supported | No orchestrator concept; config is for providers/model/agents |
| **Plandex** | ❌ Not supported | Config is limited to model providers and autonomy level |
| **GPT-Engineer** | ❌ Not supported | Pre-prompt override only |
| **Claude Code** | ⚠️ Partial | Subagents defined via YAML frontmatter in `.md` files with tools/models/prompts/permissions. No subagent template spawning from orchestrator config |
| **Bolt.diy** | ❌ Not supported | Provider config only |
| **Sweep** | ❌ Not supported | — |

### 3. Parallel subagent execution

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ❌ Not supported | Sub-agent tool is sequential |
| **Plandex** | ❌ Not supported | Single-threaded plan→execute |
| **GPT-Engineer** | ❌ Not supported | Single-threaded |
| **Claude Code** | ✅ Supported | Subagents run in parallel; multiple background agents can run concurrently. Agent teams spawn multiple independent sessions |
| **Bolt.diy** | ❌ Not supported | Single prompt→response |
| **Sweep** | ❌ Not supported | — |

### 4. Strict hierarchy communication (subagents only talk to parent)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ⚠️ Partial | Agent tool calls return results; no peer-to-peer, but also no multi-layer parent chain |
| **Plandex** | N/A | No subagents |
| **GPT-Engineer** | N/A | No subagents |
| **Claude Code** | ✅ Supported | Subagents report to parent only; no peer-to-peer for subagents. Note: Agent teams (experimental) intentionally allow peer-to-peer messaging |
| **Bolt.diy** | N/A | No subagents |
| **Sweep** | N/A | — |

### 5. User-to-agent messaging mid-execution

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ❌ Not supported | User types at the main session; cannot message a sub-agent mid-task |
| **Plandex** | ⚠️ Partial | User can interrupt and redirect during plan step, but not while AI is executing |
| **GPT-Engineer** | ❌ Not supported | Batch process |
| **Claude Code** | ✅ Supported | Users can interact with subagents directly via Shift+Down in in-process mode; can message agent team teammates directly |
| **Bolt.diy** | ❌ Not supported | Single prompt-response |
| **Sweep** | ❌ Not supported | — |

### 6. Conflict prevention (non-overlapping file scopes)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ❌ Not supported | No scope assignment |
| **Plandex** | ⚠️ Partial | Cumulative diff sandbox prevents conflicts by keeping AI changes separate until user applies them |
| **GPT-Engineer** | ❌ Not supported | — |
| **Claude Code** | ⚠️ Partial | Git worktrees for subagent isolation; file locking in agent teams. No orchestrator-driven scope assignment |
| **Bolt.diy** | ✅ Supported | File locking system prevents concurrent edits during AI code generation |
| **Sweep** | ❌ Not supported | — |

### 7. Role-scoped tooling

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | Different agents can have different tool sets via `agents` config with `tools` field |
| **Plandex** | ❌ Not supported | Single agent with all tools |
| **GPT-Engineer** | ❌ Not supported | Single agent |
| **Claude Code** | ✅ Supported | Full role-scoped tooling via `tools` and `disallowedTools` frontmatter in subagent definitions |
| **Bolt.diy** | ❌ Not supported | Single agent |
| **Sweep** | ❌ Not supported | — |

### 8. Skills system (injectable markdown instructions, directory-based)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | Supports Agent Skills open standard. Reads from `.crush/skills/`, `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, plus user-level paths |
| **Plandex** | ❌ Not supported | No skills system |
| **GPT-Engineer** | ⚠️ Partial | Has pre-prompt override files but not a structured skills system |
| **Claude Code** | ✅ Supported | Full Agent Skills open standard support, YAML frontmatter, personal/project/plugin/managed scopes, dynamic context injection, argument substitution, preloading into subagents |
| **Bolt.diy** | ❌ Not supported | No skills system |
| **Sweep** | ❌ Not supported | — |

### 9. LSP integration

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | LSP integration with multi-language support via configurable language server commands |
| **Plandex** | ⚠️ Partial | Tree-sitter for syntax validation and project maps, but no LSP diagnostics tool |
| **GPT-Engineer** | ❌ Not supported | — |
| **Claude Code** | ✅ Supported | LSP through IDE integrations (VS Code, JetBrains); diagnostics tool available to agents |
| **Bolt.diy** | ❌ Not supported | — |
| **Sweep** | ❌ Not supported | — |

### 10. Shell access with directory permissions

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ⚠️ Partial | Has `allowed_tools` permission allowlist but no directory-based permission scoping. Crush has `--yolo` flag to bypass |
| **Plandex** | ❌ Not supported | Has shell access but no permission system |
| **GPT-Engineer** | ❌ Not supported | Shell execution without permissions |
| **Claude Code** | ✅ Supported | Full permission system: allow/ask/deny rules, wildcard matching, absolute/project-relative/home-relative path patterns, sandboxing (OS-level filesystem/network isolation), auto mode with ML classifier |
| **Bolt.diy** | ❌ Not supported | — |
| **Sweep** | ❌ Not supported | — |

### 11. Session management (forking, model switching, resume)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | Session save/load/switch, model switching mid-session, session persistence via SQLite |
| **Plandex** | ✅ Supported | Plan version control with branching; model switching supported |
| **GPT-Engineer** | ❌ Not supported | No session persistence |
| **Claude Code** | ✅ Supported | Full session management: resume (`-r`, `-c`), fork (`/fork`), model switching (`/model`), chat history persistence, auto memory, `/compact` for context management |
| **Bolt.diy** | ⚠️ Partial | Chat history via file system, no forking or model switching |
| **Sweep** | ❌ Not supported | — |

### 12. Human-in-the-loop checkpoints

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ❌ Not supported | No checkpoint system; permission prompts are per-tool |
| **Plandex** | ✅ Supported | Configurable autonomy from full-auto to step-by-step approval; user reviews cumulative diff before applying |
| **GPT-Engineer** | ❌ Not supported | No HITL |
| **Claude Code** | ✅ Supported | Permission prompts, permission modes (default/acceptEdits/plan/auto), plan mode for review-before-edit. Checkpoints via hooks for custom approval workflows |
| **Bolt.diy** | ❌ Not supported | Auto-approves all AI changes |
| **Sweep** | ❌ Not supported | — |

### 13. State persistence (sessions, plans, artifacts across restarts)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | SQLite-based session persistence; project-specific context files |
| **Plandex** | ✅ Supported | Plans persist and can be resumed; cumulative diff sandbox stores pending changes |
| **GPT-Engineer** | ❌ Not supported | No persistence |
| **Claude Code** | ✅ Supported | Sessions persist in `~/.claude/projects/`; auto memory persists across sessions; CLAUDE.md files are disk-based |
| **Bolt.diy** | ⚠️ Partial | Project snapshots via browser storage and file system |
| **Sweep** | ❌ Not supported | — |

### 14. Provider-agnostic LLM

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | 15+ providers including Anthropic, OpenAI, Google, Groq, OpenRouter, AWS Bedrock, Azure, local models, Ollama, LM Studio |
| **Plandex** | ✅ Supported | Anthropic, OpenAI, Google, OpenRouter, open source providers; OpenRouter as primary gateway |
| **GPT-Engineer** | ✅ Supported | OpenAI, Anthropic, open source/local models |
| **Claude Code** | ⚠️ Partial | Primarily Claude models; supports Amazon Bedrock, Google Vertex AI, Microsoft Azure as third-party backends |
| **Bolt.diy** | ✅ Supported | 19+ providers including OpenAI, Anthropic, Google, Ollama, OpenRouter, DeepSeek, Groq, etc. |
| **Sweep** | ❌ Not applicable | — |

### 15. Multiple interfaces (CLI, TUI, API)

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenCode → Crush** | ✅ Supported | Interactive TUI, CLI (non-interactive mode with `-p`), scripting support |
| **Plandex** | ⚠️ Partial | REPL (TUI-like interactive mode) and CLI commands. No API mode |
| **GPT-Engineer** | ⚠️ Partial | CLI only |
| **Claude Code** | ✅ Supported | Terminal CLI (interactive + `-p`), VS Code extension, JetBrains plugin, Desktop app, Web UI, Slack, Agent SDK (Python/TypeScript API), GitHub Actions, GitLab CI/CD |
| **Bolt.diy** | ⚠️ Partial | Web UI, Electron desktop app, no API |
| **Sweep** | ❌ Not applicable | — |

---

## Summary Comparison Table

| Requirement | OpenCode→Crush | Plandex | GPT-Engineer | Claude Code | Bolt.diy |
|---|---|---|---|---|---|
| **1. Three-layer hierarchy** | ❌ | ❌ | ❌ | ⚠️ Partial | ❌ |
| **2. Config-driven orchestrators** | ❌ | ❌ | ❌ | ⚠️ Partial | ❌ |
| **3. Parallel subagent execution** | ❌ | ❌ | ❌ | ✅ | ❌ |
| **4. Strict hierarchy communication** | N/A | N/A | N/A | ✅ | N/A |
| **5. Mid-execution user messaging** | ❌ | ⚠️ | ❌ | ✅ | ❌ |
| **6. Conflict prevention** | ❌ | ⚠️ | ❌ | ⚠️ | ✅ |
| **7. Role-scoped tooling** | ✅ | ❌ | ❌ | ✅ | ❌ |
| **8. Skills system** | ✅ | ❌ | ⚠️ | ✅ | ❌ |
| **9. LSP integration** | ✅ | ⚠️ | ❌ | ✅ | ❌ |
| **10. Shell + directory permissions** | ⚠️ | ❌ | ❌ | ✅ | ❌ |
| **11. Session management** | ✅ | ✅ | ❌ | ✅ | ⚠️ |
| **12. HITL checkpoints** | ❌ | ✅ | ❌ | ✅ | ❌ |
| **13. State persistence** | ✅ | ✅ | ❌ | ✅ | ⚠️ |
| **14. Provider-agnostic LLM** | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| **15. Multiple interfaces** | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| **Open source** | ✅ (MIT) | ✅ (MIT) | ✅ (MIT) | ⚠️ (Partial) | ✅ (MIT) |
| **Language** | Go | Go | Python | Multi | TypeScript |
| **Activity** | ✅ Very Active | ✅ Active | ❌ Archived | ✅ Very Active | ✅ Active |
| **Stars** | 24.4k (Crush) | 15.4k | 55.2k | 125k | 19.4k |

---

## Key Questions Answered

### 1. Core architecture and agent hierarchy depth

- **Crush**: Single-agent TUI/CLI with sub-task spawning (2 layers max). No built-in orchestrator concept.
- **Plandex**: Single-agent plan→execute loop. No hierarchy.
- **GPT-Engineer**: Single-agent prompt→generate. No hierarchy.
- **Claude Code**: Main agent → subagents (2 layers). Experimental agent teams add peer-level coordination. No native 3-tier dispatch→orchestrator→subagent.
- **Bolt.diy**: Single-agent web app builder. No hierarchy.

### 2. Extensibility without source modification

- **Crush**: JSON config files, skills via markdown, MCP servers, LSP config. Moderate extensibility.
- **Plandex**: Model/provider config, autonomy level settings. Limited extensibility.
- **GPT-Engineer**: Pre-prompt overrides only. Very limited.
- **Claude Code**: Most extensible — YAML frontmatter subagents, skills, hooks, MCP, permission rules via JSON config files, managed settings for org-wide policy, plugin system. No source modification needed.
- **Bolt.diy**: Provider config, some environment variables. Limited.

### 3. Primary use case

- **Crush**: General-purpose AI coding assistant for terminal users
- **Plandex**: Large-scale, multi-step coding tasks requiring plan review and diff sandboxing
- **GPT-Engineer**: (Archived) Experimental code generation platform
- **Claude Code**: Production AI coding assistant with enterprise features, team collaboration, and multi-surface support
- **Bolt.diy**: Rapid full-stack web application prototyping in the browser

### 4. Project activity

- **Crush**: Very active — v0.70.0 (May 18, 2026), 24.4k stars, 3,380+ commits, Charm ecosystem backing
- **Plandex**: Active — v2.2.1 (Jul 16, 2025), 15.4k stars, 1,483 commits, active Discord
- **GPT-Engineer**: Archived — last release v0.3.1 (Jun 6, 2024), 55.2k stars, read-only
- **Claude Code**: Very active — 125k stars, 627 commits, active development, Anthropic backing
- **Bolt.diy**: Active — v1.0.0 (May 12, 2025), 19.4k stars, community-driven

### 5. Language

- **Crush**: Go
- **Plandex**: Go
- **GPT-Engineer**: Python
- **Claude Code**: Shell/Python/TypeScript (installer + plugins); core engine is proprietary binary
- **Bolt.diy**: TypeScript

### 6. Other notable open-source agent harnesses (2024-2025)

- **Crush** (charmbracelet/crush) — The most notable new entrant, as successor to OpenCode. Go-based, well-architected, Charm ecosystem.
- **Bolt.diy** (stackblitz-labs/bolt.diy) — Significant as a community fork enabling any LLM with Bolt.new's WebContainer architecture.
- **Claude Code Agent SDK** — Released mid-2025, enables building custom agents with Claude Code's tool set. Available in Python and TypeScript.

Could not locate active repositories for **Kortix Suna** or **Devon** as of May 2026.

---

## Source list

| # | Source | Type |
|---|--------|------|
| 1 | [OpenCode GitHub](https://github.com/opencode-ai/opencode) | GitHub |
| 2 | [Crush GitHub](https://github.com/charmbracelet/crush) | GitHub |
| 3 | [Plandex GitHub](https://github.com/plandex-ai/plandex) | GitHub |
| 4 | [GPT-Engineer GitHub](https://github.com/AntonOsika/gpt-engineer) | GitHub |
| 5 | [Claude Code GitHub](https://github.com/anthropics/claude-code) | GitHub |
| 6 | [Claude Code Overview](https://code.claude.com/docs/en/overview) | Official docs |
| 7 | [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents) | Official docs |
| 8 | [Claude Code Skills](https://code.claude.com/docs/en/skills) | Official docs |
| 9 | [Claude Code Memory](https://code.claude.com/docs/en/memory) | Official docs |
| 10 | [Claude Code Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Official docs |
| 11 | [Claude Code Settings](https://code.claude.com/docs/en/settings) | Official docs |
| 12 | [Claude Code Permissions](https://code.claude.com/docs/en/permissions) | Official docs |
| 13 | [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) | Official docs |
| 14 | [Claude Code Quickstart](https://code.claude.com/docs/en/quickstart) | Official docs |
| 15 | [Bolt.new GitHub](https://github.com/stackblitz/bolt.new) | GitHub |
| 16 | [Bolt.diy GitHub](https://github.com/stackblitz-labs/bolt.diy) | GitHub |
| 17 | [Sweep GitHub](https://github.com/sweepai/sweep) | GitHub |
| 18 | [Dispatch Requirements](file:///home/tradam/projects/dispatch/requirements.md) | Project file |

---

## Verbatim quotes

- "This repository is no longer maintained and has been archived for provenance. The project has continued under the name Crush" — [OpenCode GitHub](https://github.com/opencode-ai/opencode)
- "Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster" — [Claude Code GitHub](https://github.com/anthropics/claude-code)
- "Subagents are specialized AI assistants that handle specific types of tasks." — [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- "Agent teams let you coordinate multiple Claude Code instances working together. One session acts as the team lead, coordinating work, assigning tasks, and synthesizing results." — [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- "Plandex is a terminal-based AI development tool that can plan and execute large coding tasks that span many steps and touch dozens of files." — [Plandex GitHub](https://github.com/plandex-ai/plandex)
- "Crush: Your new coding bestie, now available in your favourite terminal. Your tools, your code, and your workflows, wired into your LLM of choice." — [Crush GitHub](https://github.com/charmbracelet/crush)
- "Claude Code supports fine-grained permissions so that you can specify exactly what the agent is allowed to do and what it cannot." — [Claude Code Permissions](https://code.claude.com/docs/en/permissions)
- "GPT-Engineer lets you: Specify software in natural language, Sit back and watch as an AI writes and executes the code" — [GPT-Engineer GitHub](https://github.com/AntonOsika/gpt-engineer)
- "This repository was archived by the owner on Apr 22, 2026. It is now read-only." — [GPT-Engineer GitHub](https://github.com/AntonOsika/gpt-engineer)
- "Skills extend what Claude can do. Create a SKILL.md file with instructions, and Claude adds it to its toolkit." — [Claude Code Skills](https://code.claude.com/docs/en/skills)

---

## Source quality flags

- **Claude Code GitHub repo**: The repository (anthropics/claude-code) contains primarily installer scripts, plugins, examples, and documentation — the core agent engine is proprietary and distributed via `npm`/native installers. The docs at code.claude.com are official Anthropic documentation.
- **GPT-Engineer**: Archived project; README explicitly directs users to other tools. Not representative of current capabilities.
- **Sweep**: README indicates project has pivoted to a JetBrains plugin. The open source repo is not actively maintained for the use case being evaluated.

---

## Confidence: High

All major frameworks evaluated have been thoroughly researched via their GitHub repositories and official documentation. Claude Code's proprietary core limits the depth of source-code-level analysis, but its public documentation is extensive and detailed. Frameworks like Kortix Suna and Devon could not be located, indicating they may have been renamed, deprecated, or are not publicly available under those names.

---

## Gaps and open questions

1. **Kortix Suna** and **Devon** could not be located — they may exist under different GitHub orgs, have been renamed, or are not publicly available.
2. **Claude Code's core architecture** is not fully open source; the proprietary agent engine cannot be audited for architectural details. The analysis is based on publicly documented behavior.
3. **Claude Code's Agent SDK** (released mid-2025) represents a new category — it provides programmatic access to Claude Code's agent loop. A follow-up investigation could evaluate it as an alternative to building from scratch.
4. **Crush** is still in v0.x (v0.70.0) — some features like hooks are marked as "preliminary" and may not be production-ready.
5. **None of the evaluated frameworks** provide a native three-layer (dispatch→orchestrator→subagent) architecture. This appears to be a novel design not present in existing open-source tools.

---

## Tool calls made

Web fetches: 20 (OpenCode, Plandex, GPT-Engineer, Claude Code, Sweep, Devon attempted, Bolt.new, Plandex docs, Claude Code overview, sub-agents, skills, memory, Agent SDK, settings, permissions, agent teams, quickstart, Crush, Bolt.diy, Sweep README)
