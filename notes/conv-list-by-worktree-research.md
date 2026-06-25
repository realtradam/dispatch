# Research — List conversations filtered by worktree / workspace

> **Branch:** `feature/conv-list-by-worktree` (research notes only — no code changes).
> **Date:** 2026-06-25. **Repo:** `dispatch-backend` worktree
> `worktrees/conv-list-by-worktree/backend`.
>
> **Research question:** Does the Dispatch backend currently support getting a
> list of *open* conversations filtered by a specific worktree (or workspace)?

## TL;DR

**Yes — fully supported, via the `workspace` concept.** `GET /conversations`
accepts a composable `?workspaceId=` query filter, and every conversation
already carries a `workspaceId` (default `"default"`). Combined with the
`?status=` filter, "open conversations in workspace X" is:

```
GET /conversations?workspaceId=X&status=active,idle
```

("open" = not `closed`; the lifecycle statuses are `active | idle | closed`,
where `closed` is the archived state.)

**Important terminology caveat:** **"worktree" is NOT a Dispatch domain term** —
it appears nowhere in `packages/` (zero matches; it only occurs in `ORCHESTRATOR.md`
and `notes/restructure-plan.md` as part of file *paths*). The two closest canonical
concepts are:

| Canonical term (GLOSSARY) | Meaning | "Worktree" as directory? |
|---|---|---|
| **workspace** | A named, URL-driven *logical grouping* of conversations that owns a default cwd. Every conversation belongs to exactly one. (`@dispatch/wire` `Workspace`) | No — it's a slug, not a path |
| **working directory (cwd)** | The per-conversation *filesystem directory* tools/language-servers operate within. | **Yes** — a git worktree *is* a directory |

The existing `GET /conversations` filter supports `?workspaceId=` but **not**
`?cwd=`. So if the intent is "conversations whose working directory is a *specific
git worktree path*", that is NOT supported today (see §3b). If the intent is the
logical grouping, it's fully supported (see §1–§2).

---

## 1. Is there an existing endpoint? — YES

`GET /conversations` lists all known conversations and supports three
**composable** query filters:

| Filter | Values | Effect |
|---|---|---|
| `?workspaceId=<slug>` | workspace slug | Restrict to conversations in that workspace |
| `?status=<csv>` | `active`,`idle`,`closed` | Restrict to those lifecycle statuses |
| `?q=<prefix>` | id prefix | Short-id resolution; id-prefix match (applied in-memory) |

**Open conversations in a workspace** = `?status=active,idle` (excludes `closed`)
combined with `?workspaceId=`.

There is also a `GET /workspaces` endpoint that lists workspaces (each with a
`conversationCount`), and per-workspace CRUD — see §4.

---

## 2. How it works (endpoint, parameters, response shape)

### 2a. The route — `packages/transport-http/src/app.ts:775-814`

```ts
app.get("/conversations", async (c) => {
  // ?status= comma-separated (e.g. "active,idle"). Default: all. Invalid dropped.
  const statusFilter = parseStatusFilter(c.req.query("status"));
  // ?workspaceId= . Missing/empty/whitespace → ignored (all workspaces).
  const workspaceId = rawWorkspaceId !== undefined && rawWorkspaceId.trim().length > 0
      ? rawWorkspaceId.trim() : undefined;
  const filter = (statusFilter !== undefined || workspaceId !== undefined)
      ? { ...(statusFilter ? { status: statusFilter } : {}),
          ...(workspaceId ? { workspaceId } : {}) }
      : undefined;
  const all = await opts.conversationStore.listConversations(filter);
  // ?q= prefix filter applied in-memory on the result.
  const conversations = q.length > 0 ? all.filter((m) => m.id.startsWith(q)) : all;
  return c.json({ conversations }, 200);   // 500 on store error
});
```

- `?status=` parsing: `parseStatusFilter` (`packages/transport-http/src/logic.ts:24-38`).
  Valid values are `"active" | "idle" | "closed"` (`VALID_STATUSES`, logic.ts:16).
  Invalid values are silently dropped; if *all* values are invalid → no filter
  (returns all).
- `?workspaceId=` is whitespace-trimmed; empty/whitespace-only is ignored.
- The `filter` object passed to the store is `{ status?, workspaceId? }` — either
  or both optional.

### 2b. Response shape

`200` → `ConversationListResponse` (`packages/transport-contract/src/index.ts:710-713`,
re-exported from `@dispatch/wire`):

```ts
interface ConversationListResponse {
  readonly conversations: readonly ConversationMeta[];
}

interface ConversationMeta {                // @dispatch/wire, wire/src/index.ts:518-536
  readonly id: string;
  readonly createdAt: number;       // epoch-ms, set on first write
  readonly lastActivityAt: number; // epoch-ms, updated on every append
  readonly title: string;           // first user message (truncated 80) or PUT /title
  readonly status: ConversationStatus;   // "active" | "idle" | "closed"
  readonly workspaceId: string;     // always present; "default" fallback
  readonly compactedFrom?: string;  // present iff post-compaction
}
```

- Sorted by `lastActivityAt` **descending** (most recent first); stable sort keeps
  first-seen (index) order for ties.
- `workspaceId` is always present on the response — conversations never assigned
  read as `"default"` (see `toMeta`, `store.ts:329-337`).
- Errors: store failure → `500 { error: "Failed to list conversations" }`.

### 2c. The store filter — `packages/conversation-store/src/store.ts`

`ConversationStore.listConversations` filter type (`store.ts:91-94`):

```ts
readonly listConversations: (filter?: {
  readonly status?: readonly ConversationStatus[];
  readonly workspaceId?: string;
}) => Promise<readonly ConversationMeta[]>;
```

Implementation (`store.ts:695-733`): reads the conversation index, dedups
(first-seen order), reads each conversation's meta row, applies both filters, sorts
desc by `lastActivityAt`. Specifically:

- `statusFilter` → membership test against `row.status`.
- `workspaceFilter` → equality against `row.workspaceId ?? DEFAULT_WORKSPACE_ID`
  (so legacy rows with no stored workspaceId match `"default"`).

`DEFAULT_WORKSPACE_ID` is `"default"`.

---

## 3. "What would it take to add it?"

### 3a. If "worktree" means the logical **workspace** → already done. Nothing to add.

The capability, data model, contract types, and tests all exist. Pin
`@dispatch/transport-contract` (currently `0.22.0`) and `@dispatch/wire`
(`0.12.0`) and call `GET /conversations?workspaceId=<slug>&status=active,idle`.

### 3b. If "worktree" literally means a **filesystem directory / git worktree path** →
NOT supported today; small, well-contained change.

The directory concept maps to **working directory (cwd)**, which is per-conversation
(`conversation-store` `getCwd`/`setCwd`, keyed per conversation; `GET/PUT
/conversations/:id/cwd`). The list endpoint does NOT support a `?cwd=` filter, and
`ConversationMeta` does NOT carry a `cwd` field (confirmed: `wire/src/index.ts:518-536`
has no `cwd`; filter type `store.ts:91-94` has no `cwd`).

To add a `?cwd=` filter (filter conversations by their working directory), the change
touches three layers, all additive:

1. **Contract (`@dispatch/wire`)** — (optional) add `readonly cwd?: string | null` to
   `ConversationMeta` so the caller can see each conversation's directory. Additive
   type bump (e.g. `0.12.0 → 0.13.0`). Not strictly required if filtering is
   server-side-only, but useful for the FE to render.
2. **Store (`conversation-store/src/store.ts`)**:
   - Widen the `listConversations` filter to `{ status?, workspaceId?, cwd? }`.
   - In the scan loop (`store.ts:718-728`), for each candidate call `getCwd(id)`
     (or the effective cwd via `getEffectiveCwd`) and compare. **Cost note:** this is
     an extra storage read per conversation (cwd is stored in its own key, not in the
     meta row) — fine for typical counts; if scale matters, add a `cwd` field to
     `ConversationMetaRow` (populated on `setCwd`) so the filter is a row comparison
     with no extra reads. The latter is the better design and mirrors how
     `workspaceId` was added to the meta row.
   - Decide exact-match (path equality) vs. prefix/normalized match (e.g. a worktree
     and its subdirs). Equality is simplest and probably sufficient.
3. **Transport (`transport-http/src/app.ts` + `logic.ts`)** — parse `?cwd=` (trim;
   empty → ignore, mirroring `?workspaceId=`) and pass `cwd` into the store filter.
   Update `ConversationListResponse` doc.

The worktree-as-directory case is the only one that requires new code; the
workspace case requires none.

---

## 4. Related workspace capabilities (for context)

The workspace model is fully built out (courier doc `frontend-workspaces-handoff.md`
→ implemented in `@dispatch/wire@0.12.0` / `@dispatch/transport-contract`):

- `GET /workspaces` → `WorkspaceListResponse` (workspaces sorted by `lastActivityAt`
  desc, each with `conversationCount`). The `"default"` workspace is always
  synthesized/present.
- `PUT /workspaces/:id` (create-on-miss, idempotent), `GET /workspaces/:id` (pure
  read, 404 if missing), `PUT /workspaces/:id/title`, `PUT /workspaces/:id/default-cwd`,
  `DELETE /workspaces/:id` (closes all its conversations → `status="closed"`,
  reassigns them to `"default"`, returns `closedCount`; 409 for `"default"`).
- Workspace slug regex: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` (1–40, lowercase,
  digits, internal hyphens). Validated by `isValidWorkspaceSlug`.
- `workspaceId` is auto-created on turn start if missing (`title = id`,
  `defaultCwd = null`). Auto-assigned on `/chat` and `POST /conversations/:id/queue`.
- `DELETE /conversations/:id/cwd` clears the explicit per-conversation cwd
  (falls back to the workspace `defaultCwd`, then the server default).
- cwd resolution: explicit per-conversation cwd → workspace `defaultCwd` → server
  default (`process.cwd()`). `GET /conversations/:id/cwd` returns the explicit cwd
  only; `GET /conversations/:id/lsp` roots at the *effective* cwd.

`Workspace` type (`wire/src/index.ts:566-577`): `{ id, title, defaultCwd: string|null,
createdAt, lastActivityAt }`. `WorkspaceEntry extends Workspace { conversationCount }`.

---

## 5. Test coverage (verified green in-repo)

- `conversation-store/src/store-workspace.test.ts:369` — "listConversations filtered
  by workspaceId" (asserts work-a returns `[a1,a2]`, work-b returns `[b1]`).
- `conversation-store/src/store.test.ts:1463` — "listConversations filters by status",
  incl. `{ status: ["active","idle"] }` (= "open") returns `[conv1, conv3]`
  (excludes the `closed` conv2). Also `store.test.ts:1485` — status persists across a
  fresh store instance.
- `transport-http/src/app.test.ts:3696` — "GET /conversations?workspaceId= filters"
  (asserts the store receives `{ workspaceId: "proj" }` and responds `200`).
- `transport-http/src/app.test.ts` (q-filter block ~3133-3156) — `?q=` prefix +
  empty/whitespace handling; 500 on store throw.

The two filters are independently testable and composable at the store level
(same `filter` object carries both); HTTP-level composition of `?status=…&workspaceId=…`
is not asserted by an explicit combined test, but the handler builds one merged
`filter` object so composition is structural.

---

## 6. Verdict & recommendation

- **For the workspace interpretation (the canonical reading of "grouping of
  conversations"): the feature already exists.** Use
  `GET /conversations?workspaceId=<slug>&status=active,idle`. No code changes, no
  data-model changes, no contract bumps needed.
- **For the literal "git worktree as a directory" interpretation: not supported** as a
  list filter; the closest concept is per-conversation **cwd**. Adding a `?cwd=` filter
  is a small additive change across `@dispatch/wire` (optional `cwd` on
  `ConversationMeta`), `conversation-store` (`listConversations` filter + ideally a
  `cwd` column on the meta row for cheap filtering), and `transport-http` (parse
  `?cwd=`). See §3b.
- **Terminology:** recommend the user confirm which concept they mean. If they mean
  the logical grouping, "workspace" is already the canonical GLOSSARY term — no new
  vocabulary. If they truly need directory-based grouping, that is a distinct feature
  from workspaces and should be scoped as such (it overlaps with, but is not, a
  workspace; a single directory could be shared by multiple workspaces or none).
