# System Prompt Builder — design + plan

> Orchestrator-authored plan. Drives the `prompts/<unit>.md` TASK blocks.
> User-approved: all variable types, `[else]`, negated `[if !...]`, caching, compaction append.

## 1. Goal

A **template-based system prompt builder** that lets the user define a system prompt
with variable placeholders (`[type:name]`) and conditionals (`[if]`/`[else]`/`[endif]`).
Variables are resolved at **construction time** (not every turn) to preserve the prompt
cache.

Hard requirements:
- Template persisted globally; resolved system prompt persisted **per conversation**.
- **Cache-safe:** constructed once (first turn), reused on all subsequent turns.
  Reconstructed only on **compaction** (fresh variable resolution).
- Compaction appends its instructions to the constructed system prompt.
- API: GET/PUT template, GET available variables.
- Frontend: full-page modal (text editor + variable selector buttons).

## 2. Template format

### Variable insertion
```
[type:name]
```
Resolves the variable at construction time. Unknown type → blank string.
Non-existent variable (e.g. file not found) → blank string.

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
- Multi-line content between tags: supported.
- Unmatched `[if]`/`[endif]`: treated as literal text (not parsed).

### Edge cases
- Unknown variable type (e.g. `[unknown:foo]`) → blank string.
- File read failure → variable is "not existing" → blank string; `[if]` → skipped.
- Empty template → no system prompt sent (current behavior preserved).

## 3. Variable types

| Type:Name | Description | Source |
|---|---|---|
| `system:time` | Current time (ISO 8601) | `new Date().toISOString()` |
| `system:date` | Current date (YYYY-MM-DD) | derived from `new Date()` |
| `system:os` | Operating system | `process.platform` |
| `system:hostname` | Machine hostname | `require("node:os").hostname()` |
| `prompt:cwd` | Conversation's working directory | passed from session-orchestrator |
| `prompt:model` | Current model name | passed from session-orchestrator |
| `prompt:conversation_id` | Conversation ID | passed from session-orchestrator |
| `git:branch` | Current git branch | `git rev-parse --abbrev-ref HEAD` in cwd |
| `git:status` | Short git status | `git status --short` in cwd |
| `file:<path>` | File contents (relative to cwd, or absolute if starts `/`) | `fs.readText` |

The `file:` type is **dynamic** — any path is a valid variable name. All others have
fixed names. The `git:` variables require `spawn` capability; failures (not a git repo,
git not installed) → variable is "not existing" → blank string.

## 4. Caching constraint (critical)

**The system prompt is constructed ONCE (on the first turn of a conversation) and
persisted.** Subsequent turns reuse the persisted system prompt — no reconstruction.
This preserves the prompt cache (the system prompt is part of the cacheable prefix).

**Reconstruction happens only on compaction** (the conversation is being summarized,
so fresh variable resolution makes sense — files may have changed, cwd may have changed,
the time is stale).

Flow:
1. **First turn** (new conversation): session-orchestrator detects `getConversationMeta
   === null` → calls `systemPromptService.construct(conversationId, cwd, {model})` →
   resolves all variables → persists the result → returns the string → sets on
   `providerOpts.systemPrompt`.
2. **Subsequent turns:** session-orchestrator calls
   `systemPromptService.get(conversationId)` → returns the persisted string (or null if
   never constructed) → sets on `providerOpts.systemPrompt` (or omits if null).
3. **Compaction turn:** session-orchestrator calls
   `systemPromptService.construct(conversationId, cwd, {model})` → gets fresh resolved
   system prompt → appends `COMPACTION_SYSTEM_PROMPT` → uses the combined string as the
   compaction turn's system prompt. The `construct` call also persists the reconstructed
   system prompt (without compaction instructions) for future turns.
4. **Post-compaction turns:** session-orchestrator calls
   `systemPromptService.get(conversationId)` → returns the reconstructed system prompt.

Changing the template (via `PUT /system-prompt`) does NOT affect existing conversations
until they are compacted. New conversations use the new template on their first turn.

## 5. Default template

When no template has been set, a built-in default is used:
```
You are a helpful coding assistant.

[if file:AGENTS.md]
[file:AGENTS.md]
[endif]

The current working directory is [prompt:cwd].
```

## 6. Architecture

### `system-prompt` extension (new, standard tier)

**Manifest:** `id: "system-prompt"`, `capabilities: { fs: true, spawn: true }`,
`dependsOn: []` (depends only on kernel contracts).

**Pure parser** (`parser.ts`):
- `parseTemplate(template: string, resolvedVars: Map<string, string | null>): string`
- Handles `[type:name]` insertion, `[if]`/`[else]`/`[endif]` conditionals, nesting.
- Pure: input → output, no I/O. Fully testable with zero mocks.

**Variable resolver** (`resolver.ts`):
- `resolveVariables(cwd: string, context?: { model?: string; conversationId?: string }):
  Promise<Map<string, string | null>>`
- Reads files (`fs` capability), runs git commands (`spawn` capability), gets system
  info. Injected adapters (same pattern as LSP extension).
- Returns `Map<string, string | null>` — `null` means "not existing" (file not found,
  git not available, etc.).

**Variable catalog** (`catalog.ts`):
- `getVariableCatalog(): SystemPromptVariable[]` — the static list of available variables
  (for `GET /system-prompt/variables`). The `file:` type is marked `dynamic: true`.

**Service handle** (`types.ts`):
```ts
export interface SystemPromptService {
    construct(conversationId: string, cwd: string, context?: {
        readonly model?: string;
    }): Promise<string>;
    get(conversationId: string): Promise<string | null>;
}
```
- `construct`: reads the template from storage, resolves all variables, persists the
  result under `system-prompt:resolved:<conversationId>`, returns the string.
- `get`: reads the persisted result (or null).

**Storage:**
- Template: `host.storage("system-prompt")` key `"template"` (global).
- Resolved system prompt: `host.storage("system-prompt")` key
  `"resolved:<conversationId>"` (per conversation).

### Session-orchestrator integration

The session-orchestrator wires `systemPromptService` as an **optional dep** (same pattern
as `message-queue` / `toolsFilter` — lazily via `host.getService(systemPromptHandle)` in
`activate`). If the system-prompt extension isn't loaded, no system prompt is sent
(current behavior preserved).

Changes in `orchestrator.ts`:
1. **Turn flow (~line 461):** after resolving `effectiveCwd`, determine if this is the
   first turn (new conversation) or a subsequent turn:
   - First turn (new conversation, detected via `getConversationMeta === null` already
     checked earlier for workspace assignment): call
     `deps.resolveSystemPrompt?.construct(conversationId, effectiveCwd, { model: modelName })`.
   - Subsequent turns: call `deps.resolveSystemPrompt?.get(conversationId)`.
   - If the result is non-null, set it on `providerOpts.systemPrompt`.
2. **Compaction flow (~line 911):** currently sets `systemPrompt: COMPACTION_SYSTEM_PROMPT`.
   Change to: call `deps.resolveSystemPrompt?.construct(conversationId, cwd, { model })` →
   get the constructed system prompt → append `"\n\n" + COMPACTION_SYSTEM_PROMPT` → set on
   `providerOpts.systemPrompt`. If the service is unavailable, fall back to just
   `COMPACTION_SYSTEM_PROMPT` (current behavior).

### API endpoints (transport-http)

| Method | Path | Description |
|---|---|---|
| GET | `/system-prompt` | Returns `{ template: string }` |
| PUT | `/system-prompt` | Body `{ template: string }` → persists, returns `{ template: string }` |
| GET | `/system-prompt/variables` | Returns `{ variables: SystemPromptVariable[] }` |

The transport-http extension calls the `systemPromptHandle` service for these (same
pattern as `lspServiceHandle` for the LSP status endpoint). If the service is unavailable,
`GET` returns the default template, `PUT` returns 503, `GET /variables` returns the
static catalog.

## 7. Units & waves

### Wave 0 (orchestrator, contracts)
- `transport-contract`: add `SystemPromptTemplateResponse`,
  `SetSystemPromptTemplateRequest`, `SystemPromptVariable`,
  `SystemPromptVariablesResponse`. Version bump.

### Wave 1
- `system-prompt` (NEW extension): pure parser + variable resolver + catalog + storage
  + service handle. Depends only on kernel contracts. Tests: parser (pure, zero mocks),
  resolver (injected adapters), catalog.

### Wave 2 (parallel — disjoint packages)
- `session-orchestrator`: wire `systemPromptService` as optional dep; construct on first
  turn, get on subsequent, construct+append on compaction. + tests.
- `transport-http`: add `GET/PUT /system-prompt` + `GET /system-prompt/variables` routes.
  + tests.

### Wave 3
- `host-bin`: register `system-prompt` in `CORE_EXTENSIONS`.
- Orchestrator: root tsconfig ref + `bun install`.

### Wave 4
- Full-graph verify + FE courier handoff.
