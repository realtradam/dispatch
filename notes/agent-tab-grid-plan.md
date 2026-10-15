# Agent tab grid — subagent tab groups (backend plan)

## Goal
The frontend's tab list becomes a 2-column grid of same-size cards. A tab that
has subagents is shown double-width and wrapped, together with its subagents, in a
darker "subagent group" box. Groups can be nested, because subagents can summon
their own subagents. Users can right-click or long-press a tab to **add it to** or
**remove it from** a subagent group.

The grouping is **purely visual**. It must NEVER change lineage, manageability,
authorization, or any agent-management behaviour. The backend only needs to:

1. **persist** a per-conversation visual group parent, so the grouping syncs
   across devices and survives reloads,
2. **default** it to the lineage parent (`parentConversationId`), so a summoned
   subagent shows up grouped under its summoner automatically,
3. **expose** it on the conversation list and the `conversation.open` broadcast,
4. let the user **override** it with an HTTP endpoint, and **broadcast** changes over WS.

## Vocabulary
- **lineage parent**: existing `parentConversationId` (written by `summon_agent`).
  It is UNCHANGED by this feature.
- **tab group parent**: NEW, `tabGroupParentId`. This is the conversation whose
  subagent group this tab is visually nested under. It is purely presentational.
  Add it to `GLOSSARY.md`, and state that it is distinct from `parentConversationId`.

## Semantics (the contract the frontend is coded against)
Each conversation has an optional **override**, which is persisted on its own store key
(e.g. `conv:<id>:tab-group-parent`). The override has three states:

| persisted override | effective `tabGroupParentId` |
|---|---|
| never set (key absent) | the lineage `parentConversationId` if one exists, otherwise absent |
| explicitly set to an id | that id |
| explicitly cleared (ungrouped) | absent, even when a lineage parent exists |

Note: "explicitly cleared" must be distinguishable from "never set". For example, store
an empty string or a JSON `null` sentinel; the storage detail is your call.

The **effective** value is what goes over the wire. The frontend never sees the raw
override.

## Contract changes

### `@dispatch/wire` — `ConversationMeta`
- Add `readonly tabGroupParentId?: string;`, which is the EFFECTIVE tab group parent
  (absent means ungrouped).
- Populate the existing `parentConversationId?` on list results as well (it is declared
  today but `toMeta`/`listConversations` never fill it).

### `@dispatch/transport-contract`
- `ConversationOpenMessage`: add `readonly tabGroupParentId?: string;` (effective value),
  so a freshly summoned subagent's tab lands in its summoner's group immediately.
- NEW WS message, added to the `WsServerMessage` union:
  ```ts
  export interface ConversationTabGroupChangedMessage {
    readonly type: "conversation.tabGroupChanged";
    readonly conversationId: string;
    /** The conversation's persisted workspace id. */
    readonly workspaceId: string;
    /** The new EFFECTIVE tab group parent; null = ungrouped. */
    readonly tabGroupParentId: string | null;
  }
  ```
- NEW request/response types:
  ```ts
  /** Body for `PUT /conversations/:id/tab-group`. null = remove from its group (ungroup). */
  export interface SetTabGroupRequest { readonly parentId: string | null; }
  /** Response for `PUT /conversations/:id/tab-group` — the new EFFECTIVE value. */
  export interface TabGroupResponse {
    readonly conversationId: string;
    readonly tabGroupParentId: string | null;
  }
  ```

### Conversation store (`conversation-store`)
- `getTabGroupParentId(conversationId): Promise<string | null>` returns the EFFECTIVE value
  (override → lineage fallback → null).
- `setTabGroupParentId(conversationId, parentId: string | null): Promise<void>` writes the
  override (`null` means explicitly ungrouped).
- `listConversations` (and any single-meta getter used by `GET /conversations/:id`) fills in
  `tabGroupParentId` and `parentConversationId`. Batch the point lookups the same way the
  existing `model` enrichment does.
- `deleteConversation` must also delete the new key.
- Add the new key to the documented `conv:{id}:*` namespace list.

### HTTP (`transport-http`)
Add `PUT /conversations/:id/tab-group` and register the route in `extension.ts`. It takes the body
`SetTabGroupRequest`. Validation:
- invalid JSON or a non-object body → 400
- `parentId` is neither a non-empty string nor `null` → 400
- `parentId === id` (self) → 400
- an unknown conversation `:id` or an unknown `parentId` → 404
- `parentId` in a different workspace than `:id` → 400
- a write that would form a cycle in the EFFECTIVE tab-group graph (walking up from `parentId`
  using effective values reaches `:id`) → 409. Guard against pre-existing loops while walking.

On success it persists the override, emits the WS broadcast (below), and returns 200
`TabGroupResponse` with the new effective value.

### WS broadcast (`transport-ws`) and the orchestrator hook
- Add a typed event hook, e.g. `conversationTabGroupChanged` (payload
  `{ conversationId, workspaceId, tabGroupParentId: string | null }`). Put it next to
  `conversationOpened`/`conversationStatusChanged` in session-orchestrator (or wherever those
  descriptors are owned). transport-ws subscribes and broadcasts
  `conversation.tabGroupChanged` to ALL clients, as a global fan-out like `conversation.open`.
- Every place that emits `conversationOpened` must include the effective
  `tabGroupParentId` when it is non-null. Known emitters are agent-management `emitOpen`
  (summon/open_agent) and `POST /conversations/:id/open`. For a freshly summoned child,
  the lineage parent must already be persisted (or passed through) before the open signal
  goes out. If it is not, pass the known `callerId`, the same way `knownWorkspaceId` is
  passed, to avoid a race.

## Explicitly out of scope
- No change to `parentConversationId`, `listChildren`, manageability, or `list_agents`.
- No change to agent-management tools' behaviour.
- No ordering/position persistence. The frontend keeps the tab order.

## Tests
- conversation-store: the three override states and the fallback, explicit clearing hiding a
  lineage parent, list enrichment, and delete cleaning the key.
- transport-http: each validation branch (400/404/409), success persisting the value and
  emitting the hook, and `GET /conversations` carrying `tabGroupParentId`.
- transport-ws: the hook → `conversation.tabGroupChanged` broadcast, and `conversation.open`
  carrying `tabGroupParentId`.

## Verification
`bun run typecheck` (this also rebuilds each package's `dist/`, which the frontend and the
running dev server consume), `bun run test`, `bun run test:bun`, and `bun run check`. All must
be green.
