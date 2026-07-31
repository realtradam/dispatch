# Deferred Tool Loading — Provider Compatibility & Codebase Findings

> **Status:** Research complete. Confirms the architecture proposed in the previous
> research round and maps it to Dispatch's actual provider adapters.
> **Date:** 2026-07-31

---

## 1. What we confirmed from primary sources

### Anthropic — tool search (Messages API)

**Source:** [Anthropic Tool Search Tool](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/tool-search-tool)

- Tool search is a **server-side tool** on the Anthropic Messages API (`/v1/messages`).
- Two variants: `tool_search_tool_regex_20251119` (Claude writes Python regex) and
  `tool_search_tool_bm25_20251119` (Claude writes natural-language queries).
- You still send **every tool's full definition** in the `tools` array on every request,
  including deferred ones. `defer_loading: true` controls what enters the model's context,
  not what you send over the wire.
- The API **excludes deferred tools from the system-prompt prefix**, so prompt caching is
  preserved. When Claude discovers a tool, the API appends a `tool_reference` block inline
  and auto-expands it into the full definition.
- **Model support:** Claude Opus 5, Opus 4.5/4.6/4.7/4.8, Sonnet 4.5/4.6, Haiku 4.5,
  Fable 5, Mythos 5. **Not** Opus 4.1 and earlier.
- **Custom client-side tool search:** a custom tool can return `tool_reference` blocks in
  its `tool_result`, and the API expands them the same way. This is the hook that connects
  Dispatch's `load_skill` result to tool disclosure.
- Limits: 10,000 deferred tools per request; 5 results per search; 200-char regex / 500-char
  BM25 query max.
- A `defer_loading: true` tool **cannot** also carry `cache_control` (400 error).

### OpenAI — tool search (Responses API only)

**Source:** [OpenAI Tool Search Guide](https://platform.openai.com/docs/guides/tools-tool-search)

- Tool search is a **Responses API feature** (`client.responses.create()`), **NOT** available
  on the Chat Completions API.
- Only **gpt-5.4 and later** models support `tool_search`.
- Activation: add `{ "type": "tool_search" }` to the `tools` array, and mark deferred
  functions with `defer_loading: true`.
- **Namespaces** are the recommended grouping mechanism:
  ```json
  {
    "type": "namespace",
    "name": "agent_management",
    "description": "Tools for managing delegated agent conversations.",
    "tools": [
      { "type": "function", "name": "summon_agent", "defer_loading": true, ... }
    ]
  }
  ```
  For namespaces, `defer_loading` applies to functions inside, not the namespace object.
  The model sees only the namespace name + description initially; individual function
  details load through tool search.
- Best practice: **fewer than 10 functions per namespace** for token efficiency.
- Two modes:
  - **Hosted tool search:** OpenAI searches the deferred tools you declared and returns
    the loaded subset in the same response (`tool_search_call` + `tool_search_output` items).
  - **Client-executed tool search:** the model emits a `tool_search_call`, your app performs
    the lookup, and you return a `tool_search_output` with the loaded tools. Tools need not
    have been in the original request (advanced workflow).
- **Cache preservation:** all loaded tools are injected at the end of the context window,
  so the model's cache prefix is untouched.
- **`additional_tools` input item:** for advanced workflows, a `developer`-role input item
  with a `tools` array makes tools available at a specific point in the conversation.

### OpenAI Chat Completions — no tool search

**Source:** [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)

- The function calling guide describes tool search as a Responses API feature and links to
  the tool search guide. Chat Completions requests remain non-strict by default and have no
  `tool_search`, `defer_loading`, or `namespace` tool types.
- **Conclusion:** the Chat Completions API does not support deferred tool loading or tool
  search. Providers that only speak Chat Completions cannot use this mechanism natively.

---

## 2. Dispatch's actual provider adapters — what the code does today

### Provider landscape

| Provider ID | Package | Wire endpoint | Tool format | External? |
|---|---|---|---|---|
| `openai-compat` | `packages/provider-openai-compat/` | `${baseURL}/chat/completions` | `{ type: "function", function: { name, description, parameters } }` | In-repo |
| `umans` | `packages/provider-umans/` | `${baseURL}/chat/completions` | Same (uses `openai-stream` factory) | In-repo |
| `longcat` | `packages/provider-longcat/` | `${baseURL}/chat/completions` | Same (uses `openai-stream` factory) | In-repo |
| `anthropic` | `claude/packages/provider-anthropic/` | `${baseURL}/messages` | `{ name, description, input_schema }` | External (claude/ repo) |
| `openai` (Codex) | *not found in any repo* | *unknown — no provider extension exists* | *unknown* | External (planned?) |

### Key codebase findings

1. **`ToolContract` (kernel contract)** — `packages/kernel/src/contracts/tool.ts`:
   ```ts
   interface ToolContract {
     readonly name: string;
     readonly description: string;
     readonly parameters: ToolParameterSchema;
     readonly execute: (args, ctx) => Promise<ToolResult>;
     readonly concurrencySafe?: boolean;
   }
   ```
   No `loading`, `deferred`, `namespace`, or `defer_loading` field. All tools are immediate.

2. **`ProviderContract.stream`** — `packages/kernel/src/contracts/provider.ts`:
   ```ts
   stream: (messages, tools: readonly ToolContract[], opts?) => AsyncIterable<ProviderEvent>
   ```
   All tools are passed at once. No mechanism for deferred disclosure or tool-reference
   events. The `ProviderEvent` union has no `tool-reference` or `tool-search` event type.

3. **OpenAI-compatible serialization** — `packages/openai-stream/src/convert-tools.ts`:
   ```ts
   function convertTool(tool: ToolContract): OpenAITool {
     return { type: "function", function: { name, description, parameters } };
   }
   ```
   Standard Chat Completions function tool format. No `defer_loading` or `namespace`.

4. **OpenAI-compatible stream** — `packages/openai-stream/src/stream.ts`:
   - Hits `${baseURL}/chat/completions` (Chat Completions endpoint, not Responses).
   - Has a `transformBody` hook for provider-specific body fields (e.g. `reasoning_effort`).
   - No support for Responses API, namespaces, or tool search.

5. **Anthropic serialization** — `claude/packages/provider-anthropic/src/convert.ts`:
   ```ts
   function convertTools(tools: readonly ToolContract[]): AnthropicTool[] {
     return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
   }
   ```
   Standard Anthropic Messages API tool format. No `defer_loading`.

6. **Anthropic stream** — `claude/packages/provider-anthropic/src/stream.ts`:
   - Hits `${baseURL}/messages` (Anthropic Messages API).
   - Body: `{ model, max_tokens, system, messages, stream, tools?, thinking? }`.
   - No tool search tool, no `defer_loading`, no `tool_reference` handling.

7. **No Codex/OpenAI Responses provider exists.** The `host-bin/src/main.ts` checks for an
   external extension contributing `"openai"` providers and registers a `codex` credential,
   but no such extension exists in the `claude/` repo or any other repo in the workspace.
   `/etc/dispatch/env` has no `DISPATCH_EXTERNAL_EXTENSIONS` or `DISPATCH_CODEX_CREDENTIAL_KEY`.
   The "Codex subscription" provider mentioned in the research note is **planned but not yet
   built** — there is no Responses API integration in the codebase today.

8. **Currently configured providers** (from `/etc/dispatch/env`):
   - Umans (`UMANS_API_KEY` set) → Chat Completions
   - LongCat (`LONGCAT_API_KEY` set) → Chat Completions
   - Anthropic (loaded from `claude/` repo via `DISPATCH_EXTERNAL_EXTENSIONS`) → Messages API

---

## 3. Provider-capability matrix for deferred tool loading

| Provider | API | Tool search support | Deferred loading | Namespaces | Cache preserved | Model gate |
|---|---|---|---|---|---|---|
| **Anthropic** | Messages (`/v1/messages`) | ✅ Server-side (`tool_search_tool_regex/bm25`) + custom client-side | ✅ `defer_loading: true` | ❌ (use tool-name prefixes instead) | ✅ (deferred tools excluded from prefix) | Opus 4.5+, Sonnet 4.5+, Haiku 4.5+ |
| **OpenAI Responses** | Responses (`/v1/responses`) | ✅ Hosted + client-executed | ✅ `defer_loading: true` | ✅ `{ type: "namespace", ... }` | ✅ (tools loaded at end of context) | gpt-5.4+ only |
| **OpenAI Chat Completions** (umans, longcat, openai-compat) | Chat Completions (`/chat/completions`) | ❌ Not supported | ❌ Not supported | ❌ Not supported | N/A | N/A |
| **Codex/OpenAI** (planned, not built) | *unknown* | *unknown* | *unknown* | *unknown* | *unknown* | *unknown* |

---

## 4. Implications for the agent-management plan

### 4.1 The kernel contract needs generic metadata, not agent-specific concepts

The plan's §6 proposal is correct: add generic optional fields to `ToolContract`:

```ts
interface ToolContract {
  // existing fields...
  readonly loading?: "immediate" | "deferred";
  readonly namespace?: string;
}
```

This is safe because the kernel never names a concrete feature — it just carries generic
metadata that provider adapters interpret.

### 4.2 The provider contract needs deferred-tool and tool-reference event support

Currently `ProviderContract.stream` takes all tools at once and the `ProviderEvent` union
has no tool-reference events. To support deferred tool loading, the provider contract needs:

1. A way for providers to signal that a tool was discovered/loaded (a new `ProviderEvent`
   type, or the provider handles it internally and only emits standard `tool-call` events).
2. For client-executed tool search (the most likely Dispatch integration path): the provider
   emits a tool-search-call event, the harness resolves it (via `load_skill`), and sends the
   result back on the next provider step.

However, for **hosted/server-side tool search** (Anthropic's built-in `tool_search_tool_*`
and OpenAI's hosted `tool_search`), the provider handles everything internally — it sends
the tool catalog with `defer_loading` flags, and the API returns normal `tool_use`/`function_call`
blocks. The harness doesn't need to participate in the search at all. This is the simplest
path.

### 4.3 The integration path differs per provider

**Anthropic (Messages API, currently in production):**
- Add `defer_loading: true` to the Anthropic tool serialization in `convert.ts`.
- Add the tool search tool (`tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119`)
  to the `tools` array when deferred tools are present.
- For skill-triggered disclosure (connecting `load_skill` to tool disclosure): use **custom
  client-side tool search** — a custom tool returns `tool_reference` blocks in its
  `tool_result`, and the API expands them. This is the Anthropic-native way to connect a
  skill-load result to tool disclosure.
- The provider's `stream.ts` already hits `/v1/messages` — no endpoint change needed.
- Must handle `server_tool_use` and `tool_search_tool_result` blocks in the response stream.
- **Cache note:** a `defer_loading: true` tool cannot carry `cache_control` — put cache
  breakpoints on non-deferred tools only.

**OpenAI Responses API (not yet built — would need a new provider extension):**
- Requires a new provider extension that hits `/v1/responses` instead of `/chat/completions`.
- The `openai-stream` library cannot be reused as-is — it's Chat Completions only.
- Supports namespaces (better than Anthropic's prefix convention for grouping).
- Only gpt-5.4+ models support it.
- This is a **separate, larger effort** — building a Responses API provider is out of scope
  for the agent-management feature.

**Chat Completions providers (umans, longcat, openai-compat):**
- **No native deferred tool loading.** The Chat Completions API does not support
  `tool_search`, `defer_loading`, or namespaces.
- **Fallback:** always-visible real tools (all tool definitions sent immediately). This
  preserves typed tool calls but loses the context savings.
- The `transformBody` hook could theoretically strip tools, but there's no provider-side
  mechanism to re-add them mid-conversation on Chat Completions.

### 4.4 The Codex subscription endpoint question (from the research note)

The research note asked: *"whether the Codex subscription endpoint is documented to accept
the newer Responses tool_search items rather than merely ordinary function tools."*

**Answer:** There is no Codex provider in the codebase. The `host-bin/src/main.ts` has
scaffolding for an external `"openai"` provider (the `codex` credential), but no extension
implements it. OpenAI's tool search is a **Responses API** feature. If the Codex subscription
uses a Responses-shaped endpoint, it would support `tool_search` — but this cannot be
verified from the codebase because the provider doesn't exist yet. When a Codex/Responses
provider is built, it should use the Responses API's native `tool_search` + namespace
mechanism.

### 4.5 Recommended fallback policy (confirmed)

The previous research recommended: *"Deferred real tools where the model/provider supports
them; always-visible real tools as the fallback."*

This is confirmed by the codebase findings:
- **Anthropic (Messages API):** supports deferred tools natively → use them.
- **Chat Completions providers (umans, longcat):** no deferred tool support → always-visible
  real tools as fallback. Typed tool calls preserved, just no context savings.
- **OpenAI Responses (future):** supports deferred tools natively → use them when built.

This keeps the implementation typed (no generic dispatcher) and avoids maintaining two
operation protocols. The only cost is that Chat Completions providers carry all tool
definitions in context — which is the status quo anyway.

### 4.6 What the agent-management extension should do

1. **Declare all seven tools with `loading: "deferred"` and `namespace: "agent_management"`.**
2. **The Anthropic provider adapter** translates `loading: "deferred"` → `defer_loading: true`
   and wraps the namespace into the tool search catalog. The skill-load result triggers
   custom client-side tool search (returns `tool_reference` blocks).
3. **The Chat Completions provider adapters** ignore `loading`/`namespace` metadata and send
   all tools as immediate function definitions (the fallback).
4. **A future OpenAI Responses provider** would translate `loading: "deferred"` →
   `defer_loading: true` inside a `{ type: "namespace", ... }` and use hosted or
   client-executed `tool_search`.
5. **Vision isolation still wins last:** a `toolPolicy: none` conversation removes
   agent-management tools from the executable catalog before the provider sees anything.
   There are no deferred definitions to discover, no skill can reveal them, and provider-side
   tool search cannot bypass the restriction.

---

## 5. Primary sources

- [Anthropic: Tool Search Tool](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/tool-search-tool)
- [Anthropic: Tool Use Overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
- [OpenAI: Tool Search Guide](https://platform.openai.com/docs/guides/tools-tool-search)
- [OpenAI: Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)
- [OpenAI: Using Tools Overview](https://platform.openai.com/docs/guides/tools)

## 6. Codebase files examined

- `backend/packages/kernel/src/contracts/tool.ts` — `ToolContract` (no deferred fields)
- `backend/packages/kernel/src/contracts/provider.ts` — `ProviderContract` (all tools at once)
- `backend/packages/openai-stream/src/convert-tools.ts` — Chat Completions tool serialization
- `backend/packages/openai-stream/src/stream.ts` — Chat Completions stream (`/chat/completions`)
- `backend/packages/openai-stream/src/provider.ts` — `createOpenAICompatProvider` factory
- `backend/packages/provider-openai-compat/src/extension.ts` — openai-compat provider
- `backend/packages/provider-umans/src/extension.ts` — Umans provider (uses openai-stream)
- `backend/packages/provider-longcat/src/extension.ts` — LongCat provider (uses openai-stream)
- `backend/packages/host-bin/src/main.ts` — provider registration, Codex scaffolding
- `claude/packages/provider-anthropic/src/extension.ts` — Anthropic provider (external)
- `claude/packages/provider-anthropic/src/convert.ts` — Anthropic tool serialization
- `claude/packages/provider-anthropic/src/stream.ts` — Anthropic stream (`/v1/messages`)
- `/etc/dispatch/env` — configured provider keys (no Codex/OpenAI configured)
