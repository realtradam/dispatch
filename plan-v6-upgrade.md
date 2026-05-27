# AI SDK v4 → v6 Upgrade Plan

## Why

The `reasoning-signature without reasoning` bug we've been fighting is a v4
SDK artefact:

  - `@ai-sdk/anthropic@1.x` emits Anthropic's `signature_delta` as a
    separate stream chunk (`reasoning-signature`). The SDK accumulator
    requires every signature to follow a `reasoning` chunk; Anthropic's
    adaptive thinking happily emits empty thinking blocks (signature only,
    no `thinking_delta`), which trips an `InvalidStreamPartError`.
  - Sending a thinking block back to Anthropic without its signature is
    rejected. Our chunk store had no signature field, so the round-trip
    failed.

Both classes of bug are **gone in v6** because:

  - `@ai-sdk/anthropic@3.x` packages Anthropic's signature inside
    `providerMetadata` on the `reasoning-end` stream event. There is no
    separate `reasoning-signature` chunk to orphan.
  - `providerOptions` on a v6 `ReasoningPart` carries the metadata back
    verbatim, so the round-trip Just Works.
  - v6 `@ai-sdk/anthropic@3.x` natively supports
    `providerOptions.anthropic.thinking = { type: "adaptive" }` — the
    `rewriteBodyForOpus47` custom-fetch hack disappears.
  - v6 `createAnthropic({ authToken })` natively supports OAuth Bearer
    auth — the `customFetch` that swaps `x-api-key` for `Authorization:
    Bearer` also disappears.

The opencode reference at `../opencode-patch/opencode/` runs the same
extended-thinking flow on v6 with none of the workarounds we've been
piling onto v4.

## Versions

| Package | v4 (current) | v6 (target) |
|---|---|---|
| `ai` | `4.3.19` | `6.0.191` |
| `@ai-sdk/anthropic` | `1.2.12` | `3.0.79` |
| `@ai-sdk/openai-compatible` | `0.2.x` | `2.0.48` |
| `@ai-sdk/provider` | `1.1.3` | `3.0.10` |
| `@ai-sdk/provider-utils` | `2.2.8` | `4.0.27` |
| Middleware spec | `v1` | `v3` |

`packages/core/package.json` already bumped; `bun install` already done.

## What we keep from the current codebase

- **The whole `Chunk` model.** `ChatMessage { chunks: Chunk[] }` stays as
  the canonical persisted shape. Renderers, DB layer, and the frontend
  store are unchanged in their architecture.
- **The outer manual tool loop** in `Agent.run()`. We run tools ourselves
  for permission prompts, shell-output streaming, and queued-message
  injection. The SDK is given tools without `execute` so it never
  auto-runs them.
- **`appendEventToChunks` as the single source of event → chunk truth.**
  Frontend store + backend agent both call into it.
- **`createToolRegistry` indirection.** Our internal `ToolDefinition`
  shape stays; only the registry's conversion to AI SDK tools changes.
- **The agent-manager broadcaster.** `AgentEvent` shape changes (see
  below); the broadcast plumbing does not.

## What changes (high level)

| Surface | v4 | v6 |
|---|---|---|
| Message type | `CoreMessage` | `ModelMessage` |
| Streaming events | `text-delta` + `reasoning` + `reasoning-signature` + `tool-call` | `text-start/-delta/-end`, `reasoning-start/-delta/-end`, `tool-input-start/-delta/-end`, `tool-call`, `tool-result`, `tool-error`, `start-step`, `finish-step`, `start`, `finish`, `abort`, `error` |
| Reasoning signature | separate `reasoning-signature` event | `providerMetadata` on `reasoning-end` |
| Tool definition | `tool({ parameters: ZodSchema })` | `tool({ inputSchema: jsonSchema(...) })` |
| Tool call payload | `args` | `input` |
| Tool result payload | raw value | `ToolResultOutput` (`{ type: "text"; value: string }` etc.) |
| Token budget | `maxTokens` | `maxOutputTokens` |
| OAuth | custom fetch swapping `x-api-key` → `Authorization: Bearer` | `createAnthropic({ authToken })` |
| Opus 4.7 thinking | body-rewrite injection of `thinking: { type: "adaptive" }` | `providerOptions.anthropic.thinking = { type: "adaptive" }` (native) |
| Middleware spec | `"v1"`, `transformParams({ type, params })` returning params | `"v3"`, `transformParams({ type, params, model })` returning `LanguageModelV3CallOptions` |

## Canonical types (locked)

### Chunk (no breaking changes vs. current HEAD, signature added back)

`packages/core/src/types/index.ts` and mirrored in
`packages/frontend/src/lib/types.ts`:

```ts
export type Chunk =
  | TextChunk
  | ThinkingChunk
  | ToolBatchChunk
  | ErrorChunk
  | SystemChunk;

export interface TextChunk {
  type: "text";
  text: string;
}

export interface ThinkingChunk {
  type: "thinking";
  text: string;
  /**
   * Full Anthropic `providerMetadata` blob captured from the
   * `reasoning-end` stream event. Round-tripped verbatim as
   * `providerOptions` on the ReasoningPart in the next request so
   * Anthropic can validate the thinking block's signature. Optional
   * because non-Anthropic models don't produce one.
   */
  metadata?: Record<string, unknown>;
}

export interface ToolBatchChunk {
  type: "tool-batch";
  calls: ToolBatchEntry[];
}

export interface ToolBatchEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  shellOutput?: { stdout: string; stderr: string };
}

export interface ErrorChunk {
  type: "error";
  message: string;
  statusCode?: number;
}

export type SystemChunkKind = "notice" | "model-changed" | "config-reload" | "cancelled";

export interface SystemChunk {
  type: "system";
  kind: SystemChunkKind;
  text: string;
}
```

### AgentEvent (one new variant, otherwise unchanged)

```ts
export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  // NEW: emitted on the v6 `reasoning-end` stream event when it carries
  // providerMetadata. `appendEventToChunks` attaches the blob to the
  // most recent unsealed thinking chunk; `toModelMessages` reads it back
  // out as `providerOptions` on the ReasoningPart in the next request.
  | { type: "reasoning-end"; metadata?: Record<string, unknown> }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "tool-result"; toolResult: ToolResult }
  | { type: "shell-output"; data: string; stream: "stdout" | "stderr" }
  | { type: "error"; error: string; statusCode?: number }
  | { type: "notice"; message: string }
  | { type: "model-changed"; keyId: string; modelId: string }
  | { type: "done"; message: ChatMessage }
  | { type: "task-list-update"; tasks: TaskItem[] }
  | { type: "config-reload" }
  | { type: "tab-created"; id: string; title: string; keyId: string | null;
      modelId: string | null; parentTabId: string | null;
      workingDirectory: string | null }
  | { type: "message-queued"; tabId: string; messageId: string; message: string }
  | { type: "message-consumed"; tabId: string; messageIds: string[] }
  | { type: "message-cancelled"; tabId: string; messageId: string };
```

### appendEventToChunks sealing semantics

A `thinking` chunk is *sealed* once it has a `metadata` field. A
`reasoning-delta` after a sealed chunk opens a new chunk. A
`reasoning-end` walks back to the most recent unsealed chunk and
attaches metadata. (Same shape as the current code; just renamed from
the v4-era "signature".)

```ts
case "reasoning-delta": {
  const last = chunks[chunks.length - 1];
  if (last && last.type === "thinking" && last.metadata === undefined) {
    last.text += event.delta;
  } else {
    chunks.push({ type: "thinking", text: event.delta });
  }
  return;
}

case "reasoning-end": {
  if (event.metadata === undefined) return;          // nothing to attach
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i];
    if (!c || c.type !== "thinking") continue;
    if (c.metadata !== undefined) return;            // already sealed
    c.metadata = event.metadata;
    return;
  }
  return;                                             // orphan — drop
}
```

## Stream event → AgentEvent mapping (agent.ts)

| v6 fullStream chunk | AgentEvent we emit |
|---|---|
| `start` | none (ignored) |
| `text-start { id }` | none |
| `text-delta { id, text }` | `{ type: "text-delta", delta: text }` |
| `text-end { id }` | none |
| `reasoning-start { id }` | none |
| `reasoning-delta { id, text }` | `{ type: "reasoning-delta", delta: text }` |
| `reasoning-end { id, providerMetadata }` | `{ type: "reasoning-end", metadata: providerMetadata }` (only when metadata is present, otherwise none) |
| `tool-input-start/-delta/-end` | none (we don't surface argument streaming to the UI) |
| `tool-call { toolCallId, toolName, input }` | `{ type: "tool-call", toolCall: { id: toolCallId, name: toolName, arguments: input } }` |
| `tool-result` | none — the SDK only emits this if the tool's `execute` ran. Our SDK tools have no `execute` (see below), so this never fires from the stream. The agent's manual executor emits `tool-result` events itself. |
| `tool-error` | log + treat as an SDK-level error (defensive) |
| `start-step` / `finish-step` | none (we manage steps ourselves) |
| `abort { reason }` | `{ type: "error", error: "aborted: " + reason }` (defensive; we don't currently abort streams from agent.ts) |
| `error { error }` | `{ type: "error", error: formatError(error, config), statusCode? }` |
| `finish { finishReason, totalUsage }` | none (we break out of the step loop based on whether the step emitted any tool-call) |
| `raw` | none |

## toModelMessages (replaces v4 toCoreMessages)

Same shape as today, with these changes:

- Renamed: `toCoreMessages` → `toModelMessages`, return `ModelMessage[]`.
- `ReasoningPart`:
  ```ts
  case "thinking":
    parts.push({
      type: "reasoning",
      text: chunk.text,
      ...(chunk.metadata !== undefined
        ? { providerOptions: chunk.metadata as ProviderOptions }
        : {}),
    });
    break;
  ```
  No "skip signatureless chunks" branch — even bare reasoning is legal
  in v6 (it's just sent without providerOptions). Anthropic accepts that;
  it just doesn't use the absent signature.

- `ToolCallPart`:
  ```ts
  parts.push({
    type: "tool-call",
    toolCallId: entry.id,
    toolName,
    input: entry.arguments,        // was: args
  });
  ```

- `ToolResultPart`:
  ```ts
  result.push({
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: { type: "text", value: tr.result },   // was: result
    }],
  });
  ```

- **Anthropic structural normalisations** (cribbed from opencode
  `provider/transform.ts`):
  1. Filter out `text` / `reasoning` parts whose `text === ""`. Drop
     messages whose content array becomes empty.
  2. For assistant messages whose content contains at least one
     `tool-call` followed by a non-`tool-call` part, split into two
     consecutive assistant messages: `[non-tool parts] + [tool-call parts]`.
     Anthropic rejects `[tool_use, text]` ordering with
     "`tool_use` ids were found without `tool_result` blocks immediately
     after". opencode does this at `transform.ts:124-148`.

  Both apply only when the active provider is Anthropic (Claude OAuth or
  `opencode-anthropic`). Skip for OpenCode Zen / openai-compatible.

## Provider (provider.ts)

### Claude OAuth (anthropic provider)

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

function createClaudeOAuthProvider(config: ProviderConfig): ModelFactory {
  const anthropic = createAnthropic({
    baseURL: config.baseURL || "https://api.anthropic.com/v1",
    authToken: config.claudeCredentials?.accessToken ?? config.apiKey,
    headers: {
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.112 (external, sdk-cli)",
    },
  });
  return (modelId: string) => anthropic(modelId);
}
```

- `authToken` replaces the v4 customFetch + apiKey-swap dance.
- `rewriteBodyForOpus47` deleted. Opus 4.7 thinking is configured via
  `providerOptions.anthropic.thinking = { type: "adaptive" }` in agent.ts.

### Plain-API-key Anthropic (opencode-go MiniMax/Qwen)

```ts
function createApiKeyAnthropicProvider(config: ProviderConfig): ModelFactory {
  const anthropic = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL || "https://opencode.ai/zen/go/v1",
  });
  return (modelId: string) => anthropic(modelId);
}
```

### OpenAI-compatible (default)

`createOpenAICompatible` API is unchanged (`{ name, apiKey, baseURL }`).

### Middleware (v3 spec) for `normalizeMessages` tweak

OpenCode Go MiniMax/Qwen still need the reasoning-text-stripping
middleware we have today. The v3 spec changes from v1:

```ts
const middleware: LanguageModelV3Middleware = {
  specificationVersion: "v3" as const,         // ← v3 spec replaces v4's "v1" — actual field name is `specificationVersion`
  async transformParams({ type, params, model }) {
    if (type === "stream" && params.prompt) {
      return {
        ...params,
        prompt: normalizeMessages(params.prompt as unknown[]) as LanguageModelV3Prompt,
      };
    }
    return params;
  },
};
return wrapLanguageModel({ model: provider(modelId), middleware: [middleware] });
```

(`LanguageModelV3Middleware` type and `specificationVersion` field — re-exported as `LanguageModelMiddleware` from `ai`, and as `LanguageModelV3Middleware` from `@ai-sdk/provider@3.x`.)

## Tools (tools/registry.ts)

v6 tool factory:

```ts
import { tool, jsonSchema } from "ai";
import { z, type ZodTypeAny } from "zod";

function zodToJsonSchema(schema: ZodTypeAny): unknown {
  // tiny helper — most opencode/AI-SDK examples use a third-party
  // zod-to-json-schema package, but for our simple parameter objects
  // the AI SDK's `jsonSchema()` wrapper accepts raw JSONSchema7 directly.
  // We can import zod-to-json-schema OR keep using our existing
  // (zod-style) ToolDefinition.parameters as-is and pass through
  // `tool({ inputSchema: <jsonSchemaOrZod> })`.
  ...
}

function toAISDKTool(def: ToolDefinition) {
  return tool({
    description: def.description,
    inputSchema: jsonSchema(zodToJsonSchema(def.parameters)),
    // NO execute: we don't want the SDK to auto-run tools. We collect
    // tool-call events from fullStream, run tools ourselves with
    // permission/shell-output streaming, then push the results as a
    // tool ModelMessage in the next streamText call.
  });
}
```

**Decision: use `zod` v4's built-in `z.toJSONSchema()` if available, else
add `zod-to-json-schema` as a dep.** Our zod version is `^3.23.0`; we
need to verify what's available. If neither, the Agent C task will
include adding `zod-to-json-schema` as a dependency.

## File ownership for parallel implementation

### Phase 0 — me, sequential (load-bearing, no parallel work safe)

| File | Change |
|---|---|
| `packages/core/src/types/index.ts` | Add `metadata?` to `ThinkingChunk`; add `reasoning-end` variant to `AgentEvent`; everything else unchanged |
| `packages/core/src/chunks/append.ts` | Replace `signature` handling with `metadata`; add `reasoning-end` case; update jsdoc table |
| `packages/core/tests/chunks/append.test.ts` | Replace `rs` helper with `re` (reasoning-end), exercise new sealing semantics + walk-back + orphan-drop |
| `packages/frontend/src/lib/types.ts` | Mirror the `metadata` + `reasoning-end` additions |
| `packages/frontend/src/lib/tabs.svelte.ts` | Add `reasoning-end` to the `applyChunkEvent` switch case |

After Phase 0: `bun run --cwd packages/core test tests/chunks` MUST pass.
Everything else will still be broken until Phase 1 lands.

### Phase 1 — parallel sonnet agents, disjoint file ownership

| Agent | Owns | Cannot touch |
|---|---|---|
| **A: agent** | `packages/core/src/agent/agent.ts`, `packages/core/tests/agent/agent.test.ts` | provider.ts, registry.ts, types.ts |
| **B: provider** | `packages/core/src/llm/provider.ts`, `packages/core/tests/llm/provider.test.ts` | agent.ts, registry.ts |
| **C: tools** | `packages/core/src/tools/registry.ts`, `packages/core/tests/tools/registry.test.ts` (only registry; do NOT touch individual tool files like `read-file.ts`), `packages/core/package.json` (may add `zod-to-json-schema` dep) | agent.ts, provider.ts |
| **D: api** | `packages/api/src/agent-manager.ts`, `packages/api/tests/agent-manager.test.ts` | anything in core/src |
| **E: frontend** | `packages/frontend/src/lib/components/ChatMessage.svelte`, `packages/frontend/tests/chat-store.test.ts` | tabs.svelte.ts (I already touched it in Phase 0); types.ts (also Phase 0) |

`packages/core/src/credentials/claude.ts` — left alone. Its
`buildBillingHeaderValue` and `SYSTEM_IDENTITY` are pure helpers; agent.ts
still calls them.

`packages/core/src/db/*` — left alone. The DB stores `chunks` as JSON;
the only schema-relevant change (signature → metadata) is internal to
the chunk shape and persists transparently.

Individual tool implementations under `packages/core/src/tools/*.ts`
(except `registry.ts`) — left alone. They follow the
`ToolDefinition { name, description, parameters: ZodSchema, execute }`
interface, which is unchanged.

### Phase 2 — me, sequential

- Workspace-wide typecheck: `bun run --cwd packages/core typecheck` and
  `bun run --cwd packages/frontend typecheck` (which is `svelte-check`).
- Workspace-wide tests: `bun run --cwd packages/core test`,
  `bun run --cwd packages/api test`, `bun run --cwd packages/frontend test`.
- `bun run check` (biome).
- Fix any integration gaps that Phase 1 agents missed (e.g. type
  mismatches between agent.ts and provider.ts).

### Phase 3 — Gemini code review

Headless: `gemini --yolo --skip-trust -m gemini-3-pro-preview -p "$(cat
prompt)"`. Prompt restricts Gemini to read-only inspection and to writing
ONLY `report.md` at the project root.

### Phase 4 — me, sequential

Apply each fix Gemini flags. Re-run typecheck + tests + biome.

## Risks & mitigations

- **Sequential dependency between phases.** Phase 1 agents must wait for
  Phase 0 to land before they start, because they read the new
  `AgentEvent`/`Chunk` types. Mitigated by doing Phase 0 in-conversation.
- **Phase 1 agents writing diverging adapter code.** Mitigated by this
  spec locking down exact AgentEvent variants and exact tool-event
  mappings.
- **Frontend rendering regressions.** Mitigated by keeping the chunk
  shape stable — the only change for the frontend is `signature` →
  `metadata` (an internal detail the UI doesn't render anyway).
- **Subtle v6 streaming semantics we miss.** Mitigated by Gemini
  read-only review against opencode reference patterns.
