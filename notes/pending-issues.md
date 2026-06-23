# Pending Issues — upcoming work

> Three issues recorded for future waves. Each is marked DONE here as it ships.
> Do NOT start any of these until the prerequisites noted per-item are met.

---

## 1. Workspace tab issue

**Status:** PENDING — awaiting a handoff file from the user before starting.

> A handoff file will be provided when we are ready to begin. Do not plan or
> summon until it arrives — the scope + root cause are expected to come from it.

---

## 2. System context builder — referenced files not loaded

**Status:** DONE (commit `b180cc1`).

**Symptom:** The system context builder does not load referenced files that live
in the conversation's working directory. Concrete reproduction: the orchestrator
is in a workspace pointing at `/home/tradam/projects/dispatch` and the
conversation's working directory (cwd) is `arch-rewrite`, which contains an
`AGENTS.md` file at its root — yet that file was NOT loaded into the system
context. The context builder appears to miss files it should be discovering and
injecting from the cwd.

**Scope (initial hypothesis, to confirm on investigation):**
- Which unit owns the system-context / system-prompt assembly (likely
  `session-orchestrator` context-assembly filter chain, §3.2 of the restructure
  plan; see `notes/system-prompt-design.md`).
- How referenced files are discovered (cwd-aware?) and whether the discovery is
  wired through the per-conversation cwd at all.
- Whether this is a discovery gap (files not found) or an injection gap (found
  but not threaded into the prompt).

**Notes:**
- This is a live-found bug — reproduce against the dev stack before assuming a
  fix is correct.
- The cwd resolution pipeline was recently hardened (workspace defaultCwd
  fallthrough, relative resolution, per-turn override) — check whether the
  context builder uses `getEffectiveCwd` or a separate/older code path.

---

## 3. Persistent provider + model selection per chat

**Status:** DONE (commit `f2e452b`).

**Symptom:** A chat's selected provider + model is NOT persisted per
conversation. Opening the same chat in a new browser session defaults to a
single hardcoded/default model + provider rather than recalling the one
originally chosen for that conversation.

**Desired behavior:** The provider + model chosen for a conversation is
persisted (per-conversation, like `cwd` and `reasoningEffort` already are) and
restored when the conversation is reopened — including from a fresh browser
session. New conversations still default to the global default until the user
selects.

**Scope (initial hypothesis, to confirm):**
- Storage: `conversation-store` likely needs a new per-conversation key space
  (mirror the `getCwd/setCwd` and `getReasoningEffort/setReasoningEffort`
  precedents) for the selected model name (`<credential>/<model>` form per
  GLOSSARY) — and possibly the credential/provider if model name alone is not
  enough to re-resolve.
- Transport: `transport-http` + `transport-ws` need GET/PUT (or WS op) endpoints
  for the selection, mirroring the cwd/reasoning-effort endpoints.
- Session: `session-orchestrator` resolves the per-turn model from the persisted
  value when the request omits an explicit override (same precedence pattern as
  reasoning effort: per-turn override → persisted → default).
- Wire/contract: `@dispatch/transport-contract` + possibly `@dispatch/wire` get
  additive types (version bumps).
- FE courier: the web repo needs to send + restore the selection (couriered via
  the user per ORCHESTRATOR §7).

**Notes:**
- Glossary check first (§1 step 2 of the golden workflow): "model name" is the
  canonical term (`<credentialName>/<model>` form); "credential" binds a name to
  a provider. Confirm whether we persist the model name alone (re-resolvable via
  credential-store) or also the credential/provider.
- Boundary decision is the USER's (§1 step 3): is this one unit
  (`conversation-store` + transport + orchestrator) or split? Surface before
  planning.
