# FE Courier Handoff: LSP cwd resolution fix + PUT cwd workspaceId

> Backend→FE courier. The user couriers this to `../dispatch-web` (FE agent `ffe3`).
> No `@dispatch/wire` or `@dispatch/transport-contract` version bump is breaking —
> the `SetCwdRequest.workspaceId` is additive (optional); the `LspStatusResponse.cwd`
> semantics changed (was always non-null effective cwd; now null when no cwd set).

## What changed (backend)

### 1. `GET /conversations/:id/lsp` — behavior change

**Before:** The endpoint called `getEffectiveCwd(conversationId)` directly. When no
cwd was persisted, this fell through to the server default (`process.cwd()`) — so the
LSP connected on the wrong directory (the server's cwd, not the conversation's
workspace).

**After:** The endpoint now gates on the **persisted** cwd (`getCwd`) first:
- When no cwd is persisted → response is `{ cwd: null, servers: [] }` (HTTP 200, no
  LSP connection). The LSP does NOT connect when no working directory is set.
- When a cwd IS persisted → the endpoint resolves the **effective** cwd (relative cwd
  resolved against the workspace `defaultCwd`; absolute → as-is) and returns
  `{ cwd: "<effectiveCwd>", servers: [...] }`.

**FE impact:**
- `LspStatusResponse.cwd` can now be `null` (previously it was always a string, even
  when no cwd was set — it returned `process.cwd()`). The FE should handle `null` by
  showing "no LSP connected" or "set a working directory."
- When `cwd` is non-null, it is the RESOLVED (effective) cwd — an absolute path. The FE
  can display this as the directory the LSP is connected on.

### 2. `PUT /conversations/:id/cwd` — new optional `workspaceId` field

**Before:** The `PUT /conversations/:id/cwd` body was `{ cwd: string }` — only set
the persisted cwd, no workspace assignment.

**After:** The body now accepts an optional `workspaceId`:
```json
{ "cwd": "/home/user/project", "workspaceId": "my-team" }
```

When `workspaceId` is provided:
1. The conversation is assigned to that workspace (via `ensureWorkspace` +
   `setWorkspaceId`) BEFORE the cwd is persisted.
2. This ensures a subsequent `GET /conversations/:id/lsp` resolves a relative cwd
   against the workspace's `defaultCwd` (not the server default).
3. Invalid `workspaceId` (not a valid slug: lowercase `[a-z0-9-]`, 1–40 chars) →
   HTTP 400 `{ error: "Invalid workspaceId" }`.

When `workspaceId` is absent → behavior is unchanged (just `setCwd`).

**FE action:** When the user sets the working directory on a new chat tab, send the
`workspaceId` alongside the `cwd` in the `PUT /conversations/:id/cwd` request. This
ensures the LSP resolves correctly even before the first turn.

### Example flow (new chat tab)

1. User opens a new chat tab (selects workspace "my-team" with
   `defaultCwd: "/home/tradam/projects/dispatch"`)
2. User sets working dir to `"arch-rewrite"` (relative)
3. FE sends: `PUT /conversations/abc/cwd { "cwd": "arch-rewrite", "workspaceId": "my-team" }`
4. Backend: assigns conversation to workspace "my-team", then persists cwd "arch-rewrite"
5. FE calls: `GET /conversations/abc/lsp`
6. Backend: `getCwd("abc")` → `"arch-rewrite"` (non-null) → `getEffectiveCwd("abc")` →
   resolves "arch-rewrite" against workspace "my-team"'s `defaultCwd`
   (`"/home/tradam/projects/dispatch"`) → `"/home/tradam/projects/dispatch/arch-rewrite"`
7. Response: `{ cwd: "/home/tradam/projects/dispatch/arch-rewrite", servers: [...] }`

Without the `workspaceId` on the PUT (step 3), the conversation would be in the
`"default"` workspace (defaultCwd: null), and the relative cwd "arch-rewrite" would
resolve against `process.cwd()` — the wrong directory.

## Contract version

`@dispatch/transport-contract` bumped to `0.17.0` (additive: `SetCwdRequest.workspaceId`
is optional; `LspStatusResponse.cwd` comment updated — no field type change).
