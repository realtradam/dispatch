# Named Agents — Backend Contract Handoff (for the frontend worktree)

> Companion to the companion FE worktree (`../frontend`). This document is the
> **finalized backend contract** for the Named Agents feature, produced by the
> **backend** worktree at `feature/named-agents`. The FE team builds against THIS
> surface. The backend is fully implemented, tested (typecheck 0, vitest 2452,
> bun 124, biome clean), and live-probed.

Read together with the plan `notes/named-agents-plan.md` (the product direction)
and `packages/transport-contract/src/index.ts` (the authoritative types). The
backend executes the approved plan §2–§14 for the backend scope.

---

## 1. Terminology

Use GLOSSARY terms exactly. **named agent** = a persisted `{id, name, model}`
preset. **selection snapshot** = the frozen `NamedAgentSelectionSnapshot` on a
conversation. The synthetic **Named Agents provider** is frontend-presentation
only — it is NOT a real provider credential on the backend.

## 2. HTTP surface (the FE CRUD contract)

Base URL is the backend `/`. All routes are CORS-enabled for browser clients.

| Method & path | Request | Success response | Errors |
|---|---|---|---|
| `GET /named-agents` | — | `200 { "namedAgents": NamedAgent[] }` | 503 no service; 500 |
| `POST /named-agents` | `{ name, model }` | `200 { "namedAgent": NamedAgent }` | 400 invalid name/model; **409 duplicate name**; 500 |
| `PUT /named-agents/:id` | `{ name, model }` | `200 { "namedAgent": NamedAgent }` | 400; 409 duplicate; **404 not found**; 500 |
| `DELETE /named-agents/:id` | — | `200 { "id": string }` | **404 not found**; 500 |

Where the canonical record is:

```json
{ "id": "d478a9f1-1984-421e-a460-24e6484c553c", "name": "Coding Agent", "model": "opencode-1/claude-sonnet-4.5" }
```

- `model` is the canonical `<credential-or-provider>/<model>` (the same strings
  `GET /models` returns).
- `name` uniqueness is **case-insensitive** and authoritative server-side
  (409 on duplicate). Names are trimmed + whitespace-collapsed by the backend.
- **`GET /named-agents` never touches the provider catalog** — it reads local
  SQLite-backed config instantly. Do not gate rendering on a slow catalog fetch.
- Types: `NamedAgentsResponse`, `NamedAgentResponse`, `CreateNamedAgentRequest`,
  `UpdateNamedAgentRequest`, `DeleteNamedAgentResponse` — all in
  `@dispatch/transport-contract`.

## 3. Model selector integration (synthetic provider + snapshot)

- The full raw catalog for **configuration dropdowns** (`GET /models`) is
  **unchanged** — keep using it to populate *provider* and *model* controls in the
  Named Agents editor. Catalog latency on the human-config path is acceptable.
- Add **Named Agents** as the FIRST provider option in the regular model
  selector. When selected, the model dropdown shows Named Agent **names**. If
  none configured, show a disabled `No named agents configured` option (the
  provider stays visible).
- Selecting `Named Agents -> <name>` resolves to the configured raw `model` and
  **sends BOTH** to the backend so the selection is snapshotted:

  - **Starting a conversation:** `POST /chat` with `model` **and** a
    `namedAgent` snapshot in the body:
    ```json
    { "conversationId": "...", "message": "...",
      "model": "opencode-1/claude-sonnet-4.5",
      "namedAgent": { "namedAgentId": "d478...", "namedAgentName": "Coding Agent", "model": "opencode-1/claude-sonnet-4.5" } }
    ```
    The backend persists the snapshot (fail-open — a snapshot write never fails
    the turn).
  - **Setting an existing conversation:** `PUT /conversations/:id/model` with
    `{ "model": "...", "namedAgent": { ... } }`.
  - **Reading a conversation's selection:** `GET /conversations/:id/model`
    returns `{ "conversationId", "model", "namedAgent?: NamedAgentSelectionSnapshot }`.
    `namedAgent` is present ONLY for conversations created/selected via a Named
    Agent. A raw-model conversation omits it (→ render via raw provider/model).
- **Snapshot semantics — never assume live lookup.** The snapshot on a
  conversation is frozen at selection time. Editing/deleting the Named Agent
  does NOT change existing conversations. Render the conversation's stored
  `namedAgent.namedAgentName` + `model`; only NEW conversations should consult
  the live `GET /named-agents`.

## 4. Agent tools (AI-facing)

These are the agent tools (not HTTP). The FE generally calls the HTTP surface
above; the tools matter for cross-repo contract completeness and manual/agent
verification:

- **`list_agent_models`** returns ONLY local Named Agents — shape per entry:
  `{ namedAgentId, name, model }` — plus `query` (name substring) and `limit`
  filters. It NEVER returns the raw catalog and NEVER queries providers. Empty
  config → the guidance string *"No named agents are configured…"* (no catalog
  fallback). No `vision` filter exists anymore.
- **`summon_agent`** takes `agent` (a Named Agent name or id) OR `model`
  (backward-compatible raw escape hatch) — exactly ONE. Summoning by `agent`
  resolves locally (zero catalog), uses the Named Agent's model, and snapshots
  the selection onto the subagent. Unknown agent → `unknown-agent` error listing
  available names.

## 5. What the FE must NOT rely on

- The backend does **not** seed/auto-generate Named Agents; an empty registry is
  a valid, normal state (FE shows the empty state + Add button, plan §5.7).
- No system prompts, per-agent dir/computer/workspace/title, or tool allow/deny
  lists on Named Agents this version (non-goals, plan §3).
- `/named-agents` is a separate concern from `GET /models`; do not merge the two
  in the UI state — Named Agents are a synthetic presentation layer over the raw
  catalog, never injected into the backend catalog.

## 6. Changes to the backend data model (FE-relevant)

- `@dispatch/wire` now exports `NamedAgent` and `NamedAgentSelectionSnapshot`
  (FE consumes via the pinned `file:` dep).
- `ConversationMeta` is unchanged. The snapshot surfaces through
  `GET /conversations/:id/model` (and the chat/model write paths), additive.

## 7. Verification status (backend)

- `bun run typecheck` → clean (exit 0)
- `bun run test` → 2452 passed / 6 skipped
- `bun run test:bun` → 124 passed
- `bun run check` → biome clean (0/0/0)
- Live probe on a private instance verified: create, list, update, delete,
  duplicates→409, unknown→404 on PUT/DELETE, model-with-snapshot round-trip on
  GET/PUT, and clear-model-clears-snapshot.

## 8. Suggested FE integration order

1. Add the CRUD API adapter + view-model (split `model` → provider/model controls;
   case-insensitive uniqueness; trimmed empty-name; canonical-model validity).
2. Collapsible **Named Agents** sidebar view (plan §5 layout) with auto-save
   debounce + race-safe writes against stable ids (plan §5.4/§12).
3. Synthetic **Named Agents** provider in the regular model selector (plan §6),
   sending the `namedAgent` snapshot on `/chat` and model PUT (plan §6/§7).
4. Snapshot rendering for existing conversations via `GET /conversations/:id/model`
   `namedAgent`.

## 9. Notes / coordination residue

- Backend commit: single feature commit on `feature/named-agents` (no merge/push).
- If the FE needs a different error body shape or a BY-name lookup endpoint
  beyond `/named-agents/:id`, that is a contract change to coordinate through the
  user — do not assume it exists.