# Frontend handoff — workspace id on conversation.open / statusChanged

## What changed

The backend now resolves the conversation's actual persisted workspace id and
includes it on the WS broadcast for both `conversation.open` and
`conversation.statusChanged`.

- `@dispatch/transport-contract` `0.18.0 → 0.19.0` — additive `workspaceId: string`
  on both `ConversationOpenMessage` and `ConversationStatusChangedMessage`.
- The backend uses the conversation's stored workspace (`"default"` fallback),
  not the per-turn start option.

## What the frontend must do

1. **Re-pin the `file:` dep** on `@dispatch/transport-contract` from the backend
   repo once this commit lands.
2. **Re-mirror `.dispatch/transport-contract.reference.md`** to match the `0.19.0`
   contract.
3. **Parser update** (`src/adapters/ws/logic.ts:116-123`): parse `workspaceId`
   from the incoming `conversation.open` and `conversation.statusChanged` messages.
4. **`openConversation()`** (`src/app/store.svelte.ts:588-600`): use the message's
   `workspaceId` to stamp/focus the tab instead of `activeWorkspaceId` (the
   viewer's current workspace). This fixes the bug where a tab opened via the
   CLI `--open --workspace my-ws` was appearing in every workspace.
5. **`onConversationStatusChanged()`** (`src/app/store.svelte.ts:703-718`): same
   fix when the FE calls `openConversation(conversationId)` on a status change and
   has no existing tab — use the `workspaceId` from the message.
6. **Tests** (`logic.test.ts`, `index.test.ts`, `App.test.ts`, `conformance.test.ts`):
   update fixtures/assertions to carry `workspaceId`.

## Backend status

- `@dispatch/transport-contract`: `0.19.0` with additive `workspaceId`.
- `session-orchestrator`: payload types widened; status-change emits resolve
  workspace id from store.
- `transport-ws`: broadcasts include `workspaceId`.
- `transport-http`: `POST /conversations/:id/open` resolves workspace id and emits
  it.
- Verified: `tsc -b` EXIT 0, biome clean, **1405 vitest** green.

## Note on assumptions

I'm working autonomously while the user is away. Every assumption I make is
recorded in `notes/assumptions-log.md` in this repo. Please record any
assumptions you make while implementing this handoff in your own assumptions log
so we can raise them when the user returns.
