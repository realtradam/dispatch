# FE handoff — heartbeat `inactiveOnly` (skip while workspace is busy)

Courier this to `../frontend` (cross-repo contract change; `lsp references` does not span
repos — ORCHESTRATOR §7). All changes are ADDITIVE — nothing existing breaks. The new
field has a default, so a frontend that never sends it gets the new behavior automatically.

## What shipped (backend)

A new per-workspace heartbeat setting, **`inactiveOnly`**: when on (the default), the
heartbeat SKIPS a fire whenever the configured workspace has any active agents — i.e. a
conversation whose persisted status is `"active"` (driving a turn) or `"queued"` (waiting on
the message queue). The heartbeat stays quiet while the user is actively working and only
fires when the workspace is idle.

The spawned heartbeat conversation lives in the DEDICATED heartbeat workspace (not the
configured one), so a heartbeat run never counts as an "active agent" of the configured
workspace — there is no self-block.

## The setting

```ts
// @dispatch/transport-contract  (HeartbeatConfig)
interface HeartbeatConfig {
  enabled: boolean;
  inactiveOnly: boolean;      // ← NEW. default: true
  systemPrompt: string;
  taskPrompt: string;
  intervalMinutes: number;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}
```

- **Name:** `inactiveOnly`
- **Type:** `boolean`
- **Default:** `true` (the heartbeat is quiet-by-default while the workspace is busy)
- **Semantics:**
  - `true` → before each scheduled fire, the backend checks the configured workspace for
    active agents. If any exist, the fire is **silently skipped** (no run is recorded, no
    `HeartbeatRun` created). The scheduler re-arms and tries again at the next
    `intervalMinutes` interval.
  - `false` → the heartbeat fires unconditionally on every interval, regardless of
    workspace activity (the pre-existing behavior).
- **What counts as an "active agent":** any conversation in the configured workspace whose
  persisted `ConversationStatus` is `"active"` or `"queued"`. The orchestrator sets
  `"active"` when a turn starts and `"idle"` when it settles, so this is the live
  busy/idle signal.
- **Self-block safety:** heartbeat-spawned conversations are filed in the `heartbeat`
  workspace, so an in-flight heartbeat run does NOT keep the configured workspace "busy".

## API endpoints

The setting rides on the existing heartbeat config endpoints — no new routes.

### Read

`GET /workspaces/:id/heartbeat` → `HeartbeatConfig` (200)

The response now includes `inactiveOnly`. For a workspace that never configured a
heartbeat, the full default config is returned (`enabled: false`, `inactiveOnly: true`,
`intervalMinutes: 30`, …).

### Update

`PUT /workspaces/:id/heartbeat` with a partial `UpdateHeartbeatRequest` body → `HeartbeatConfig` (200)

```ts
// @dispatch/transport-contract  (UpdateHeartbeatRequest)
interface UpdateHeartbeatRequest {
  enabled?: boolean;
  inactiveOnly?: boolean;      // ← NEW. optional; absent = unchanged
  systemPrompt?: string;
  taskPrompt?: string;
  intervalMinutes?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
}
```

All fields optional (a partial update); only provided fields are applied. Absent
`inactiveOnly` leaves it unchanged (distinct from sending `false`).

**Validation:** `inactiveOnly` must be a JSON `boolean` when present. A non-boolean
(e.g. `"yes"`, `1`) → HTTP 400 `{ error: "Field 'inactiveOnly' must be a boolean" }`.
The service is NOT called on validation failure.

**Example:**

```http
PUT /workspaces/proj/heartbeat
Content-Type: application/json

{ "inactiveOnly": false }
```

```json
200 OK
{
  "enabled": false,
  "inactiveOnly": false,
  "systemPrompt": "",
  "taskPrompt": "",
  "intervalMinutes": 30,
  "model": "",
  "reasoningEffort": null
}
```

## Frontend implementation notes

- Render a **checkbox** (default checked) in the workspace heartbeat settings UI, labelled
  something like "Only run when the workspace is idle" / "Pause while agents are active".
- The checkbox reflects and edits `inactiveOnly` on the heartbeat config.
- On toggle, send `PUT /workspaces/:id/heartbeat` with `{ inactiveOnly: <bool> }` (a partial
  update — no need to send the rest of the config).
- A skipped fire produces **no `HeartbeatRun`**, so the runs list (`GET
  /workspaces/:id/heartbeat/runs`) and the next-run countdown (`GET
  /workspaces/:id/heartbeat/next-run`) behave exactly as on any other idle interval: the
  next-run timestamp advances to `now + intervalMinutes`. No new event type is emitted on a
  skip (it is silent); the backend logs it at `info` level only.
- Legacy workspaces: a config persisted by an older backend (no `inactiveOnly` field) is
  read back as `inactiveOnly: true` (the default) — the feature is ON by default for
  everyone, including pre-existing workspaces.

## Versions / deps

The new field is added to `HeartbeatConfig` / `UpdateHeartbeatRequest` in
`@dispatch/transport-contract`. It is a purely additive field with a default, so no
version bump of the pinned `file:` dependency is strictly required to keep working — but
bump it when convenient to pick up the typed field.
