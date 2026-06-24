# Plan — MCP (Model Context Protocol) Integration

> **Status:** PROPOSED — awaiting user approval of design decisions (§7 of
> `notes/mcp-design.md`).
> Design: `notes/mcp-design.md`.

## Decisions (to confirm with user)

1. **One `mcp` extension** managing multiple servers (like `lsp`).
2. **Tool name format:** `<serverId>__<toolName>` (double-underscore separator).
3. **Phase 1: stdio transport only** (covers freecad-mcp + chrome-devtools-mcp).
4. **Phase 1: Tools only** (no Resources/Prompts).
5. **Phase 1: no enable/disable surface** (per-cwd config is sufficient).
6. **Hand-rolled JSON-RPC** (adapt LSP's rpc.ts + framing.ts; no MCP SDK dep).

## Implementation waves

### Wave 0: Orchestrator (contracts + wiring)

| What | File | Change |
|---|---|---|
| No kernel contract change needed | — | The existing `ToolContract` + `host.defineTool()` + `host.getTools()` + `toolsFilter` + `ToolAssembly` are sufficient. MCP tools are just `ToolContract`s registered at runtime. |
| Glossary | `GLOSSARY.md` | Add `MCP`, `MCP server`, `MCP host` (see design §6). |
| Root tsconfig | `tsconfig.json` | Add `@dispatch/mcp` project reference (after Wave 1). |
| host-bin registration | `packages/host-bin/src/main.ts` | Register `mcpExt` in `CORE_EXTENSIONS` (same pattern as `lspExt`). |
| `bun install` | `bun.lock` | Link the new workspace package. |

> **No `@dispatch/transport-contract` or `@dispatch/wire` version bump** in Phase 1.
> MCP tools are transparent to the wire (they're just tools the model calls).
> A future surface (enable/disable, status endpoint) would bump versions.

### Wave 1: `packages/mcp/` (single unit — the extension)

This is the main implementation. One owner-agent builds the entire `packages/mcp/`
directory. It depends only on `@dispatch/kernel` (contracts) and
`@dispatch/session-orchestrator` (for the `toolsFilter` handle).

| File | Responsibility |
|---|---|
| `src/framing.ts` | `Content-Length` framing for stdio (adapt from LSP's framing.ts — encode/decode). PURE. |
| `src/framing.test.ts` | Unit tests for encode/decode. |
| `src/rpc.ts` | JSON-RPC 2.0 client: `request(method, params) → result`, `notify(method, params)`, `onNotification(method, handler)`. Adapts LSP's rpc.ts. PURE (injected `writeFn`). |
| `src/rpc.test.ts` | Unit tests for request/response/notification handling. |
| `src/transport.ts` | Transport abstraction: `StdioTransport` (spawn child, pipe stdin/stdout through framing + rpc) + the interface for a future `HttpTransport`. Injected `spawn` (like LSP). |
| `src/transport.test.ts` | Tests against an in-memory pipe pair (no real spawn). |
| `src/client.ts` | MCP client: `initialize()` (send proto version + caps, receive server caps), `listTools()` → `tools/list`, `callTool(name, args, signal)` → `tools/call`, listen for `notifications/tools/list_changed`. Tracks connection state. |
| `src/client.test.ts` | Tests with a mock JSON-RPC connection (injected transport). |
| `src/config.ts` | PURE config resolution: `.dispatch/mcp.json` → `opencode.json` `mcp` key. Returns `ResolvedMcpServer[]` + `shadowed` flag. Mirrors LSP config.ts. |
| `src/config.test.ts` | Config resolution tests (precedence, shadow, empty). |
| `src/registry.ts` | Tool name namespacing (`<serverId>__<toolName>`) + `adaptTool(serverId, mcpTool, client)` → `ToolContract`. The `execute()` proxies to `client.callTool()` and flattens MCP content to a string. PURE (injected client). |
| `src/registry.test.ts` | Tests for namespacing, content flattening, error handling. |
| `src/manager.ts` | `McpManager`: one client per server config; lazy-spawn on first access; `status(cwd)`; `getClient(serverId)`; `shutdownAll()`. Mirrors LSP manager.ts. Injected spawn + logger. |
| `src/manager.test.ts` | Manager lifecycle tests (lazy spawn, shutdown, broken server). |
| `src/types.ts` | `McpServerConfig`, `McpServerStatus`, `McpService`, `McpToolInfo`, `McpContentItem`. |
| `src/extension.ts` | manifest + `activate(host)`: real spawn adapter, config resolution per-cwd, manager, register tools via `host.defineTool` (on connect + on `list_changed`), register `toolsFilter` (drop tools from disconnected servers), `mcpServiceHandle`, `deactivate()`. |
| `src/index.ts` | Public surface exports. |

**Scoping rules for the summon:**
- `.dispatch/package-agent.md` + `.dispatch/extension-agent.md`
- `.dispatch/rules/`: `one-owner.md`, `isolation-over-dry.md`, `biome-clean.md`,
  `pure-core.md`, `no-internal-mocks.md`, `typed-handles.md`,
  `extension-logging.md`.

**Key guidance for the agent:**
- Read `packages/lsp/src/` (framing.ts, rpc.ts, config.ts, manager.ts,
  extension.ts) as the architectural precedent — same pattern, simpler protocol.
- Read `packages/kernel/src/contracts/tool.ts` for `ToolContract`.
- Read `packages/kernel/src/contracts/extension.ts` for `HostAPI`,
  `defineTool`, `addFilter`, `provideService`, `defineService`.
- Read `packages/session-orchestrator/src/tools-filter.ts` for `ToolAssembly`
  + `toolsFilter`.
- The MCP `initialize` flow: send `{ method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name:
  "dispatch", version: "0.0.0" } } }`, receive server capabilities, then send
  `notifications/initialized`.
- `tools/list` returns `{ tools: [{ name, description, inputSchema }] }`.
- `tools/call` takes `{ name, arguments }` and returns `{ content: [...],
  isError?: boolean }`.
- Tool names must be namespaced `<serverId>__<toolName>`.
- `concurrencySafe: false` on all MCP-adapted tools (conservative — MCP servers
  are generally stateful single-client processes).
- `Content-Length` framing for stdio (same as LSP — the MCP spec inherited
  this from LSP).
- No external dependencies — hand-roll the JSON-RPC + framing (adapt LSP's).

### Wave 2: host-bin registration (orchestrator)

After Wave 1 is verified in isolation:
- Add `@dispatch/mcp` to root `tsconfig.json` project references.
- `bun install` to link the workspace package.
- Register `mcpExt` in `CORE_EXTENSIONS` in `packages/host-bin/src/main.ts`.
- Verify: `tsc -b` EXIT 0, biome clean, full vitest pass.

### Wave 3: Live verification (orchestrator)

- Boot the dev stack (`bin/up`).
- Create a `.dispatch/mcp.json` in a test cwd with a simple MCP server
  (e.g. a trivial stdio server that exposes one tool).
- Verify: `GET /conversations/:id/lsp`-equivalent — actually, verify by
  sending a chat that triggers the model to call the MCP tool.
- Or: test with chrome-devtools-mcp (`npx chrome-devtools-mcp`) if available.
- Confirm: the model sees the MCP tool, calls it, gets a result.
- Clean up test config.

## Test strategy (per the asymmetric testing rule)

- **Pure core** (framing, rpc, config, registry, types): zero internal mocks,
  high coverage. The RPC + framing tests use in-memory pipe pairs (injected
  transport, not mocked `@dispatch/*`). Config tests use string fixtures.
- **Shell** (transport, manager, extension): integration tests against
  in-memory/real child processes. A few tests, not exhaustive unit coverage.
  Do NOT mock sibling extensions.

## Estimated size

- ~12 source files + ~11 test files.
- Closest precedent: `packages/lsp/` (~20 files). MCP is simpler (no
  diagnostics, no incremental sync, no file watching, no sidecars).
- Expected test count: ~60-80 new tests.

## What is explicitly OUT of scope for Phase 1

- Streamable HTTP transport (Phase 2).
- MCP Resources and Prompts primitives (Phase 2).
- Client → Server capabilities (sampling, roots, elicitation) (Phase 2+).
- Per-conversation enable/disable surface + transport endpoints (Phase 2).
- Tool poisoning / rug-pull hash validation (security hardening, Phase 2).
- `mcp-scan`-style static analysis (Phase 2+).
