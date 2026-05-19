# Subagent Report: pi.dev (Pi) — Super-Customizable AI Agent Harness

## Research summary

Pi (pi.dev / `@earendil-works/pi-coding-agent`) is a minimal, aggressively **extensible** terminal-based coding agent harness built in **TypeScript** by Mario Zechner (Earendil Inc.). It is **not** a multi-agent orchestration framework — it is a **single-agent CLI** (like Claude Code, opencode, or Codex) designed to be customized via TypeScript extensions, markdown skills, prompt templates, and themes. It has excellent built-in support for provider-agnostic LLMs, session management (tree-structured with branching), state persistence, user-to-agent messaging mid-execution, and multiple interfaces (TUI, CLI, RPC, SDK). However, **multi-agent hierarchy, config-driven orchestrators, LSP integration, conflict prevention, and role-scoped tooling are all absent by design** — the project philosophy is "primitives, not features." These would need to be built from scratch as extensions. Confidence: **high** — the source, docs, and blog posts are extensive and transparent about what Pi does and does not include.

---

## Findings

### 1. Overview: What Pi Is and Is Not

**What exactly IS Pi?** Pi is a monorepo containing five npm packages:

| Package | Purpose |
|---|---|
| `@earendil-works/pi-ai` | Unified multi-provider LLM API (15+ providers: Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, Cerebras, xAI, Hugging Face, OpenRouter, etc.) |
| `@earendil-works/pi-agent-core` | Agent runtime with tool calling, state management, event streaming, compaction |
| `@earendil-works/pi-coding-agent` | The main CLI: interactive TUI, print mode, JSON mode, RPC mode, SDK |
| `@earendil-works/pi-tui` | Terminal UI library with differential rendering |
| `@earendil-works/pi-web-ui` | Web components for AI chat interfaces |

Pi is **not** a multi-agent orchestration framework like LangGraph or CrewAI. It is a **single-agent coding assistant CLI** that you run in a terminal. The "super customizable" claim refers to its extension system — you can add tools, commands, UI components, and behaviors via TypeScript extensions without forking the codebase.

[Source: GitHub monorepo README](https://github.com/earendil-works/pi)

**Language & Tech Stack:**

- **TypeScript** (96.5% of the repo), JavaScript (2.9%), CSS (0.4%), Shell (0.2%)
- Runtime: Node.js >= 22.19.0
- Key dependencies: `jiti` (TypeScript loader for extensions), `typebox` (schema validation), `chalk`, `yaml`, `diff`, `undici`, `cross-spawn`
- Packaging: npm ecosystem, published as `@earendil-works/pi-coding-agent`
- Custom-built TUI framework (`pi-tui`) — not React/Ink-based

[Source: package.json](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)

**License:** MIT — fully open source.

[Source: LICENSE file](https://github.com/earendil-works/pi/blob/main/LICENSE)

**Activity & Community:** Extremely active.

| Metric | Value |
|---|---|
| GitHub Stars | **51.4k** |
| Forks | **6.1k** |
| Commits | **4,188** |
| Releases | **219** (latest: v0.75.3, May 18, 2026) |
| Open Issues | 28 |
| Open PRs | 6 |
| Discord Community | Yes (linked from site) |
| Maintainer | Mario Zechner (badlogicgames) / Earendil Inc. |

Note: New contributor issues/PRs are auto-closed by default; maintainers review them daily.

[Source: GitHub repo](https://github.com/earendil-works/pi)

**Philosophy (from the maintainer's blog):**
> "If I don't need it, it won't be built. And I don't need a lot of things."
> "Pi is aggressively extensible so it doesn't have to dictate your workflow."
> "Features that other tools bake in can be built with extensions, skills, or installed from third-party pi packages."

Pi deliberately ships **without**: sub-agents, plan mode, permission popups, MCP support, background bash, and to-do lists. The maintainer believes these should be built as extensions or handled externally (tmux, containers, file-based plans).

[Source: maintainer blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

---

### 2. Architecture Deep-Dive

#### Core Architecture (Layered)

```
┌────────────────────────────────────────────────┐
│  pi-coding-agent (CLI/TUI)                      │
│  Session management, extensions, skills,        │
│  themes, prompt templates, commands, UI         │
├────────────────────────────────────────────────┤
│  pi-agent-core                                  │
│  Agent loop, tool execution, state management   │
│  Event streaming, compaction, transport layer   │
├────────────────────────────────────────────────┤
│  pi-ai                                          │
│  Unified LLM API: OpenAI, Anthropic, Google,    │
│  and 12+ more providers. Tool calling,          │
│  streaming, thinking/reasoning, context handoff │
├────────────────────────────────────────────────┤
│  pi-tui / pi-web-ui                             │
│  Terminal UI framework / Web components         │
└────────────────────────────────────────────────┘
```

[Source: GitHub README](https://github.com/earendil-works/pi)

#### Agent Creation & Management

Pi's agent model is **single-agent per session**. Key classes:

- **`AgentSession`** — Manages one agent's lifecycle, message history, model state, streaming. Created via `createAgentSession()`.
- **`Agent`** (from `@earendil-works/pi-agent-core`) — The core loop: processes user messages, executes tool calls, feeds results back to LLM, repeats until done.
- **`AgentSessionRuntime`** — Wraps `AgentSession` with session replacement capabilities (new/resume/fork/clone).
- **SessionManager** — Handles persistence as tree-structured JSONL files.

The agent loop is minimal: no max-steps limit, no sub-agent spawning. It loops until the model produces a non-tool-call response.

#### Extension System (Plugin Model)

Extensions are **TypeScript modules** auto-discovered from well-known directories:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

Extensions export a default factory function receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools
  pi.registerTool({ name: "my_tool", ... });
  
  // Register commands
  pi.registerCommand("mycmd", { handler: async (args, ctx) => { ... } });
  
  // Register keyboard shortcuts
  pi.registerShortcut("ctrl+x", { handler: async (ctx) => { ... } });
  
  // Register CLI flags
  pi.registerFlag("my-flag", { description: "..." });
  
  // Hook events
  pi.on("tool_call", async (event, ctx) => { ... });
  pi.on("session_start", async (event, ctx) => { ... });
  pi.on("before_agent_start", async (event, ctx) => { ... });
  // ... 30+ event types
}
```

**What extensions can do:**
- Custom tools (or replace built-in tools entirely)
- Intercept/block/modify tool calls via `tool_call` event
- Custom compaction and summarization
- Permission gates, path protection
- Custom UI components, editors, status bars, overlays
- SSH and sandbox execution
- MCP server integration (via custom tool wrapping)
- Sub-agents (spawn child `pi` processes via bash)
- Session persistence via `pi.appendEntry()`
- Custom providers and models

Extensions are loaded via `jiti` (TypeScript compilation on-the-fly). Async factories are supported. Pi packages bundle extensions, skills, prompts, and themes for sharing via npm or git.

**50+ extension examples** in the repo, including: subagent, plan-mode, permission-gate, protected-paths, sandbox, ssh, custom-compaction, snake game, Doom.

[Source: Extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

#### Skills System

Pi implements the [Agent Skills standard](https://agentskills.io). Skills are markdown files with YAML frontmatter stored in directories:

```
~/.pi/agent/skills/my-skill/SKILL.md
~/.agents/skills/
.pi/skills/
.agents/skills/ (in cwd and ancestor directories)
```

Skills follow progressive disclosure: only descriptions are always in the context; the full SKILL.md content loads on-demand when triggered via `/skill:name` command or when the agent decides to read it.

#### Event Lifecycle

Pi exposes ~30 events across the lifecycle:
- **Resource events**: `resources_discover`
- **Session events**: `session_start`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`
- **Agent events**: `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start/update/end`
- **Tool events**: `tool_call` (can block), `tool_result` (can modify), `tool_execution_start/update/end`
- **Model events**: `model_select`, `thinking_level_select`
- **Input events**: `input` (can intercept/transform)
- **User bash events**: `user_bash`

[Source: Extensions documentation (event reference)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

---

### 3. Requirements Checklist Evaluation

For each requirement, two ratings are given:
- **Built-in Support**: Is it present in the core today?
- **Ease of Adding**: How hard to build on top of Pi's extension system?

| # | Requirement | Built-in Support | Ease of Adding | Assessment |
|---|---|---|---|---|
| 1 | **Three-layer hierarchy** (dispatch→orchestrator→subagent) | **Not supported** — Pi is a single-agent system. No parent-child agent relationships. | **Hard** — No architectural concept of agent hierarchy exists. The subagent extension spawns child `pi` processes via bash, but has no orchestration layer, routing, or lifecycle management. Building a full 3-layer hierarchy with dispatch and orchestrator would require creating the entire system from scratch as an extension. | The architecture is flat: one agent session, one agent loop. Adding hierarchy means building a new abstraction layer atop the existing single-agent runtime, not extending an existing one. |
| 2 | **Config-driven orchestrators** (orchestrator types defined via YAML/JSON config) | **Not supported** — No concept of "orchestrator types" or orchestration configs. | **Hard** — Pi uses JSON files for its own settings (settings.json, models.json), but there is no orchestrator abstraction. Would need to build a config schema and runtime interpreter for orchestrator definitions from scratch. | Pi's `settings.json` is for Pi configuration, not agent orchestration. A new config format and execution engine would be needed. |
| 3 | **Parallel subagent execution** | **Not supported** built-in. The subagent example extension supports parallel execution (up to 8 tasks, 4 concurrent). | **Moderate** — The subagent extension already exists as a working example and supports parallel `pi` process spawning. However, it spawns child processes via bash (not in-process agents), has a 50KB output cap per task, and limited concurrency. Would need significant enhancement for production use. | Example exists but is a demo, not production-grade. Architecture of spawning subprocesses works but has limitations. |
| 4 | **Strict hierarchy communication** (subagents only talk to parent orchestrator, no peer-to-peer) | **Not supported** — No communication framework between agents. Subagents (when used) are independent processes. | **Moderate** — Could build a message-passing protocol on top of the subagent extension or RPC mode. But Pi has no built-in mechanism for parent-child routing or peer-to-peer blocking. | Would need to implement a communication protocol and enforce routing rules. |
| 5 | **User-to-agent messaging mid-execution** | **Supported** — Built-in message queuing. `Enter` queues a "steer" message (delivered after current tool call, interrupts remaining tools). `Alt+Enter` queues a "follow-up" (delivered when agent finishes). Escape aborts and restores queued messages. | N/A (already built-in) | **Strong feature.** Configurable delivery modes: `one-at-a-time` (default) or `all`. Also available programmatically via `session.steer()` and `session.followUp()` methods in the SDK. |
| 6 | **Conflict prevention** (non-overlapping file scopes for parallel agents) | **Not supported** — Pi runs in YOLO mode with full filesystem access. No concept of file scope assignment. | **Hard** — Goes against Pi's core philosophy of unrestricted access. Could be approximated by running each agent in a different directory/container, but there's no built-in file-scope assignment or enforcement mechanism. | Pi's design philosophy explicitly rejects this kind of restriction. Working around it would be fighting the architecture. |
| 7 | **Role-scoped tooling** (different agents get different tool sets based on role) | **Partial** — Pi's `--tools` flag can restrict which tools are available globally. Extensions can register custom tools. But there's no role-based assignment system. | **Moderate** — Could use the `before_agent_start` event to dynamically modify the toolset based on context. But there's no built-in concept of "agent roles" or tool-to-role mapping. | Single-agent system means no role differentiation. Would need to build role management into whatever multi-agent layer you add. |
| 8 | **Skills system** (injectable markdown instructions per agent type, with specific directory structure) | **Partial** — Pi has a full skills system following the Agent Skills standard. Skills are markdown files with YAML frontmatter. They are discovered from `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, and ancestor `.agents/skills/` directories. However, the directory structure does NOT match the required `default/`, `agents/`, `project/` subdirectory scheme. | **Easy** — The skills system is mature and extensible. The directory structure is configurable through the `DefaultResourceLoader`. Adding support for additional directory conventions would be straightforward. | Skills system is one of Pi's strongest extensibility points. The directory convention difference is minor. |
| 9 | **LSP integration** (Language Server Protocol for compiler/linter diagnostics) | **Not supported** — No LSP client. Pi has no compiler, linter, or language server integration. | **Hard** — Would need to build an LSP client as an extension, handling stdio JSON-RPC protocol, file synchronization, diagnostics display, etc. No existing LSP primitives exist in the codebase. | This is a significant feature to build, but not architecturally impossible — just no existing support. |
| 10 | **Shell access with directory permissions** (auto-allow lists, prompt for out-of-scope directories) | **Not supported** — Pi has full unrestricted bash access by design ("YOLO mode"). There IS a `permission-gate.ts` extension example that prompts before dangerous commands, and a `protected-paths.ts` extension example. | **Moderate** — The tool_call event can intercept bash commands. Directory awareness could be added. But the permission model would need to be built from scratch (auto-allow lists, scope checking). | The extension event model makes this possible, but Pi's philosophy is deliberately against permission systems. |
| 11 | **Session management** (chat forking, model switching mid-conversation, loading/resuming old chats) | **Supported** — Excellent built-in session management: tree-structured JSONL files, `/tree` navigation to any previous point, `/fork` (new session from user message), `/clone` (duplicate branch), `/resume` (pick from past sessions), `/model` to switch models mid-session, HTML export, share via GitHub gist. Auto-save on every message. | N/A (already built-in) | **Strong feature.** Sessions persist to `~/.pi/agent/sessions/` organized by working directory. Continue with `pi -c`. |
| 12 | **Human-in-the-loop checkpoints** (execution pauses at configurable points for user approval) | **Partial** — No built-in checkpoint system. But the extension event model allows blocking on any tool_call event. The permission-gate extension demonstrates this pattern. | **Easy** — Extensions can block tool execution via `{ block: true, reason: "..." }` return from `tool_call` event handler. Can show confirmation dialogs via `ctx.ui.confirm()`. Configurable checkpoint logic can be implemented entirely in an extension. | The `tool_call` event's blocking capability is exactly designed for this. |
| 13 | **State persistence** (sessions, plans, artifacts persist across restarts) | **Supported** — Sessions auto-save to disk as JSONL files. Everything persists: full message history, model state, compaction metadata, tool results. `pi -c` continues the most recent session. Sessions survive process restarts. | N/A (already built-in) | **Strong feature.** Tree structure with branching means no information is lost — old branches remain accessible via `/tree`. |
| 14 | **Provider-agnostic LLM** (multiple providers through abstract interface) | **Supported** — 15+ built-in providers (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, Cerebras, xAI, Hugging Face, OpenRouter, Together AI, Fireworks, DeepSeek, Kimi, MiniMax, etc.), custom providers via `models.json`, custom providers via extensions with full OAuth flows. Model switching mid-session. | N/A (already built-in) | **Strong feature.** Cross-provider context handoff is built into `@earendil-works/pi-ai` — models can be switched mid-conversation. |
| 15 | **Multiple interfaces** (CLI, TUI, API modes) | **Supported** — 4 built-in modes: **Interactive** (full TUI), **Print** (`-p` for scripts), **JSON** (`--mode json` for structured output), **RPC** (`--mode rpc` for stdin/stdout JSONL protocol). Plus an **SDK** for embedding Pi in Node.js apps. Plus a **web-ui** package for web interfaces. | N/A (already built-in) | **Strong feature.** The SDK exports `InteractiveMode`, `runPrintMode`, and `runRpcMode` utilities for building custom interfaces on top. |

---

### 4. Strengths and Weaknesses as a Base for the Dispatch Harness

#### Strengths

1. **Exceptional session management** — Tree-structured sessions with branching, forking, cloning, resume, and model switching mid-conversation. This provides a robust foundation for state persistence.

2. **Excellent provider-agnostic LLM layer** — 15+ providers, cross-provider context handoff, and a clean abstraction (`@earendil-works/pi-ai`). This could directly power the LLM layer of a dispatch system.

3. **Powerful extension system** — TypeScript extensions with full access to lifecycle events, tool registration, UI components, and state management. The `tool_call` event's blocking capability is ideal for human-in-the-loop checkpoints. The `before_agent_start` event allows dynamic system prompt modification. These are the primitives needed for orchestration logic.

4. **Message queuing mid-execution** — Built-in steer/follow-up messaging provides the foundation for user-to-agent communication during execution.

5. **Multiple interface modes** — TUI, CLI, JSON, RPC, and SDK mean the system can be used interactively, programmatically, or embedded.

6. **Mature skills system** — Follows the Agent Skills standard, with progressive disclosure. Easily adaptable to different directory conventions.

7. **MIT license** — No restrictions on use or modification.

8. **Active community and maintenance** — 219 releases, very active development. The project is not abandoned.

#### Weaknesses

1. **No multi-agent architecture** — Pi is fundamentally single-agent. There is no concept of agent hierarchy, orchestrator, dispatch, or subagent management. Building a 3-layer hierarchy (dispatch→orchestrator→subagent) means creating an entirely new architectural layer on top of Pi, not extending an existing one. This is the single biggest gap.

2. **No config-driven orchestration** — Pi has no YAML/JSON-based orchestrator definitions, no workflow DSL, no task routing. This would need to be built from scratch.

3. **No role-scoped tooling** — Pi's tool model is flat. There's no concept of "this agent type gets these tools." Role-based tool assignment would need to be built.

4. **"YOLO by design" philosophy** — The maintainer explicitly rejects permission gates, file-scope restrictions, and safety rails. While extensions can add some of these, the architecture and philosophy push against them. Conflict prevention for parallel agents (requirement 6) is particularly at odds with Pi's design.

5. **Subagent implementation is ad-hoc** — The subagent extension spawns child `pi` processes via bash, not in-process agents. This means: separate process overhead, no shared state, limited communication, 50KB output cap. Production-grade subagent management would need significant rework.

6. **No LSP integration** — Building LSP support from scratch is a significant undertaking.

7. **No built-in WebSocket/server mode** — While RPC mode exists, there's no persistent server/API mode that could serve as a dispatch endpoint. The SDK can be embedded, but you'd need to build the server layer.

8. **Node.js-only** — The entire stack is TypeScript/Node.js. If the Dispatch system needs polyglot support, Pi cannot provide it.

#### Summary Verdict

Pi is **not a suitable base framework** for the Dispatch requirements as stated, primarily because it lacks any multi-agent architecture. It would require building the entire hierarchy, orchestration, routing, and role systems from scratch. What Pi does provide (session management, provider abstraction, extension system, state persistence, messaging) are valuable **components that could be used within** a Dispatch-like system, but Pi itself is the wrong substrate.

A better approach would be to use `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as **libraries** in a custom-built orchestration system, rather than trying to extend the Pi CLI into something it was never designed to be.

---

## Source list

| # | Source | Type |
|---|--------|------|
| 1 | [pi.dev website](https://pi.dev) | Official website |
| 2 | [GitHub monorepo](https://github.com/earendil-works/pi) | Source code |
| 3 | [Coding Agent README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) | Official docs |
| 4 | [Extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | Official docs |
| 5 | [Skills documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) | Official docs |
| 6 | [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) | Official docs |
| 7 | [Subagent extension example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md) | Example code |
| 8 | [Maintainer's blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) | Blog post |
| 9 | [package.json (coding-agent)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) | Source metadata |
| 10 | [package.json (agent-core)](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json) | Source metadata |
| 11 | [Permission gate extension example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts) | Example code |
| 12 | [Subagent extension source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) | Example code |

---

## Verbatim quotes

- "Pi is a minimal terminal coding harness. Adapt Pi to your workflows, not the other way around." — [pi.dev](https://pi.dev)
- "Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way." — [pi.dev](https://pi.dev)
- "No sub-agents. There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way." — [Coding Agent README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- "If I don't need it, it won't be built. And I don't need a lot of things." — [Mario Zechner's blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- "pi runs in full YOLO mode and assumes you know what you're doing. It has unrestricted access to your filesystem and can execute any command without permission checks or safety rails." — [Mario Zechner's blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- "Spawning multiple sub-agents to implement various features in parallel is an anti-pattern in my book and doesn't work, unless you don't care if your codebase devolves into a pile of garbage." — [Mario Zechner's blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- "Extensions are TypeScript modules that extend pi's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more." — [Extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- "Pi does not and will not have a built-in plan mode." — [Mario Zechner's blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- "pi's system prompt and tool definitions together come in below 1000 tokens." — [Mario Zechner's blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- "Submit messages while the agent works. Enter sends a steering message (delivered after current tool, interrupts remaining tools). Alt+Enter sends a follow-up (waits until the agent finishes)." — [pi.dev](https://pi.dev)
- "I prefer Claude Code for most of my work... Over the past few months, Claude Code has turned into a spaceship with 80% of functionality I have no use for." — [Mario Zechner's blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

---

## Source quality flags

- Source 6 (Maintainer's blog): **Personal blog post** — strong authority on Pi's design philosophy and rationale, but represents one person's opinion. Explicitly states design decisions that may not align with all use cases. The benchmark claims are specific to Pi and useful for comparison but should be taken as one data point.
- Source 1 (pi.dev): **Marketing website** — the landing page is promotional, but the actual content is technically accurate and links to verifiable source code. Not marketing hype in the traditional sense, but does emphasize features positively.
- No AI-generated summaries or paid content were used.

---

## Confidence: High

Comprehensive primary source data was available: the full source code (GitHub), extensive documentation (extensions.md at 94KB, sdk.md at 32KB), the maintainer's detailed technical blog post, and the package.json metadata. The project is transparent about what it does and doesn't do. No conflicting information was found across sources.

---

## Gaps and open questions

1. **Real-world multi-agent usage**: No evidence was found of anyone successfully building a production multi-agent orchestration layer on top of Pi. The subagent extension is explicitly labeled as an example/demo. It's unknown how well it holds up under production loads.

2. **Performance with deeply hierarchical systems**: Since Pi's architecture is single-agent, there's no data on how it performs when one Pi instance orchestrates many child Pi instances. The subagent example caps at 8 tasks/4 concurrent.

3. **LSP integration**: No community extensions or discussions about LSP support were found. The feasibility of building an LSP extension is theoretical.

4. **Conflict prevention approaches**: While Pi's philosophy rejects permissions, there may be creative approaches using containers, directory-restricted `pi` instances, or RPC-level routing that were not explored in this research.

5. **Community ecosystem size**: The Discord server exists and packages are listed on npm, but no hard data was found on how many third-party extensions/packages exist or how active the community is beyond the core maintainer.

6. **Comparison with opencode**: The maintainer mentions opencode in his blog (using their models.dev data), and Pi was partly inspired by frustrations with Claude Code. But no direct architectural comparison with opencode was found — this would be valuable for evaluating which framework is a better base for the Dispatch requirements.
