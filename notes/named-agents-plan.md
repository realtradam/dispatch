# Named Agents — Feature Plan

> **Status:** Approved product direction; planning only.
>
> This document describes the intended behavior and implementation plan for the
> Named Agents feature across the Dispatch backend and frontend. It does not
> contain feature implementation.

## 1. Problem

Selecting a model when one agent summons another is currently too slow and too
complex:

- `list_agent_models` exposes a large raw catalog containing models from every
  configured provider and credential.
- Discovering the catalog performs live provider requests and can take a long
  time.
- The calling agent must choose among too many options and can select a model the
  user did not intend.
- `summon_agent` currently validates a raw model against the catalog, adding more
  provider-discovery latency.

The user should instead curate a small set of reusable **Named Agents**. Each
Named Agent gives a friendly name to one provider/model combination.

Example:

```text
Coding Agent   -> opencode-1/claude-sonnet-4.5
Research Agent -> umans/umans-glm-5.2
Fast Agent     -> hyper/some-fast-model
```

Agents listing summon options should receive only these curated Named Agents,
immediately, without querying provider catalogs.

## 2. Goals

1. Let the user create, edit, and remove Named Agents in the frontend.
2. Store a friendly name and one provider/model selection for each Named Agent.
3. Auto-save edits without requiring a separate Save button.
4. Return the locally stored Named Agents from `list_agent_models` instead of
   returning the full raw model catalog.
5. Let `summon_agent` select a Named Agent by name and resolve it locally to its
   configured raw model.
6. Make Named Agents available in the regular frontend model selector through a
   synthetic **Named Agents** provider shown at the top of the provider list.
7. Use snapshot semantics when a Named Agent is selected for a conversation.
8. Preserve the raw model catalog for configuration, compatibility, and internal
   backend consumers.

## 3. Non-goals for the first version

The MVP will not add:

- System prompts or task instructions to Named Agent definitions.
- Per-agent working directories, computers, workspaces, or titles.
- Tool allow/deny lists beyond existing summon behavior.
- Background catalog refresh or complex stale-model detection.
- A CLI for Named Agent management.
- Automatic generation or seeding of Named Agents.
- Changes to the provider credential-management system.

The initial persisted definition should stay intentionally small:

```ts
interface NamedAgent {
  id: string;
  name: string;
  model: string; // Canonical "<provider-or-credential>/<model>" value
}
```

The frontend may split `model` into provider and model controls for editing, but
the persisted model remains the canonical combined model identifier.

## 4. Product terminology

### Named Agent

A **Named Agent** is a user-defined, persisted model preset consisting of a name
and an underlying model.

It is not a running agent or conversation.

### Subagent

A **subagent** is the conversation created when `summon_agent` is called. A Named
Agent can determine which model that subagent uses.

## 5. Frontend: Named Agents sidebar view

Add **Named Agents** as a collapsible dropdown view in the sidebar.

### 5.1 Collapsed state

```text
┌────────────────────────────────────────┐
│ DISPATCH                               │
├────────────────────────────────────────┤
│                                        │
│ Conversations                      ▾   │
│   General                              │
│   Feature planning                     │
│                                        │
│ Named Agents                       ▸   │
│                                        │
├────────────────────────────────────────┤
│ Settings                           ▸   │
└────────────────────────────────────────┘
```

### 5.2 Expanded state

```text
┌────────────────────────────────────────┐
│ DISPATCH                               │
├────────────────────────────────────────┤
│                                        │
│ Conversations                      ▾   │
│   General                              │
│   Feature planning                     │
│   Bug investigation                    │
│                                        │
│ Named Agents                       ▾   │
│                                        │
│   ┌────────────────────────────────┐   │
│   │ Name                           │   │
│   │ [ Coding Agent               ] │   │
│   │                                │   │
│   │ Provider                       │   │
│   │ [ opencode-1               ▾ ] │   │
│   │                                │   │
│   │ Model                          │   │
│   │ [ claude-sonnet-4.5        ▾ ] │   │
│   │                                │   │
│   │ Saved                 [Remove] │   │
│   └────────────────────────────────┘   │
│                                        │
│   ┌────────────────────────────────┐   │
│   │ Name                           │   │
│   │ [ Research Agent             ] │   │
│   │                                │   │
│   │ Provider                       │   │
│   │ [ umans                    ▾ ] │   │
│   │                                │   │
│   │ Model                          │   │
│   │ [ umans-glm-5.2            ▾ ] │   │
│   │                                │   │
│   │ Saved                 [Remove] │   │
│   └────────────────────────────────┘   │
│                                        │
│   [ + Add Named Agent ]                │
│                                        │
├────────────────────────────────────────┤
│ Settings                           ▸   │
└────────────────────────────────────────┘
```

Provider and model controls are stacked vertically because the sidebar is
narrow and provider/model names can be long.

### 5.3 Adding an item

Clicking **Add Named Agent** immediately appends a blank editable card:

```text
│ Named Agents                       ▾   │
│                                        │
│   ┌────────────────────────────────┐   │
│   │ Name                           │   │
│   │ [ Enter a name…              ] │   │
│   │                                │   │
│   │ Provider                       │   │
│   │ [ Select provider…         ▾ ] │   │
│   │                                │   │
│   │ Model                          │   │
│   │ [ Select provider first    ▾ ] │   │
│   │                                │   │
│   │ Not saved             [Remove] │   │
│   └────────────────────────────────┘   │
│                                        │
│   [ + Add Named Agent ]                │
```

The model dropdown remains disabled until a provider is selected. Once a
provider is selected, the model dropdown contains only models belonging to that
provider.

### 5.4 Editing and auto-save

There is no explicit Save button.

- Changing the provider saves immediately after a valid model is selected.
- Changing the model saves immediately.
- Editing the name saves after a short debounce, approximately 300–500 ms.
- The card displays a small status:
  - `Not saved`
  - `Saving…`
  - `Saved`
  - `Save failed` with an available retry action
- The frontend should update optimistically where safe, but retain or restore
  the last persisted value if the request fails.
- Rapid edits to the same card must not allow an older response to overwrite a
  newer value.

A new card is not a usable Named Agent until all required values are valid:

- The name is nonempty.
- The name is unique, case-insensitively.
- A provider is selected.
- A model is selected.

Implementation may either create the record only after the form first becomes
valid or create a client-only draft and POST it once complete. Incomplete drafts
must not appear in agent tools or the regular model selector.

### 5.5 Changing providers

When the provider changes:

1. Clear the previous model if it does not belong to the new provider.
2. Populate the model dropdown with models from the new provider only.
3. Do not persist an invalid provider/model combination.
4. Show `Not saved` until a valid model is selected.

### 5.6 Removing an item

Each card has a **Remove** button.

Removing a Named Agent should:

- Delete it from persisted configuration.
- Remove it from the sidebar list.
- Remove it immediately from the synthetic Named Agents provider in model
  selectors.
- Remove it immediately from `list_agent_models` results.
- Not alter existing conversations that previously selected it, because those
  conversations use snapshot semantics.

A lightweight confirmation may be used if accidental deletion is a concern, but
it should not make routine editing cumbersome.

### 5.7 Empty state

When no Named Agents exist, keep the sidebar section and Add button visible:

```text
│ Named Agents                       ▾   │
│                                        │
│   No named agents yet.                 │
│                                        │
│   [ + Add Named Agent ]                │
```

This keeps the feature discoverable.

## 6. Frontend: regular model selector integration

The existing model selector has a provider dropdown followed by a model
dropdown. Add **Named Agents** as a synthetic provider at the top of the provider
list.

```text
Provider
────────────────
Named Agents
opencode-1
opencode-2
umans
hyper
…
```

When **Named Agents** is selected, the model dropdown displays Named Agent names
instead of raw model names:

```text
Model
────────────────
Coding Agent
Research Agent
Fast Agent
Vision Agent
```

Requirements:

- **Named Agents** is always the first provider option.
- The remaining providers retain their current ordering and behavior.
- Selecting a Named Agent resolves it to the configured raw model.
- The UI displays the selection as `Named Agents -> <name>`.
- If there are no Named Agents, keep the provider visible and show a disabled
  `No named agents configured` option in the model dropdown.
- Named Agent CRUD updates all open selectors without requiring a full page
  reload.

## 7. Snapshot semantics

Selecting a Named Agent for a conversation creates a snapshot of the selection.
The conversation should retain:

```ts
interface NamedAgentSelectionSnapshot {
  namedAgentId: string;
  namedAgentName: string;
  model: string;
}
```

The raw `model` is the actual provider/model used by the conversation. The ID and
name preserve how the user selected it and allow the UI to continue displaying
the friendly Named Agent label.

After selection:

- Renaming the Named Agent does not rename the selection shown on an existing
  conversation.
- Changing the Named Agent's model does not change the model used by an existing
  conversation.
- Removing the Named Agent does not break or alter an existing conversation.
- New conversations receive the latest saved definition.

This avoids retroactively changing conversation behavior when a shared preset is
edited.

If loading an older or externally created conversation that contains only a raw
model, the selector continues displaying it through the existing raw provider
and model behavior.

## 8. Agent-facing tool behavior

### 8.1 `list_agent_models`

Change the agent-facing list operation to return only configured Named Agents.
It must read local persisted configuration and must not query provider model
catalogs.

Conceptual result:

```text
Available named agents (3):
  coding     (opencode-1/claude-sonnet-4.5)
  research   (umans/umans-glm-5.2)
  fast       (hyper/some-fast-model)
```

The exact tool name can remain `list_agent_models` for compatibility, but its
description and response must clearly say it lists **Named Agents available for
summoning**, not the complete raw catalog.

Existing query and limit filtering may be retained if useful, but filtering is
performed only over the small local Named Agent list. Vision filtering should
not trigger live provider catalog requests. If no locally available metadata can
support a filter, omit that filter from the Named Agent tool contract rather
than reintroducing the slow path.

When no Named Agents are configured, return immediately with clear guidance:

```text
No named agents are configured. Ask the user to add one in the Named Agents
sidebar view.
```

Do not fall back automatically to the full catalog.

### 8.2 `summon_agent`

Add a Named Agent selector to the summon contract:

```ts
interface SummonAgentInput {
  agent?: string; // Named Agent name or stable ID, resolved locally
  model?: string; // Backward-compatible raw-model escape hatch
  task: string;
  // Existing summon fields remain unchanged.
}
```

Behavior:

1. When `agent` is supplied, resolve it from local Named Agent storage.
2. Use its current configured raw model for the newly created subagent.
3. Do not request the full provider catalog merely to validate the mapping.
4. Snapshot the Named Agent name, ID, and resolved raw model onto the resulting
   conversation.
5. If the Named Agent does not exist, return an `unknown-agent` error with the
   locally available names.
6. Keep `model` as a backward-compatible raw-model escape hatch for internal and
   programmatic callers.
7. Require exactly one effective selection: a Named Agent or a raw model.

The AI-facing tool description should direct agents to:

1. Call `list_agent_models`.
2. Select one of the returned Named Agents.
3. Pass that Named Agent to `summon_agent`.

It should not encourage guessing raw provider/model identifiers.

## 9. Persistence and API

Persist Named Agents in the backend's existing SQLite-backed storage. Named
Agents are global user configuration in the MVP rather than per-workspace or
per-conversation records.

Use stable generated IDs so renaming does not require identity-by-name and so
frontend auto-save operations can safely target one record.

Recommended HTTP surface:

```text
GET    /named-agents
POST   /named-agents
PUT    /named-agents/:id
DELETE /named-agents/:id
```

Example record:

```json
{
  "id": "named-agent-id",
  "name": "Coding Agent",
  "model": "opencode-1/claude-sonnet-4.5"
}
```

Example list response:

```json
{
  "namedAgents": [
    {
      "id": "named-agent-id",
      "name": "Coding Agent",
      "model": "opencode-1/claude-sonnet-4.5"
    }
  ]
}
```

API validation:

- `name` must be trimmed and nonempty.
- Names must be unique case-insensitively.
- `model` must be a syntactically valid canonical model identifier.
- Create/update should reject duplicate names with a specific conflict error.
- Update and delete should return a specific not-found error for unknown IDs.
- API responses should return the canonical saved record.

The configuration UI may use the existing full `GET /models` catalog to
populate provider and model dropdowns. Catalog latency is acceptable during
human configuration and must not affect the agent-list or named-agent summon hot
paths.

## 10. Backend architecture plan

### 10.1 Named Agent registry

Add a backend-owned registry responsible for:

- Listing Named Agents from local persistence.
- Looking up a Named Agent by ID or normalized name.
- Creating, updating, and deleting records.
- Enforcing name uniqueness and record validation.
- Exposing a typed service to agent management and HTTP transport.

Keep validation and normalization as pure logic. Keep storage and HTTP as thin
imperative boundaries.

Whether this registry lives in a small dedicated package or inside the existing
agent-management package should follow the backend's established extension
boundaries. The important contract is that agent-management can read it locally
without calling the provider catalog.

### 10.2 Agent-management integration

Update agent-management so:

- `list_agent_models` reads from the Named Agent registry.
- Named Agent listing never calls `credentialStore.listCatalog()` or
  `getModelInfo()`.
- `summon_agent` resolves an `agent` locally.
- Named Agent summon validation never calls the complete provider catalog.
- The existing raw-model path remains available for compatibility.

### 10.3 Preserve raw catalog consumers

Do not replace the credential store's raw catalog globally. It remains the source
for:

- Populating provider/model controls while configuring a Named Agent.
- Existing raw model selection.
- Internal vision handoff and other programmatic model-resolution behavior.
- Model metadata needed elsewhere in Dispatch.

Only the agent-facing discovery and Named Agent summon paths switch to local
Named Agent configuration.

## 11. Frontend architecture plan

Add a focused Named Agents feature module with:

- Pure view-model logic for splitting canonical model names into provider/model
  controls.
- Pure validation for required fields and case-insensitive unique names.
- API adapters for list/create/update/delete.
- Sidebar accordion/dropdown UI.
- Reusable local state shared with the regular model selector.
- Debounced, race-safe auto-save behavior.

Reuse the existing provider/model parsing and selection helpers where possible.
Do not maintain a second incompatible model-name parser.

The model selector should treat **Named Agents** as a synthetic presentation
provider. It must not merge Named Agents into the backend's raw provider catalog
or pretend that Named Agents are real provider credentials.

## 12. Error and edge-case behavior

### Configuration errors

- Duplicate name: keep the card editable, display an inline uniqueness error,
  and do not overwrite another record.
- Empty name: show an inline required-field error after interaction.
- Provider load failure: show the catalog error while retaining persisted cards.
- Save failure: retain the attempted edit, show `Save failed`, and allow retry.
- Delete failure: restore or retain the card and show the error.

### Missing or changed models

The MVP does not perform live catalog validation every time a Named Agent is
listed or summoned. This is intentional.

- If a configured model later disappears, the Named Agent remains visible.
- A summon attempts the saved raw model directly.
- If the provider rejects it, surface the provider error clearly.
- Editing the card lets the user choose a replacement from the current catalog.

This preserves the required instant local list/summon behavior.

### Concurrent changes

- Use stable IDs for updates and deletion.
- The frontend must prevent stale auto-save responses from replacing newer
  edits.
- Backend name uniqueness is authoritative even if two clients edit at once.

## 13. Compatibility and migration

- Existing conversations storing only raw model identifiers remain valid.
- Existing internal callers of `summon_agent` may continue using `model`.
- Existing `GET /models` behavior remains unchanged.
- Existing provider credentials remain unchanged.
- No existing conversation data must be rewritten.
- Named Agent selection metadata is additive.
- An empty registry does not invoke the old slow catalog fallback.

## 14. Testing plan

### Backend

Test:

- Create, list, update, and remove Named Agents.
- Case-insensitive unique-name enforcement.
- Required name and model validation.
- Lookup by stable ID and normalized name.
- `list_agent_models` returns only persisted Named Agents.
- Empty Named Agent list returns immediate setup guidance.
- Listing Named Agents performs zero provider catalog calls.
- Summoning by Named Agent resolves the saved raw model.
- Summoning by Named Agent performs zero catalog-validation calls.
- Unknown Named Agent returns `unknown-agent`.
- Raw `model` compatibility remains functional.
- Existing vision/internal raw-catalog consumers remain unchanged.
- Snapshot metadata is attached to the created conversation.
- Editing or deleting a Named Agent does not mutate existing conversation
  snapshots.
- HTTP CRUD success, validation, conflict, not-found, and storage-error paths.

### Frontend

Test:

- Named Agents sidebar section expands and collapses.
- Empty state and Add button are visible.
- Add creates a draft card.
- Model is disabled until provider is selected.
- Model options are filtered by provider.
- Changing provider clears an incompatible model.
- Name edits debounce before save.
- Provider/model changes save when the card is valid.
- `Saving…`, `Saved`, and failure states render correctly.
- Older save responses cannot overwrite newer edits.
- Remove updates the card list and selectors.
- Duplicate and empty names show inline validation.
- **Named Agents** appears first in the model selector provider list.
- Selecting it displays Named Agent names in the model dropdown.
- Empty Named Agents provider displays `No named agents configured`.
- Selecting a Named Agent records its ID, name, and raw-model snapshot.
- Editing/removing a definition does not change an existing conversation.
- Existing raw provider/model selection still works.

### End-to-end acceptance checks

1. Add `Coding Agent` and select a provider/model in the sidebar.
2. Confirm auto-save reaches `Saved` without clicking a Save button.
3. Open a regular model selector and confirm **Named Agents** is first.
4. Select `Named Agents -> Coding Agent` and start a conversation.
5. Edit `Coding Agent` to use another model.
6. Confirm the existing conversation retains its original name/model snapshot.
7. Confirm a new conversation receives the edited model.
8. Call `list_agent_models` and confirm only locally configured Named Agents are
   returned quickly.
9. Summon `Coding Agent` and confirm the saved raw model is used without catalog
   discovery.
10. Remove `Coding Agent` and confirm it disappears from new selectors/tool
    results while existing conversations remain usable.

## 15. Implementation order

1. Define shared Named Agent and selection-snapshot contracts.
2. Implement backend persistence and validation.
3. Add backend HTTP CRUD endpoints.
4. Change `list_agent_models` to use the local registry.
5. Add Named Agent resolution to `summon_agent`, retaining the raw-model path.
6. Persist Named Agent snapshot metadata on selected/summoned conversations.
7. Implement frontend API state and validation logic.
8. Add the collapsible Named Agents sidebar view and editable cards.
9. Add debounced, race-safe auto-save and removal behavior.
10. Add the synthetic **Named Agents** provider to the regular model selector.
11. Add backend, frontend, and end-to-end tests.
12. Verify that list and named-agent summon paths perform no catalog network
    requests.

## 16. Acceptance criteria

The feature is complete when:

- The sidebar has a collapsible **Named Agents** view matching the approved
  layout.
- The user can add, edit, and remove Named Agent cards.
- Each card has a name input and vertically stacked provider/model dropdowns.
- Valid edits auto-save and visibly report save state.
- The regular model selector shows **Named Agents** as its first provider.
- Selecting that provider lists the configured Named Agents.
- Regular conversations use snapshot semantics.
- `list_agent_models` returns only locally configured Named Agents without
  querying providers.
- `summon_agent` can summon by Named Agent without catalog validation.
- Empty configuration returns immediate guidance rather than the full catalog.
- Raw model behavior remains available for compatibility and internal features.
- Editing or deleting a Named Agent never retroactively changes an existing
  conversation.
