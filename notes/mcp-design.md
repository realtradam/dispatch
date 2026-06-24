# MCP (Model Context Protocol) Integration — Design

> **Status:** DESIGN — pending user approval before implementation.
> Spec: https://modelcontextprotocol.io/specification/2025-11-25
> SDK (TS): https://github.com/modelcontextprotocol/typescript-sdk

## 0. What MCP is

MCP is an open standard (Anthropic, Nov 2024) for connecting AI applications
to external tools, data sources, and services — "USB-C for AI." An AI host
(like Dispatch) connects to MCP servers, which expose capabilities as three
primitives: **Tools** (executable actions), **Resources** (read-only data),
and **Prompts** (reusable templates). The protocol is **JSON-RPC 2.0** over
**stdio** (local child process) or **Streamable HTTP** (remote, POST + SSE).

The architecture has three roles:
- **Host** — the AI application (Dispatch). Manages multiple MCP clients.
- **Client** — one per server. Handles the connection, capability discovery,
  and primitive invocation.
- **Server** — a process/service exposing Tools/Resources/Prompts.

Dispatch will act as an **MCP host**. Each configured MCP server is a child
process (stdio) or remote endpoint (HTTP) that Dispatch spawns/connects to,
discovers tools from, and proxies tool calls to.

## 1. Why this fits Dispatch's architecture

MCP integration is a **standard extension** — not kernel, not core. It is
architecturally a sibling of the existing `lsp` extension:

| Aspect | LSP extension | MCP extension (proposed) |
|---|---|---|
| Protocol | JSON-RPC 2.0 over stdio | JSON-RPC 2.0 over stdio + HTTP |
| Child processes | One per (serverID, root) | One per configured server |
| Config source | `.dispatch/lsp.json` + `opencode.json` `lsp` key | `.dispatch/mcp.json` + `opencode.json` `mcp` key |
| Config resolution | Per-cwd | Per-cwd (same pattern) |
| What it registers | `lsp` tool + `lspServiceHandle` | N tools (one per MCP tool discovered) + `mcpServiceHandle` |
| Lifecycle | lazy-spawn, `deactivate` kills all | lazy-spawn, `deactivate` kills all |
| Capability | `spawn: true, fs: true` | `spawn: true` (stdio) / network (HTTP) |

**Key difference:** LSP registers ONE tool (`lsp`) that the model calls to
query diagnostics. MCP registers MANY tools — one per tool discovered from each
connected MCP server. The model calls them directly by name (e.g.
`freecad_create_object`, `chrome_navigate`). This is the whole point: the model
sees MCP server tools as first-class Dispatch tools.

**How tools reach the model:** the `session-orchestrator`'s `resolveTools()`
calls `host.getTools()` → the MCP extension has called `host.defineTool()` for
each discovered MCP tool → they flow through the `toolsFilter` chain → into
`runTurn`. No new contract surface needed for the basic tool path — the existing
`ToolContract` + `host.defineTool` + `host.getTools()` is sufficient.

## 2. The per-task loading problem

The user wants to "load up MCPs for specific tasks." This means different MCP
servers should be available in different contexts — not all MCP servers all the
time. Three mechanisms address this, in increasing sophistication:

### 2a. Per-cwd config (baseline — mirrors LSP)
Config is resolved per-cwd: `.dispatch/mcp.json` in the working directory
declares which MCP servers are available. A conversation pointed at a FreeCAD
project dir has `freecad` configured; one pointed at a web project has
`chrome-devtools` configured. This is the simplest mechanism and mirrors LSP
exactly. No new contract surface.

### 2b. Tools filter (per-turn scoping)
The MCP extension registers a `toolsFilter` (same mechanism as `skills`) that
can REMOVE tools from the assembly based on per-turn context. For example:
- Only include MCP tools from servers that have successfully connected (drop
  tools from a server that's `error`/disconnected).
- Scope by a per-conversation "enabled MCP servers" preference (the user
  toggles which MCP servers are active for this conversation).

This requires NO new contract — the `toolsFilter` + `ToolAssembly` already
carry `cwd` + `conversationId`, which is enough to scope.

### 2c. Dynamic enable/disable surface (later)
A per-conversation surface (like cache-warming's) where the user toggles MCP
servers on/off from the frontend. This needs a surface + transport endpoints
but reuses the existing surface framework. Deferred to a later phase.

## 3. Config format

Mirror the `mcpServers` format that the MCP ecosystem uses (Claude Desktop,
VS Code, Cursor all use this shape), adapted to Dispatch's per-cwd resolution:

### `.dispatch/mcp.json`
```json
{
  "servers": {
    "freecad": {
      "command": "uvx",
      "args": ["freecad-mcp"],
      "env": { "FREECAD_RPC_HOST": "localhost" }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"]
    },
    "remote-freecad": {
      "transport": "http",
      "url": "http://192.168.1.100:9876/mcp"
    }
  }
}
```

### `opencode.json` (fallback)
```json
{
  "mcp": {
    "freecad": { "command": "uvx", "args": ["freecad-mcp"] }
  }
}
```

**Resolution** (same precedence as LSP):
1. `<cwd>/.dispatch/mcp.json` — if present, its `servers` win (shadow warning
   if `opencode.json` also declares `mcp`).
2. `<cwd>/opencode.json` `mcp` key — fallback.
3. No built-in servers (MCP has no built-in registry; everything is configured).

Each server entry:
- `command` + `args` + optional `env` → stdio transport (spawn child process).
- `transport: "http"` + `url` + optional `headers` → Streamable HTTP transport.
- Optional `disabled: true` → present in config but not started (for the
  enable/disable surface later).

## 4. Architecture — the `mcp` extension (`packages/mcp/`)

```
packages/mcp/src/
  config.ts        PURE config resolution (mirrors lsp/config.ts)
  config.test.ts
  transport.ts     Transport abstraction: stdio + Streamable HTTP
  transport.test.ts
  framing.ts       Content-Length framing for stdio (mirrors lsp/framing.ts)
  framing.test.ts
  rpc.ts           JSON-RPC 2.0 client (request/response/notification, mirrors lsp/rpc.ts)
  rpc.test.ts
  client.ts        MCP client: initialize → tools/list → tools/call; handles
                   list_changed notifications; capability negotiation
  client.test.ts
  manager.ts       McpManager: one client per configured server; lazy-spawn;
                   status(); getClient(); shutdownAll()
  manager.test.ts
  registry.ts      Tool name namespacing + ToolContract adapter:
                   wraps an MCP tool (name/description/inputSchema) into a
                   Dispatch ToolContract whose execute() proxies to tools/call
  registry.test.ts
  types.ts         McpServerConfig, McpServerStatus, McpService, McpToolInfo
  extension.ts     manifest + activate(host): real spawn/HTTP adapters, register
                   tools via host.defineTool, register toolsFilter, mcpServiceHandle
  index.ts         public surface (exports)
```

### 4.1. The MCP client lifecycle

```
1. resolve config (per-cwd) → list of server configs
2. on first tool access (lazy):
   a. stdio: spawn child process (command + args + env)
   b. http: open HTTP/SSE connection
3. send `initialize` { protocolVersion, capabilities, clientInfo }
4. receive server { protocolVersion, capabilities, serverInfo }
5. send `notifications/initialized`
6. call `tools/list` → discover tools
7. for each tool: register a namespaced ToolContract via host.defineTool
8. if server declared `tools.listChanged: true`:
   listen for `notifications/tools/list_changed` → re-list → re-register
9. on deactivate: send shutdown, kill child process / close HTTP
```

### 4.2. Tool name namespacing

MCP tools from different servers may have name collisions (e.g. both freecad
and chrome-devtools might have a `screenshot` tool). Solution: namespace as
`<serverId>_<toolName>`:

- `freecad_create_object`
- `chrome-devtools_navigate_page`
- `chrome-devtools_take_screenshot`

The ToolContract's `description` is prefixed with `[<serverId>]` for clarity:
`"[chrome-devtools] Take a screenshot of the current page"`.

### 4.3. The ToolContract adapter (registry.ts)

Each MCP tool discovered via `tools/list` becomes a `ToolContract`:

```typescript
// MCP tool (from tools/list):
{ name: "create_object", description: "...", inputSchema: { type: "object", ... } }

// → adapted to Dispatch ToolContract:
{
  name: "freecad_create_object",
  description: "[freecad] Create a new object in FreeCAD.",
  parameters: <mapped from inputSchema>,
  execute: async (args, ctx) => {
    // proxy to MCP server: tools/call { name: "create_object", arguments: args }
    const result = await client.callTool("create_object", args, ctx.signal);
    // MCP returns content array (text/image/resource) → flatten to string
    return { content: flattenContent(result.content), isError: result.isError };
  },
  concurrencySafe: false,  // MCP tools are generally not concurrency-safe
}
```

The MCP `inputSchema` is already JSON Schema, which maps directly to
Dispatch's `ToolParameterSchema` (same structural type — see tool.ts contract).
No transformation needed beyond passthrough.

### 4.4. Content flattening

MCP tool results return a `content` array of typed items:
```json
{ "content": [
  { "type": "text", "text": "..." },
  { "type": "image", "data": "<base64>", "mimeType": "image/png" },
  { "type": "resource", "resource": { "uri": "...", "text": "..." } }
] }
```
Dispatch's `ToolResult.content` is a string. Flattening:
- `text` → the text.
- `image` → `"[image: <mimeType>, <n> bytes]"` (data not inlined; a future
  multimodal ToolResult could carry it).
- `resource` → the resource text or `"[resource: <uri>]"`.
- Multiple items → joined with `\n`.

### 4.5. Resources and Prompts (deferred)

MCP servers also expose **Resources** (read-only data) and **Prompts**
(templated messages). These are lower priority:
- **Resources** could be exposed as a `mcp` tool op (`list_resources`,
  `read_resource`) or injected into context — deferred.
- **Prompts** could be surfaced as skills — deferred.

Phase 1 implements **Tools** only (the highest-value primitive). Resources
and Prompts can be added later without breaking the Tools path.

### 4.6. Client → Server capabilities (deferred)

MCP servers can request:
- **Sampling** (`sampling/createMessage`) — the server asks the host to run an
  LLM completion. This enables recursive agent workflows. Deferred (complex;
  requires a provider round-trip from within a tool call).
- **Roots** — the server asks about filesystem boundaries. We can support this
  by returning the conversation's cwd. Low effort but deferred.
- **Elicitation** — the server requests structured input from the user. Needs
  a UI round-trip. Deferred.

Phase 1 declares `capabilities: {}` (no client capabilities) — pure consumer.

## 5. Security considerations

MCP servers are **arbitrary code execution** (they spawn child processes,
make network calls, access the filesystem). Key security measures:

1. **Config-gated, not auto-discovered.** MCP servers are only loaded from
   `.dispatch/mcp.json` or `opencode.json` in the cwd — never auto-discovered
   or downloaded. The user must explicitly configure them.
2. **Trust level.** The `mcp` extension is `trust: "bundled"` (like `lsp`),
   meaning it's only loaded from the bundled set, not from untrusted
   external extensions. The MCP *servers* it spawns are user-configured and
   run with the server process's privileges — same as `run_shell`.
3. **`capabilities: { spawn: true, network: true }`** — the extension needs
   both spawn (stdio) and network (HTTP). The host gates these.
4. **No shared secrets.** The `env` in the config is passed to the child
   process directly; the extension never logs env values (self-redaction per
   `.dispatch/rules/extension-logging.md`).
5. **Tool descriptions are untrusted** (per MCP spec). They are passed through
   to the model but never executed as code.

## 6. Glossary additions (proposed)

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **MCP** | Model Context Protocol — the JSON-RPC 2.0-over-stdio/HTTP protocol an MCP server speaks. Used as the adjective for the feature (the `mcp` extension, the `mcp` tool). | — |
| **MCP server** | A process/service speaking MCP that exposes Tools, Resources, and/or Prompts. Spawned (stdio) or connected (HTTP) by Dispatch acting as MCP host. | MCP provider (that's a Dispatch provider) |
| **MCP host** | The application (Dispatch) that manages MCP clients, discovers server capabilities, and proxies tool calls. Dispatch is always the host. | — |

("MCP client" is an internal implementation detail of the `mcp` extension, not
a user-facing term — no glossary entry needed.)

## 7. Open design decisions (for the user)

1. **Boundary: one `mcp` extension or per-server?**
   - **Recommendation: ONE `mcp` extension** managing multiple servers (like
     `lsp` manages multiple language servers). A per-server extension would
     require dynamic extension loading at runtime (not currently supported) and
     violates the "config drives everything" principle.
   - This is the user's decision per ORCHESTRATOR §1 step 3.

2. **Tool name format: `<serverId>_<toolName>` vs `<serverId>.<toolName>` vs `<serverId>/<toolName>`?**
   - **Recommendation: `<serverId>__<toolName>`** (double underscore as
     separator — single underscore is common in tool names themselves; double
     is visually distinct and unlikely to collide). The `serverId` comes from
     the config key (e.g. `"freecad"`).

3. **Stdio only in Phase 1, or stdio + HTTP?**
   - **Recommendation: stdio only in Phase 1.** HTTP transport adds SSE
     handling, reconnection, and auth. Stdio covers the two examples (freecad-mcp
     via `uvx`, chrome-devtools-mcp via `npx`). HTTP can be Phase 2.

4. **Resources/Prompts in Phase 1?**
   - **Recommendation: Tools only in Phase 1.** Resources and Prompts are
     lower value and can be added later without breaking anything.

5. **Per-conversation enable/disable surface in Phase 1?**
   - **Recommendation: No.** Per-cwd config (§2a) + the toolsFilter dropping
     disconnected servers (§2b) is sufficient for Phase 1. The surface (§2c)
     is Phase 2.

6. **Should we use the official `@modelcontextprotocol/sdk` or hand-roll?**
   - **Recommendation: Hand-roll the JSON-RPC client (like LSP).** The
     protocol is simple JSON-RPC 2.0 with `Content-Length` framing for stdio.
     The LSP extension already has a battle-tested `rpc.ts` + `framing.ts` that
     can be adapted. A dependency on the MCP SDK would pull in its transport
     abstractions, its own JSON-RPC layer, and Zod — adding weight for little
     gain (the protocol surface we need is tiny: initialize, tools/list,
     tools/call, list_changed notification). Hand-rolling also keeps the
     "zero external deps" precedent (LSP has none).
