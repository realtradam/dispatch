# Named Agents — FE bug fix note (for the frontend agent f5c40400)

> Backend worktree is clean; this is a **frontend-only** bug. Hand this file to
> the frontend agent (f5c40400) or apply the patch in the FE worktree.

## Symptom
"A named agent with this name already exists." appears for **any** name typed in
a **new** draft Named Agent card.

## Backend is NOT the cause (verified live)
Probed the running `bin/up` server (`curl localhost:24203/named-agents`):
- `GET /named-agents` → `{"namedAgents":[]}` (registry empty).
- `POST {name:"Temp Probe Agent"}` → **200** created (fresh name ok).
- Re-`POST` same name → **409** (correct: it now genuinely exists).
- `POST` a different fresh name → **200**.
- Cleanup done; registry empty again.
Backend only 409s a name that already truly persists. The FE's message casing
("A named agent...") also differs from the backend's ("A Named Agent..."), so the
message is generated client-side, not echoed from the server.

## Root cause — FE
`src/features/named-agents/ui/NamedAgentsView.svelte` (both `otherNamesOf` and
`isNameTakenFor`) includes the **current draft card's own name** in the sibling
"other names" set. For a new draft (`agent === null`, `exceptId === null`), the
branch `else if (exceptId === null) out.push(r.controller.draft.name)` matches
the draft's own row, so every typed name collides with **itself** → always
"already exists".

Flow: `NamedAgentCard.svelte` → `draftValidity(controller.draft, otherNames)` →
`logic/auto-save.ts` → `nameError(name, otherNames)` in
`logic/validate.ts` compares `name` against `otherNames` (which contains the
draft's own name).

## Fix
Exclude the row being validated from the sibling-names set by its **stable row
key** — not by `exceptId === null` (which can't distinguish the edited draft from
other drafts, since all drafts share `exceptId === null`).

Concretely in `NamedAgentsView.svelte`:
- `otherNamesOf` / `isNameTakenFor` take the row being validated (`row.key`).
- In the loop, skip the **own** row (`if (r.key === ownKey) continue;`).
- Still include OTHER persisted rows and OTHER draft rows.
- `NamedAgentCard` currently receives `otherNames={otherNamesOf(row.agent?.id ?? null)}` —
  change to pass the row identity (e.g. `otherNames={otherNamesOf(row)}`) and have
  `otherNamesOf` skip `row` itself.

Backend needs no change. No cross-repo contract change.