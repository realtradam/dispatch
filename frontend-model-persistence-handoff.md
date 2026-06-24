# Frontend handoff — per-conversation model persistence

## What changed

A chat's selected provider + model is now **persisted per conversation**
(like `cwd` and `reasoningEffort` already are). Opening a conversation in a new
browser session recalls the originally selected model instead of defaulting to
the server default.

## Contract version bump

`@dispatch/transport-contract` `0.19.0 → 0.20.0` — re-pin the `file:` dep and
re-mirror `.dispatch/transport-contract.reference.md`.

## New types (additive)

```ts
// GET /conversations/:id/model
export interface ModelResponse {
  readonly conversationId: string;
  readonly model: string | null;  // <credentialName>/<model> form, or null
}

// PUT /conversations/:id/model
export interface SetModelRequest {
  readonly model: string | null;  // null clears the persisted selection
}
```

## New endpoints

### `GET /conversations/:id/model`
Returns `ModelResponse`. `model` is `null` when never set (the server then
resolves turns using the default provider + model).

### `PUT /conversations/:id/model`
Body: `SetModelRequest`. Set `model` to a `<credentialName>/<model>` string
(one of the values from `GET /models`) to persist it. Set `model` to `null`
to clear the persisted selection. Returns `ModelResponse` with the resulting
value.

## What the FE should do

1. **On conversation open** — call `GET /conversations/:id/model` to fetch the
   persisted model. If non-null, set the model selector to that value. If null,
   use the global default (current behavior).

2. **On model select** — call `PUT /conversations/:id/model` with the selected
   model name (`<credentialName>/<model>` form). This persists it so future
   turns (and new browser sessions) use the same model.

3. **On model clear** (if the FE supports clearing back to default) — call
   `PUT /conversations/:id/model` with `{ model: null }`.

4. **No `ChatRequest.model` change needed** — the FE may continue sending
   `model` on `chat.send` (per-turn override); the backend persists it. Or the
   FE may omit `model` on `chat.send` and rely on the persisted value — the
   backend resolves it. Either way works.

## Backend behavior

- **Per-turn override** (`ChatRequest.model` / `chat.send` model) takes
  precedence and is persisted.
- **No per-turn override** → backend checks `getModel(conversationId)` → if
  non-null, uses it; if null, falls through to the default provider.
- **Warm path** also resolves the model from persistence when no explicit
  override is given (parity with real turns).

## No FE handoff needed for tasks 1 & 2

- **Task 1** (workspace tab broadcast): already couriered to 29ae by a prior
  orchestrator agent (`frontend-workspace-open-handoff.md`).
- **Task 2** (system-prompt cwd reconstruction): backend-only fix, no contract
  version bump, no FE action needed.

## Assumptions made (user was away)

1. **Persist the model name string** (`<credentialName>/<model>` form), not
   the provider/credential separately — the model name already encodes both
   (the credential binds to a provider). This mirrors how the CLI sends
   `--model` and how `ChatRequest.model` works.
2. **No model validation on PUT** — the backend doesn't validate the model
   name on `PUT /conversations/:id/model` (it's just a string). The provider
   resolves it at turn time; an unknown model → turn error, not a 400. This
   matches the contract doc on `SetModelRequest`.
3. **Empty string clears** — `setModel(id, "")` deletes the key. The HTTP
   `PUT` with `{ model: null }` maps to this. This is an implementation detail
   the FE doesn't need to know about (it sends `null`).
4. **No `model` field on `ConversationMeta`** — following the precedent of `cwd`
   and `reasoningEffort` (which are NOT on `ConversationMeta` but fetched via
   dedicated endpoints). The FE calls `GET /conversations/:id/model` to read.
