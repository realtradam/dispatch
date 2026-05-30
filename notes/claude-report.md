# Cache Miss Analysis for Dispatch's Claude Code Integration

## Executive Summary

The massive token burn and 0% cache hit rate observed after upgrading to AI SDK v6 are the result of two interacting flaws in how the Dispatch harness constructs requests for Anthropic:

1. **Missing Beta Header:** The Claude OAuth provider completely omits the required `anthropic-beta: prompt-caching-scope-2026-01-05` header. Without this specific beta header, the Anthropic API silently ignores all `cache_control` markers.
2. **Suboptimal Breakpoint Placement:** The logic that assigns `cache_control` breakpoints misinterprets the structure of AI SDK v6 messages. Because each tool result is serialized as an independent `role: "tool"` message, the caching logic places markers on the last two *individual tool results* rather than the actual conversational turns, wasting breakpoints and failing to cache the preceding `assistant` message.

The tool duplication incident (where tools were echoed 150+ times) is highly likely a symptom of the context window blowing up due to these cache misses, causing the model's generation loop to degenerate into repetitive tool hallucinations.

---

## Root Cause 1: The Missing Beta Header

### Analysis
Anthropic's prompt caching relies on explicit `cache_control` markers embedded in the request payload. However, for the Claude CLI ecosystem and OAuth flow, caching features are gated behind specific beta headers. 

In `packages/core/src/llm/provider.ts`, the `createClaudeOAuthProvider` factory initializes the AI SDK Anthropic provider. While it correctly mimics the `x-app` and `user-agent` headers of the Claude CLI, it **fails to include the `anthropic-beta` header**:

```typescript
function createClaudeOAuthProvider(config: ProviderConfig): ModelFactory {
    const anthropic = createAnthropic({
        // ...
        headers: {
            "anthropic-dangerous-direct-browser-access": "true",
            "x-app": "cli",
            "user-agent": "claude-cli/2.1.112 (external, sdk-cli)",
            // MISSING: "anthropic-beta": getAnthropicBetas().join(",")
        },
    });
}
```

The AI SDK's `createAnthropic` constructor (in `@ai-sdk/anthropic`) adds `anthropic-version: 2023-06-01` but does *not* automatically inject `prompt-caching-scope-2026-01-05`. 

Because this header is missing from the underlying fetch request, the Anthropic API treats the request as a standard (non-cached) `/messages` call and ignores the ephemeral cache breakpoints completely.

---

## Root Cause 2: Inefficient Caching Breakpoints

### Analysis
Even if the beta header were present, the current breakpoint strategy in `agent.ts` defeats the purpose of caching due to how the AI SDK v6 structures tool results.

In `toModelMessages()`, the agent unpacks an internal `tool-batch` chunk by creating a separate AI SDK message for every single tool result:
```typescript
for (const tr of trailingToolResults) {
    result.push({ role: "tool", content: [ { type: "tool-result", ... } ] });
}
```

Immediately after, `applyAnthropicCaching()` attempts to apply rolling cache markers:
```typescript
const nonSystem = msgs.filter((m) => m.role !== "system").slice(-2);
for (const m of nonSystem) targets.add(m);
// applies cacheControl: { type: "ephemeral" }
```

If the assistant emitted a batch of 10 tool calls, `msgs` ends with 10 individual `role: "tool"` messages. The `.slice(-2)` logic grabs only the 9th and 10th tool result messages and applies `cacheControl` to them.

When the AI SDK translates this to the Anthropic wire format (in `convert-to-anthropic-messages-prompt.ts`), it groups consecutive `tool` messages into a single `role: "user"` Anthropic block. The cache markers are applied strictly to the 9th and 10th tool result parts at the very end of this user block.

**Why this fails:**
1. **Wasted Breakpoints:** Anthropic requires at least 1,024 tokens between breakpoints to effectively cache the delta. Placing breakpoints on two consecutive tool results at the end of the chain wastes a breakpoint because the token delta between them is microscopic.
2. **Missing Assistant Context:** The `assistant` message (which contains the expensive reasoning tokens and the tool calls themselves) receives NO cache marker. 

### Comparison with `oh-my-pi`
The `oh-my-pi` reference implementation avoids this by applying cache controls logically across the wire format:
- `applyCacheControlToLastBlock(params.system)`
- `applyCacheControlToLastBlock(params.tools)`
- `penultimate user message`
- `last user message`

By targeting the end of distinct conversational phases (the system block, the tools definition, and the entire user response block), `oh-my-pi` maximizes the cached prefix length.

---

## Tool Duplication Incident Correlation

The documented incident describes 150+ duplicated `read_file` results for `package.json` with wildly uneven counts. 

This behavior is not indicative of the execution harness blindly retrying tools. In `agent.ts`, tool calls are harvested directly from the AI SDK stream (`event.type === "tool-call"`) and executed synchronously. If 150 identical `read_file` results were yielded, it is because **the LLM actively generated 150 identical `<tool_use>` blocks** in a single turn.

This generation loop is a known failure mode for Claude when the context window becomes excessively bloated or loses coherence (often compounded by a lack of cached prefixes breaking the model's structural attention). Fixing the cache miss will likely resolve the generation instability.

---

## Recommendations

Since this is a read-only analysis, no code has been edited. The following changes should be applied to fix the system:

1. **Inject the Beta Headers:**
   Modify `packages/core/src/llm/provider.ts` to import `getAnthropicBetas` from `../credentials/claude.js` and inject it into the Claude OAuth headers:
   ```typescript
   headers: {
       "anthropic-beta": getAnthropicBetas().join(","),
       "anthropic-dangerous-direct-browser-access": "true",
       // ...
   }
   ```

2. **Group Tool Results in `toModelMessages`:**
   Instead of pushing an individual `role: "tool"` message for every single tool result, group all `trailingToolResults` into a single `content` array inside one `role: "tool"` message. This accurately represents the tool-batch as a single turn.

3. **Revise the Breakpoint Strategy in `applyAnthropicCaching`:**
   Instead of naively grabbing the last two elements of the array, specifically target:
   - The first `system` message.
   - The **last** `assistant` message in the array.
   - The **last** `user` (or `tool`) message in the array.
   This ensures that the entire prefix leading up to the most recent reasoning step is successfully cached.

4. **Add a Tool Deduplication Safeguard (Optional but recommended):**
   In `agent.ts`'s execution loop, hash the tool name and arguments. If an identical tool call appears in the exact same `stepToolCalls` batch, automatically copy the result from the first execution rather than re-running it or blowing up the LLM's next prompt with redundant shell outputs.