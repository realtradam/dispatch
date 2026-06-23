# Assumptions Log

> Single place where every assumption made while the user is away is recorded.
> These will be raised when the user returns; nothing here is final.

## Task 1 — Workspace tab issue (conversation.open drops workspaceId)

1. **workspaceId is always available.** `ConversationStore.getWorkspaceId(id)` returns `"default"` for unknown/unassigned conversations, so there is no `null` case to handle on the `ConversationOpenMessage`/`ConversationStatusChangedMessage` contract — a plain `string` field is sufficient. No migration or legacy row edge case changes the "default" fallback.
2. **No transport-contract version-bump type.** Because there is no external load-time semver machinery yet (restructure-plan §2.9: "the type system IS the version check" for internal consumers), I will bump `@dispatch/transport-contract` with a **minor (additive)** version increase. The exact number is for changelog communications, not mechanics; my target is `0.19.0` based on the current `0.18.0` plus an additive surface change.
3. **No conversation-store change required.** The store surface already exports `getWorkspaceId`; we can look it up from transport-http / session-orchestrator as needed.
4. **Both `conversation.open` and `conversation.statusChanged` get the same additive `workspaceId: string` field**, and both broadcast paths are fixed in this task. The handoff says "same bug on conversation.statusChanged path."
5. **Frontend tests are the frontend's problem.** I will send a handoff with the BE contract changes and the exact `29ae` deliverables; I do not edit the frontend repo.


## Task 2 — System context builder not loading referenced files

*Assumptions will be appended here as the work progresses.*

## Task 3 — Persistent provider + model selection per chat

*Assumptions will be appended here as the work progresses.*
