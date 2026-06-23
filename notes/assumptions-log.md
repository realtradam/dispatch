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

1. **My reproduction shows the resolver is not buggy.** A standalone script using
   the exact same `resolvePath(cwd, "AGENTS.md")` + `Bun.file(...).exists()/.text()`
   logic successfully reads `/home/tradam/projects/dispatch/arch-rewrite/AGENTS.md`
   when `cwd` is that directory. So the file-reading path in system-prompt works.
2. **The failure mode is stale cached system prompt after a cwd change.** The system-
   prompt service constructs once on the first turn of a new conversation and
   reuses the result via `get()` on subsequent turns (cache-safe design). If the
   conversation's cwd is changed after the first turn (or if the conversation was
   created before system-prompt existed), the stored prompt was built against a
   different cwd and does not include `AGENTS.md` from the new directory. I am
   adding reconstruction when the stored prompt's cwd differs from the current
   effective cwd.
3. **Reconstructing on cwd change is the correct cache-vs-freshness trade.** The
   system prompt is intentionally cwd-sensitive (`[prompt:cwd]` and `file:` vars);
   when the cwd changes the prompt MUST change, so the cache was already stale
   from a semantic standpoint. We still preserve construction-once-per-cwd.
4. **Storage shape chosen:** keep `resolved:<conversationId>` as the resolved
   prompt string (no migration needed for existing rows), and add a sibling key
   `resolved-cwd:<conversationId>` for the cwd it was built against. A new
   `SystemPromptService.getWithMeta(conversationId)` returns `{ prompt, cwd }`
   so the orchestrator can compare before deciding to reconstruct.


## Task 3 — Persistent provider + model selection per chat

*Assumptions will be appended here as the work progresses.*
