# FE Courier Handoff: System Prompt Builder

> Backend→FE courier. The user couriers this to `../dispatch-web` (FE agent `ffe3`).
> `@dispatch/transport-contract` bumped to `0.18.0` (additive types).

## Overview

A template-based system prompt builder. The user defines a template with variable
placeholders (`[type:name]`) and conditionals (`[if]`/`[else]`/`[endif]`). Variables are
resolved at construction time (once per conversation, persisted for cache safety —
reconstructed only on compaction).

## API endpoints

### `GET /system-prompt` → `SystemPromptTemplateResponse`
```ts
{ template: string }
```
Returns the current global template. When no template is stored (or the service is
unavailable), returns the built-in `DEFAULT_TEMPLATE`.

### `PUT /system-prompt` ← `SetSystemPromptTemplateRequest`
```ts
// Request body:
{ template: string }
// Response:
{ template: string }  // echoed back
```
- `template` can be empty (means "no system prompt").
- 400 if `template` is missing or not a string.
- 503 if the system-prompt service is unavailable.

### `GET /system-prompt/variables` → `SystemPromptVariablesResponse`
```ts
{
  variables: readonly SystemPromptVariable[]
}
// SystemPromptVariable:
{
  type: string;        // "system", "file", "prompt", "git"
  name: string;        // "time", "date", "os", "cwd", etc.
  description: string; // human-readable
  dynamic?: boolean;   // true for file: (any path is valid)
}
```
Static catalog — always available (no service dependency). Use this to render the
variable selector buttons in the builder UI.

## Template format

### Variable insertion
```
[type:name]
```
Resolves the variable at construction time. Unknown type → blank string. Non-existent
variable (e.g. file not found) → blank string.

### Conditional blocks
```
[if type:name]
  ...content if variable exists...
[else]
  ...content if variable does NOT exist...
[endif]
```
Negated condition:
```
[if !type:name]
  ...content if variable does NOT exist...
[endif]
```
- Nested `[if]` blocks: supported.
- Multi-line content: supported.
- Unmatched `[if]`/`[endif]`: treated as literal text.

## Available variables

| Type:Name | Description | Dynamic? |
|---|---|---|
| `system:time` | Current time (ISO 8601) | No |
| `system:date` | Current date (YYYY-MM-DD) | No |
| `system:os` | Operating system | No |
| `system:hostname` | Machine hostname | No |
| `prompt:cwd` | Working directory | No |
| `prompt:model` | Current model name | No |
| `prompt:conversation_id` | Conversation ID | No |
| `git:branch` | Current git branch | No |
| `git:status` | Short git status | No |
| `file:<path>` | File contents (relative to cwd, or absolute if starts `/`) | **Yes** |

For `file:<path>`, the FE should allow free-text input for the path. Any filename is
valid — the backend resolves it relative to the conversation's cwd (or absolute if it
starts with `/`).

## Caching behavior (important for FE)

The system prompt is **constructed once** (on the first turn of a new conversation) and
**persisted**. It is reused on all subsequent turns (no reconstruction — this preserves
the prompt cache). It is only **reconstructed on compaction** (fresh variable resolution).

Changing the template (via `PUT /system-prompt`) does NOT affect existing conversations
until they are compacted. New conversations use the new template on their first turn.

## Default template

When no template is stored, the backend uses:
```
You are a helpful coding assistant.

[if file:AGENTS.md]
[file:AGENTS.md]
[endif]

The current working directory is [prompt:cwd].
```

## FE UI suggestion

The builder is a full-page modal split into two:
1. **Text editor** (left/main): the template text.
2. **Variable selectors** (right/side): buttons grouped by type. Clicking a variable
   inserts `[type:name]` at the cursor position. For `file:` (dynamic), show a text
   input for the path + an "insert" button.
