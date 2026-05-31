# Implementation Plan: User Agents

## Summary

Two changes rolled into one:

1. **`agent` becomes required** on `summon` — all spawned agents must use a definition
2. **New `top_level` mode** — spawns independent "user agent" tabs, gated by a new `perm_user_agent` permission

A **user agent** is a top-level, independent tab spawned by an AI agent via the `summon` tool. Unlike **subagents** (child tabs owned by a parent), user agents appear as first-class tabs — persistent, independent lifecycle, no parent. They are fire-and-forget: the spawning agent gets an `agent_id` back but cannot `retrieve` the result.

User agents **must** be spawned from a non-subagent agent definition (e.g. `default`). The definition controls their tools, models, working directory, and system prompt. Tools are still intersected with the spawning agent's own tools (can't escalate). A new `perm_user_agent` permission gates access to this capability, surfaced as a separate checkbox in the Tool Permissions UI.

---

## Current Architecture (for context)

Today, the `summon` tool creates **subagent tabs**:

- They have a `parentTabId` linking them to the spawning tab
- They show in a **bottom row** under the parent tab in the tab bar
- They're **non-persistent** by default (italic, faded) until promoted
- Their **tools are restricted** — intersected with the parent's tool set (can't escalate)
- Their **working directory** must be within the parent's working directory
- They have **completion tracking** (`completionPromise`) — the parent blocks on `retrieve` until the child finishes
- The `agent` parameter is currently optional — agents can be spawned ad-hoc with just a `tools` list, inheriting the parent's model

### Comparison table

| Property | Subagent (current & updated) | User Agent (new) |
|---|---|---|
| `parentTabId` | set to parent | `null` |
| `persistent` | `false` (promoted on click) | `true` |
| Tab bar position | Bottom row under parent | Top row with user tabs |
| Tab lifecycle | Closed when parent closes | Independent |
| Retrievable | Yes, via `retrieve` tool | No — fire-and-forget |
| Working directory | Must be within parent's dir | Any dir (from definition or default) |
| Completion tracking | Yes (`completionPromise`) | No |
| Agent definition | Required | Required (`is_subagent !== true`) |
| Models | From agent definition | From agent definition |

---

## Summon tool — new parameter shape

```
summon({
  task: string,               // required — what to do
  agent: string,              // required — agent definition slug (was optional)
  top_level?: boolean,        // optional — spawn as user agent (only in schema if perm_user_agent enabled)
  tools?: string[],           // optional — override tools (intersected with spawning agent's tools)
  background?: boolean,       // optional — for subagents only (user agents are always fire-and-forget)
  working_directory?: string  // optional — override the definition's cwd
})
```

### Tools resolution

- **`tools` omitted**: agent definition's tools ∩ spawning agent's tools
- **`tools` provided**: provided tools ∩ spawning agent's tools

Models always come from the agent definition.

---

## Changes by file

### 1. `packages/core/src/tools/summon.ts`

**Schema changes:**

- `agent` — change from `.optional()` to required
- `top_level` — new `z.boolean().optional()`, **only included in the schema when `userAgentEnabled` is `true`**
- `tools` — stays optional. Description updated: "Defaults to the agent definition's tools. Intersected with the spawning agent's tools."
- `background` — stays optional, ignored when `top_level: true`
- `working_directory` — stays optional

**Factory signature change:**

```ts
createSummonTool(
  defaultWorkingDirectory: string,
  callbacks: SummonCallbacks,
  availableSubagents: AvailableAgent[],   // is_subagent === true
  availableUserAgents: AvailableAgent[],  // is_subagent !== true
  agentDirs: string[],
  userAgentEnabled: boolean,              // new — controls whether top_level param + user agent catalog exist
)
```

**`SummonCallbacks.spawn` interface:**

- Add `topLevel?: boolean` to the spawn options object

**`buildAgentsCatalog` update:**

The catalog in the tool description is built conditionally:

- **When `userAgentEnabled` is `false`**: only show the subagents group:
  ```
  Available agents:
    - programmer: Programmer — Implements code from a given plan
    - flash: Flash — A cheap subagent
  ```

- **When `userAgentEnabled` is `true`**: show two labeled groups:
  ```
  Subagents (spawned as child tabs):
    - programmer: Programmer — Implements code from a given plan
    - flash: Flash — A cheap subagent

  User agents (spawned as independent top-level tabs, requires top_level=true):
    - default: Default — Default agent with all tools enabled
  ```

**`toAvailableAgents` → split into two functions:**

- Rename existing to `toAvailableSubagents()` — keeps `is_subagent === true` filter
- New `toAvailableUserAgents()` — filters `is_subagent !== true`

**Execute logic when `top_level: true`:**

- Always return immediately with `agent_id` (fire-and-forget, ignore `background`)
- Call `callbacks.spawn(...)` with `topLevel: true`

---

### 2. `packages/core/src/index.ts`

- Re-export renamed `toAvailableSubagents` and new `toAvailableUserAgents`

---

### 3. `packages/api/src/agent-manager.ts`

**`getOrCreateAgentForTab` — permission reading & tool construction:**

- Read new setting: `const permUserAgent = getSetting("perm_user_agent") === "allow"`
- Include `permUserAgent` in the `permKey` cache-invalidation string
- Load user agent definitions via `toAvailableUserAgents(...)`
- Pass `userAgentEnabled: permUserAgent` and `availableUserAgents` to `createSummonTool`

**`spawnChildAgent` — when `topLevel: true`:**

- **`parentTabId`**: pass `null` to `createTab()` and the `tab-created` event
- **Working directory**: use the agent definition's `cwd` if set, otherwise the global default (`DISPATCH_WORKING_DIR` / `process.cwd()`). **No containment check** against parent's directory.
- **Tools**: from definition (or `tools` param if provided), intersected with spawning agent's tools. Same intersection logic as subagents — can't escalate.
- **Models**: from the agent definition's `models` array
- **No completion tracking**: skip `completionPromise` / `completionResolve` setup. Leave them `undefined`.

**`getChildResult` guard:**

- If the tab has no `completionPromise` and status is `running`, return error: `"This is a user agent (top-level tab) and cannot be retrieved. User agents are fire-and-forget."`

---

### 4. `packages/frontend/src/lib/components/ToolPermissions.svelte`

Add a new entry to the `toolPermissions` array:

```ts
{
  id: "user_agent",
  label: "Spawn user agents",
  description: "Allow the AI to open new independent top-level tabs"
}
```

---

### 5. `packages/frontend/src/lib/settings.svelte.ts`

Add `user_agent: false` to the default `toolPerms` and `savedToolPerms` objects.

---

## Files NOT changing

| File | Why |
|---|---|
| `packages/frontend/src/lib/components/TabBar.svelte` | Already renders `parentTabId === null` tabs in top row as persistent |
| `packages/frontend/src/lib/tabs.svelte.ts` (`tab-created` handler) | Already sets `persistent: parentTabId == null` |
| `packages/core/src/tools/retrieve.ts` | Unchanged — the retrieve guard lives in AgentManager |
| `packages/core/src/agents/loader.ts` | `is_subagent` already exists and distinguishes the two types |
| DB schema | The `settings` table is key-value, no migration needed |
| Agent definition TOML format | `is_subagent` already exists |

---

## Complete file change list

| File | Change |
|---|---|
| `packages/core/src/tools/summon.ts` | `agent` required, conditional `top_level` param, two-group catalog (subagents-only when no perm), `toAvailableSubagents()` + `toAvailableUserAgents()`, spawn interface update |
| `packages/core/src/index.ts` | Re-export new/renamed functions |
| `packages/api/src/agent-manager.ts` | Read `perm_user_agent`, pass to factory, handle `topLevel` in spawn, retrieve guard |
| `packages/frontend/src/lib/components/ToolPermissions.svelte` | Add "Spawn user agents" checkbox |
| `packages/frontend/src/lib/settings.svelte.ts` | Add `user_agent` default |

---

## Risks / edge cases

- **Nested user agents**: A user agent could itself have `perm_user_agent` and spawn more user agents. This is allowed and works naturally since user agents are independent tabs with no parent chain.
- **Agent definition with no models**: Should not happen in practice — the Agent Builder UI requires at least one model entry. But if it does, the spawn will fail at the model-resolution step with a clear error.
- **Retrieve on user agent**: Guarded in `getChildResult` — returns an error message explaining user agents are fire-and-forget.
