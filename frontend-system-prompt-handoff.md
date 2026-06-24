# FE Courier Handoff: System Prompt Builder (Updated)

> Backend→FE courier. Send to FE agent `ffe3`.
> Supersedes the earlier `frontend-system-prompt-handoff.md` — adds `prompt:workspace_id`.

## API endpoints

### `GET /system-prompt` → `{ template: string }`
Returns the current global template. When none is stored, returns the built-in default.

### `PUT /system-prompt` ← `{ template: string }` → `{ template: string }`
Set the global template. Empty string = "no system prompt". 400 if `template` missing/wrong type. 503 if service unavailable.

### `GET /system-prompt/variables` → `{ variables: SystemPromptVariable[] }`
Static catalog — always available (no service dependency). Use this to render the variable selector buttons.

## Template format

### Variable insertion
```
[type:name]
```
Resolves at construction time. Unknown type → blank. Non-existent variable (e.g. file not found) → blank.

### Conditional blocks
```
[if type:name]
  ...if variable exists...
[else]
  ...if not...
[endif]
```
Negated:
```
[if !type:name]
  ...if variable does NOT exist...
[endif]
```
Nested `[if]`: supported. Multi-line: supported. Unmatched `[if]`/`[endif]`: literal text.

## Available variables (updated)

| Type:Name | Description | Dynamic? |
|---|---|---|
| `system:time` | Current time (ISO 8601) | No |
| `system:date` | Current date (YYYY-MM-DD) | No |
| `system:os` | Operating system | No |
| `system:hostname` | Machine hostname | No |
| `prompt:cwd` | Working directory | No |
| `prompt:model` | Current model name | No |
| `prompt:conversation_id` | Conversation ID | No |
| `prompt:workspace_id` | Workspace identifier — lets the AI know which workspace it's in, useful when summoning agents | No |
| `git:branch` | Current git branch | No |
| `git:status` | Short git status | No |
| `file:<path>` | File contents (relative to cwd, or absolute if starts `/`) | **Yes** |

For `file:<path>`, allow free-text input for the path.

## Caching behavior

System prompt is **constructed once** (first turn of a new conversation) and **persisted**. Reused on all subsequent turns (cache-safe). Reconstructed only on **compaction**. Changing the template does NOT affect existing conversations until compacted.

## Default template

```
You are a helpful coding assistant.

[if file:AGENTS.md]
[file:AGENTS.md]
[endif]

The current working directory is [prompt:cwd].
```
