# Handoff — MCP Status Endpoint (backend + frontend)

## Backend: `GET /conversations/:id/mcp` (transport-http)

Mirror the existing `GET /conversations/:id/lsp` endpoint exactly. The contract
types are already in `@dispatch/transport-contract` 0.22.0:

```typescript
export type McpServerState = "connecting" | "connected" | "error" | "disconnected";

export interface McpServerInfo {
	readonly id: string;
	readonly state: McpServerState;
	readonly error?: string;
	readonly toolCount: number;
	readonly configSource?: string;
}

export interface McpStatusResponse {
	readonly conversationId: string;
	readonly cwd: string | null;
	readonly servers: readonly McpServerInfo[];
}
```

### What to change in `packages/transport-http/`

1. **`src/seam.ts`** — add re-exports from `@dispatch/mcp`:
   ```typescript
   export type { McpServerStatus, McpService } from "@dispatch/mcp";
   export { mcpServiceHandle } from "@dispatch/mcp";
   ```

2. **`src/app.ts`** — add `mcpService?` to `CreateServerOptions` (optional, same
   as `lspService?`), then add the route:
   ```typescript
   app.get("/conversations/:id/mcp", async (c) => {
       // Mirror the LSP route exactly:
       // 1. Gate on persisted cwd (getCwd) — return {cwd:null, servers:[]} when null
       // 2. Resolve effective cwd (getEffectiveCwd) — return {cwd:null, servers:[]} when null
       // 3. If opts.mcpService === undefined → 503 { error: "MCP service not available" }
       // 4. Call opts.mcpService.status(effectiveCwd) → McpServerStatus[]
       // 5. Map McpServerStatus → McpServerInfo (id, state, error?, toolCount, configSource?)
       // 6. Return McpStatusResponse { conversationId, cwd: effectiveCwd, servers }
   });
   ```

3. **`src/extension.ts`** — add `host.getService(mcpServiceHandle)` alongside
   `lspService`, and pass `mcpService` to `createApp({...})`.

4. **`package.json`** — add `"@dispatch/mcp": "workspace:*"` to dependencies.

5. **Tests** — mirror the LSP status tests:
   - Returns null+empty when no persisted cwd — `mcpService.status` NOT called.
   - Returns servers when cwd is set.
   - Returns 503 when `mcpService` is undefined.
   - Maps `McpServerStatus` → `McpServerInfo` correctly (error omitted when
     undefined, configSource omitted when undefined — honor `exactOptionalPropertyTypes`).

### McpServerStatus → McpServerInfo mapping

The `McpService.status(cwd)` returns `McpServerStatus[]` from `@dispatch/mcp`:
```typescript
interface McpServerStatus {
	readonly id: string;
	readonly state: "connecting" | "connected" | "error" | "disconnected";
	readonly error?: string;
	readonly toolCount: number;
}
```
Map to `McpServerInfo` (same fields, conditionally include `error` per
`exactOptionalPropertyTypes`). Note: `McpServerStatus` does NOT have
`configSource` — that field is on `ResolvedMcpServer` (from config resolution).
If you want to include `configSource` in the status response, the `McpService`
interface or `McpServerStatus` would need to be extended. For Phase 2, omit
`configSource` (it's optional on `McpServerInfo`) unless the MCP extension is
updated to include it in the status.

---

## Frontend (dispatch-web): consume `GET /conversations/:id/mcp`

### What to do

1. **Re-pin** `@dispatch/transport-contract` to `0.22.0`.
2. **Re-mirror** the reference snapshot if one exists.
3. **Add a fetch** for `GET /conversations/:id/mcp` — mirror how `GET /conversations/:id/lsp`
   is fetched and displayed.
4. **Render** the MCP server status: each server's `id`, `state` (with the same
   connected/error/starting visual treatment as LSP), `toolCount`, and optional
   `error`.
5. Place the MCP status UI alongside (or below) the LSP status in the conversation
   settings/panel — they're sibling features.

### Response shape

```json
{
  "conversationId": "abc-123",
  "cwd": "/home/user/project",
  "servers": [
    {
      "id": "freecad",
      "state": "connected",
      "toolCount": 12
    },
    {
      "id": "chrome-devtools",
      "state": "error",
      "error": "Executable not found in $PATH: npx",
      "toolCount": 0
    }
  ]
}
```

When no cwd is set: `{ "conversationId": "abc-123", "cwd": null, "servers": [] }`.
