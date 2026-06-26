# Backend handoff — Workspaces (backend → FE) — courier doc

> **From:** arch-rewrite orchestrator · **To:** frontend orchestrator · **Courier:** the user.
> Response to `backend-handoff-workspaces.md`. This doc finalizes the contract shapes
> the backend will implement. The FE should re-pin `@dispatch/wire` and
> `@dispatch/transport-contract` `file:` deps and re-mirror any `.dispatch/*.reference.md`.

## Version bumps

| Package | From | To | Notes |
|---|---|---|---|
| `@dispatch/wire` | `0.11.0` | `0.12.0` | Additive: `Workspace`, `WorkspaceEntry`, `ConversationMeta.workspaceId` |
| `@dispatch/transport-contract` | `0.15.0` | `0.16.0` | Additive: workspace endpoints + `workspaceId` on chat/queue ops |
| `@dispatch/ui-contract` | `0.2.0` | `0.2.0` | **Unchanged** |

---

## 1. Final types — `@dispatch/wire@0.12.0`

```ts
/**
 * A named, URL-driven grouping of conversations that owns a default cwd.
 * Every conversation belongs to exactly one workspace; conversations that
 * haven't set their own per-conversation cwd inherit `defaultCwd`.
 */
export interface Workspace {
	/** The URL slug (immutable). Lowercase `[a-z0-9-]`, 1–40 chars. */
	readonly id: string;
	/** Display title (editable). Defaults to `id` on creation. */
	readonly title: string;
	/** The workspace's default cwd, or `null` (fall through to server default). */
	readonly defaultCwd: string | null;
	/** Epoch-ms when the workspace was first created. */
	readonly createdAt: number;
	/** Epoch-ms of the most recent conversation activity in this workspace. */
	readonly lastActivityAt: number;
}

/**
 * A workspace entry in the list response — a `Workspace` plus a conversation count.
 */
export interface WorkspaceEntry extends Workspace {
	/** Number of conversations assigned to this workspace. */
	readonly conversationCount: number;
}
```

`ConversationMeta` gains a required `workspaceId`:

```ts
export interface ConversationMeta {
	readonly id: string;
	readonly createdAt: number;
	readonly lastActivityAt: number;
	readonly title: string;
	readonly status: ConversationStatus;
	/** Always present; "default" for legacy/unspecified conversations. */
	readonly workspaceId: string;
	readonly compactedFrom?: string;
}
```

---

## 2. Final types — `@dispatch/transport-contract@0.16.0`

### Additive fields on existing request types

```ts
export interface ChatRequest {
	readonly conversationId?: string;
	readonly message: string;
	readonly model?: string;
	readonly cwd?: string;
	readonly reasoningEffort?: ReasoningEffort;
	/** Workspace to assign the conversation to. Default "default". Auto-creates if missing. */
	readonly workspaceId?: string;
}

export interface QueueRequest {
	readonly text: string;
	/** Default "default". Auto-creates if missing. */
	readonly workspaceId?: string;
}

export interface ChatQueueMessage {
	readonly type: "chat.queue";
	readonly conversationId: string;
	readonly text: string;
	/** Default "default". Auto-creates if missing. */
	readonly workspaceId?: string;
}
```

### Workspace endpoint types

```ts
/** Body of `PUT /workspaces/:id` (all fields optional — the ensure/create call). */
export interface EnsureWorkspaceRequest {
	/** Display title. Default: the workspace id. Only used on create; ignored if workspace exists. */
	readonly title?: string;
	/** Default cwd. Default: null (inherit server default). Only used on create. */
	readonly defaultCwd?: string | null;
}

/** Response of GET/PUT /workspaces/:id — the workspace itself. */
export interface WorkspaceResponse extends Workspace {}

/** Response of `GET /workspaces` — all workspaces sorted by lastActivityAt desc. */
export interface WorkspaceListResponse {
	readonly workspaces: readonly WorkspaceEntry[];
}

/** Body of `PUT /workspaces/:id/title`. */
export interface SetWorkspaceTitleRequest {
	readonly title: string;
}

/** Body of `PUT /workspaces/:id/default-cwd`. null/absent = clear to server default. */
export interface SetWorkspaceDefaultCwdRequest {
	readonly defaultCwd: string | null;
}

/** Response of `DELETE /workspaces/:id`. */
export interface DeleteWorkspaceResponse {
	readonly workspaceId: string;
	/** Conversations that were closed (status → "closed") by this delete. */
	readonly closedCount: number;
}
```

---

## 3. Final endpoint list

| Method & Path | Body | Returns | Notes |
|---|---|---|---|
| `GET /workspaces` | — | `WorkspaceListResponse` | Sorted by `lastActivityAt` desc. Includes `conversationCount`. |
| `PUT /workspaces/:id` | `EnsureWorkspaceRequest?` | `WorkspaceResponse` | **Create-on-miss** (idempotent). Creates with `title=id`, `defaultCwd=null` if missing. Returns existing as-is if present. Slug validated. |
| `GET /workspaces/:id` | — | `WorkspaceResponse` | Pure read. 404 if missing. |
| `PUT /workspaces/:id/title` | `SetWorkspaceTitleRequest` | `WorkspaceResponse` | Rename (display only; id unchanged). |
| `PUT /workspaces/:id/default-cwd` | `SetWorkspaceDefaultCwdRequest` | `WorkspaceResponse` | Set/clear workspace default cwd. |
| `DELETE /workspaces/:id` | — | `DeleteWorkspaceResponse` | **Closes all conversations** (status → "closed"), reassigns them to "default", then deletes the workspace. 409 for `"default"`. |
| `GET /conversations` | `?workspaceId=`, `?status=`, `?q=` | `ConversationListResponse` | Additive `?workspaceId=` filter, composable with existing filters. |
| `DELETE /conversations/:id/cwd` | — | `CwdResponse` | Clears explicit conversation cwd (returns `cwd: null`). |

### Existing endpoints (semantic note, no type change)

- `GET /conversations/:id/cwd` — unchanged: returns the **explicit** conversation cwd (`null` = inheriting workspace default).
- `GET /conversations/:id/lsp` — now roots LSP at the **effective** cwd; `LspStatusResponse.cwd` returns the effective cwd.

---

## 4. cwd resolution (backend-owned)

```
effectiveCwd = conversationStore.getCwd(conversationId)          // explicit per-conversation
if (effectiveCwd == null) {
    workspaceId = conversationStore.getWorkspaceId(conversationId)  // "default" fallback
    workspace = conversationStore.getWorkspace(workspaceId)
    effectiveCwd = workspace?.defaultCwd ?? null
}
if (effectiveCwd == null) effectiveCwd = serverDefaultCwd       // process.cwd() today
```

- `GET /conversations/:id/cwd` → explicit cwd only (`null` = inherit).
- `GET /conversations/:id/lsp` → effective cwd.
- Turn start (`runTurn` / `warm`) → effective cwd.

---

## 5. `DELETE /workspaces/:id` semantics

1. Close all conversations in that workspace (set `status = "closed"`).
2. Reassign their `workspaceId` to `"default"` (so no dangling reference).
3. Delete the workspace entity.
4. Return `{ workspaceId, closedCount }`.
5. `DELETE /workspaces/default` → HTTP 409.

Closed conversations are hidden from tab-restore (`?status=active,idle` excludes `closed`).

---

## 6. Workspace lifecycle / auto-creation

- **Auto-create on turn start:** if `workspaceId` is provided and doesn't exist, the backend auto-creates it (`title = id`, `defaultCwd = null`).
- **`PUT /workspaces/:id` create-on-miss:** if absent, creates with optional `title`/`defaultCwd` from the body (defaults: `title = id`, `defaultCwd = null`). If present, returns existing as-is.
- **Slug validation:** `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` (1–40 chars, lowercase, digits, internal hyphens only). Reject invalid with 400. No normalization. `"default"` allowed but non-deletable.
- **`"default"` workspace:** always synthesized if not persisted; guaranteed in `GET /workspaces` list.
- **`lastActivityAt`:** updates when a conversation in the workspace appends, or on first creation. Does NOT update on title/default-cwd changes.
- **Compaction:** post-compaction conversations inherit the original's `workspaceId`.

---

## 7. Answers to FE open questions (Q1–Q8)

| # | Decision |
|---|---|
| Q1 | **Close all conversations** in the workspace (status → "closed"), reassign to "default", then delete the workspace. Return `closedCount`. |
| Q2 | **Add `DELETE /conversations/:id/cwd`** to clear explicit cwd (fall back to workspace default). `PUT` validation unchanged (empty string still 400). |
| Q3 | **Deferred to v1** — no WS lifecycle push. Fetch-on-mount + manual refresh sufficient. Can add `workspace.created/updated/deleted` later, additively. |
| Q4 | **`PUT /workspaces/:id`** is the create-on-miss entry point (idempotent, 200). `GET /workspaces/:id` is a pure read (404 if missing). |
| Q5 | Slug regex `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`. Reject, don't normalize. `"default"` non-deletable. |
| Q6 | `Workspace` in `@dispatch/wire`. Request/response bodies in `@dispatch/transport-contract`. |
| Q7 | Confirmed — backend does nothing beyond `workspaceId` on `ConversationMeta` + `?workspaceId=` filter. |
| Q8 | Yes — post-compaction conversations inherit `workspaceId`. `forkHistory` copies it. |

---

## 8. Gaps resolved (from FE handoff §3)

1. **Unknown workspaceId on turn start** → auto-create (title = id, defaultCwd = null). Typos can be deleted.
2. **PUT /workspaces/:id initial state** → body accepts optional `title`/`defaultCwd` with defaults (`title = id`, `defaultCwd = null`). Only applied on create; existing workspace returned as-is.
3. **lastActivityAt on title/default-cwd changes** → no.
4. **LSP cwd field** → returns effective cwd.
5. **Conversation count in list** → yes, included as `WorkspaceEntry.conversationCount`.
